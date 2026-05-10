// Standalone VET437 MCQ generator. No auth, no database. Reads PDFs from the
// course_materials/ folder at startup and serves a single-page quiz UI.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

const app = express();
const PORT = process.env.PORT || 3000;
const COURSE_DIR = path.join(__dirname, 'course_materials');

// Allow Canvas iframe embedding.
app.use((_req, res, next) => {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', 'frame-ancestors *');
  next();
});
app.use(express.json({ limit: '1mb' }));

// ---------- Document store ----------
const docs = []; // { filename, text }

async function loadCourseMaterials() {
  if (!fs.existsSync(COURSE_DIR)) {
    console.warn('course_materials/ directory does not exist; nothing to load.');
    return;
  }
  const files = fs
    .readdirSync(COURSE_DIR)
    .filter((f) => f.toLowerCase().endsWith('.pdf'))
    .sort();
  console.log(`Loading ${files.length} PDF(s) from course_materials/...`);
  for (const file of files) {
    try {
      const buf = await fs.promises.readFile(path.join(COURSE_DIR, file));
      const result = await pdfParse(buf);
      const text = (result.text || '').trim();
      if (text) {
        docs.push({ filename: file, text });
        console.log(`  Indexed ${file} (${text.length} chars)`);
      } else {
        console.warn(`  Skipped ${file}: no text extracted`);
      }
    } catch (e) {
      console.error(`  Error indexing ${file}: ${e.message}`);
    }
  }
  console.log(`Indexed ${docs.length} document(s).`);
}

// ---------- MCQ generation (cache + async tasks) ----------
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_POOL_SIZE = 5;
const TASK_TTL_MS = 10 * 60 * 1000;
const MAX_TEXT_CHARS = 80_000;
const CHUNK_SIZE = 1500;
const MODEL = 'claude-sonnet-4-6';
const INPUT_COST_PER_M = 3.0;
const OUTPUT_COST_PER_M = 15.0;

const cachePool = new Map();
const tasks = new Map();

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const quizHash = (q) => md5(JSON.stringify(q));
const cacheKey = (n, t) => `${n}|${(t || '').toLowerCase()}`;

function cacheGet(num, topic, exclude) {
  const key = cacheKey(num, topic);
  const now = Date.now();
  const fresh = (cachePool.get(key) || []).filter((e) => now - e.ts < CACHE_TTL_MS);
  cachePool.set(key, fresh);
  const unseen = fresh.filter((e) => !exclude.has(quizHash(e.questions)));
  if (!unseen.length) return null;
  const pick = unseen[Math.floor(Math.random() * unseen.length)];
  return { questions: pick.questions, cost: pick.cost };
}

function cachePut(num, topic, questions, cost) {
  const key = cacheKey(num, topic);
  const now = Date.now();
  const list = (cachePool.get(key) || []).filter((e) => now - e.ts < CACHE_TTL_MS);
  if (list.length >= CACHE_POOL_SIZE) {
    list.sort((a, b) => a.ts - b.ts);
    list.shift();
  }
  list.push({ questions, cost, ts: now });
  cachePool.set(key, list);
}

function purgeOldTasks() {
  const now = Date.now();
  for (const [id, t] of tasks) {
    if (t.completedAt && now - t.completedAt > TASK_TTL_MS) tasks.delete(id);
  }
}

const sanitize = (text) =>
  String(text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

function gatherCourseText() {
  if (!docs.length) return null;
  const budgetPerDoc = Math.max(Math.floor(MAX_TEXT_CHARS / docs.length), 1);
  const parts = [];
  for (const doc of docs) {
    if (doc.text.length <= budgetPerDoc) {
      parts.push(`--- ${doc.filename} ---\n${doc.text}`);
    } else {
      const chunks = [];
      for (let i = 0; i < doc.text.length; i += CHUNK_SIZE) {
        chunks.push(doc.text.slice(i, i + CHUNK_SIZE));
      }
      const numChunks = Math.max(Math.floor(budgetPerDoc / CHUNK_SIZE), 1);
      const shuffled = chunks.slice().sort(() => Math.random() - 0.5);
      const sampled = shuffled.slice(0, Math.min(numChunks, chunks.length));
      parts.push(
        `--- ${doc.filename} (sampled excerpts) ---\n${sampled.join('\n[...]\n')}`
      );
    }
  }
  return parts.join('\n\n');
}

function buildPrompt(text, num, focus) {
  const focusLine = focus ? `\nFocus the questions specifically on: ${focus}` : '';
  let truncated = sanitize(text);
  if (truncated.length > MAX_TEXT_CHARS)
    truncated = truncated.slice(0, MAX_TEXT_CHARS) + '\n\n[Content truncated...]';
  return `You are an expert veterinary science educator specializing in avian and reptile medicine. You are creating exam-style multiple choice questions (MCQs) for veterinary students in VET437.

Based on the following lecture/course material on avian and reptile medicine, generate exactly ${num} high-quality MCQs. All questions must be relevant to avian or reptile medicine.${focusLine}

Question type distribution (approximate):
- 25% Recall/knowledge questions: straightforward factual recall (e.g., anatomy, normal values, definitions)
- 50% Clinical scenario questions: present a patient case or clinical situation and ask for the best diagnosis, treatment, or next step
- 25% Comparative/species-differentiation questions: highlight differences between species (e.g., "Which species is the exception...", "How does X differ between birds and reptiles?")

Requirements for each question:
- Write a clear, specific question stem
- Provide exactly 4 answer options labeled A, B, C, D
- Exactly one option must be correct
- Include plausible distractors that test understanding, not just recall
- After the correct answer, provide a brief explanation (2-3 sentences) of WHY the correct answer is right and why key distractors are wrong
- Do NOT include questions about specific drug dosages, drug doses, or numerical blood/lab values

Return your response as a JSON array with this exact structure:
[
  {
    "question": "The question text",
    "options": {
      "A": "First option",
      "B": "Second option",
      "C": "Third option",
      "D": "Fourth option"
    },
    "correct_answer": "A",
    "explanation": "Explanation of why A is correct and why other options are incorrect."
  }
]

Return ONLY the JSON array, no other text.

--- COURSE MATERIAL ---
${truncated}
`;
}

async function callClaude(num, focus) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set on the server.');
  const text = gatherCourseText();
  if (!text)
    throw new Error('No PDFs are indexed. Add files under course_materials/ and redeploy.');

  const client = new Anthropic({ apiKey, timeout: 240_000 });
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    messages: [{ role: 'user', content: buildPrompt(text, num, focus) }],
  });

  let content = message.content[0].text.trim();
  const start = content.indexOf('[');
  const end = content.lastIndexOf(']');
  if (start !== -1 && end !== -1 && end > start) content = content.slice(start, end + 1);

  const questions = JSON.parse(content);
  const cost =
    (message.usage.input_tokens / 1_000_000) * INPUT_COST_PER_M +
    (message.usage.output_tokens / 1_000_000) * OUTPUT_COST_PER_M;
  return { questions, cost };
}

// ---------- Routes ----------
app.get('/api/info', (_req, res) => {
  res.json({
    docCount: docs.length,
    enabled: !!process.env.ANTHROPIC_API_KEY,
  });
});

app.post('/api/generate', (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res
      .status(500)
      .json({ error: 'MCQ generator not configured (ANTHROPIC_API_KEY missing).' });
  }
  if (!docs.length) {
    return res
      .status(400)
      .json({ error: 'No PDFs are indexed. Add files under course_materials/ and redeploy.' });
  }

  const numRaw = Number(req.body?.num_questions || 10);
  const num = Math.max(1, Math.min(15, Number.isFinite(numRaw) ? numRaw : 10));
  const focus = (req.body?.topic_focus || '').trim() || null;
  const seenList = Array.isArray(req.body?.seen) ? req.body.seen : [];
  const exclude = new Set(seenList);

  const cached = cacheGet(num, focus, exclude);
  if (cached) {
    return res.json({
      questions: cached.questions,
      cost: Number(cached.cost.toFixed(4)),
      cached: true,
      quiz_hash: quizHash(cached.questions),
    });
  }

  purgeOldTasks();
  const taskId = crypto.randomBytes(16).toString('hex');
  tasks.set(taskId, { status: 'pending' });

  callClaude(num, focus)
    .then(({ questions, cost }) => {
      cachePut(num, focus, questions, cost);
      tasks.set(taskId, {
        status: 'done',
        questions,
        cost: Number(cost.toFixed(4)),
        quizHash: quizHash(questions),
        completedAt: Date.now(),
      });
    })
    .catch((err) => {
      console.error('MCQ generation failed:', err);
      const msg =
        err.name === 'SyntaxError'
          ? 'Failed to parse generated questions. Please try again.'
          : err.message || 'Generation failed.';
      tasks.set(taskId, {
        status: 'error',
        error: msg,
        completedAt: Date.now(),
      });
    });

  res.json({ task_id: taskId });
});

app.get('/api/generate/status/:id', (req, res) => {
  const t = tasks.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Unknown task' });
  if (t.status === 'pending') return res.json({ status: 'pending' });
  if (t.status === 'error')
    return res.status(500).json({ status: 'error', error: t.error });
  res.json({
    status: 'done',
    questions: t.questions,
    cost: t.cost,
    quiz_hash: t.quizHash,
    cached: false,
  });
});

app.use(express.static(path.join(__dirname, 'public')));

(async () => {
  await loadCourseMaterials();
  app.listen(PORT, () => {
    console.log(`VET437 MCQ standalone on http://localhost:${PORT}`);
  });
})();
