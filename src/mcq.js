const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('./db');

const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_POOL_SIZE = 5;
const TASK_TTL_MS = 10 * 60 * 1000;
const MAX_TEXT_CHARS = 80_000;
const CHUNK_SIZE = 1500;
const MODEL = 'claude-sonnet-4-6';
// Claude Sonnet 4.6 pricing per million tokens.
const INPUT_COST_PER_M = 3.0;
const OUTPUT_COST_PER_M = 15.0;

const cachePool = new Map(); // key -> [{questions, cost, ts}]
const tasks = new Map(); // taskId -> {status, ...}

function quizHash(questions) {
  return crypto
    .createHash('md5')
    .update(JSON.stringify(questions))
    .digest('hex');
}

function cacheKey(num, topic) {
  return `${num}|${(topic || '').toLowerCase()}`;
}

function cacheGet(num, topic, excludeHashes) {
  const key = cacheKey(num, topic);
  const now = Date.now();
  const fresh = (cachePool.get(key) || []).filter(
    (e) => now - e.ts < CACHE_TTL_MS
  );
  cachePool.set(key, fresh);
  const unseen = fresh.filter((e) => !excludeHashes.has(quizHash(e.questions)));
  if (!unseen.length) return null;
  const pick = unseen[Math.floor(Math.random() * unseen.length)];
  return { questions: pick.questions, cost: pick.cost };
}

function cachePut(num, topic, questions, cost) {
  const key = cacheKey(num, topic);
  const now = Date.now();
  const list = (cachePool.get(key) || []).filter(
    (e) => now - e.ts < CACHE_TTL_MS
  );
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
    if (t.completedAt && now - t.completedAt > TASK_TTL_MS) {
      tasks.delete(id);
    }
  }
}

function sanitize(text) {
  return String(text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

function indexedDocCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM file_text').get().n;
}

function gatherCourseText() {
  const rows = db
    .prepare(
      `SELECT f.original_name AS filename, ft.text_content AS text
       FROM file_text ft
       JOIN files f ON f.id = ft.file_id
       WHERE f.kind = 'pdf'`
    )
    .all();
  if (!rows.length) return null;

  const budgetPerDoc = Math.max(Math.floor(MAX_TEXT_CHARS / rows.length), 1);
  const parts = [];
  for (const row of rows) {
    const text = row.text;
    if (text.length <= budgetPerDoc) {
      parts.push(`--- ${row.filename} ---\n${text}`);
    } else {
      const chunks = [];
      for (let i = 0; i < text.length; i += CHUNK_SIZE) {
        chunks.push(text.slice(i, i + CHUNK_SIZE));
      }
      const numChunks = Math.max(Math.floor(budgetPerDoc / CHUNK_SIZE), 1);
      const shuffled = chunks.slice().sort(() => Math.random() - 0.5);
      const sampled = shuffled.slice(0, Math.min(numChunks, chunks.length));
      parts.push(
        `--- ${row.filename} (sampled excerpts) ---\n${sampled.join('\n[...]\n')}`
      );
    }
  }
  return parts.join('\n\n');
}

function buildPrompt(text, numQuestions, topicFocus) {
  const focusInstruction = topicFocus
    ? `\nFocus the questions specifically on: ${topicFocus}`
    : '';
  let truncated = sanitize(text);
  if (truncated.length > MAX_TEXT_CHARS) {
    truncated = truncated.slice(0, MAX_TEXT_CHARS) + '\n\n[Content truncated...]';
  }
  return `You are an expert veterinary science educator specializing in avian and reptile medicine. You are creating exam-style multiple choice questions (MCQs) for veterinary students in VET437.

Based on the following lecture/course material on avian and reptile medicine, generate exactly ${numQuestions} high-quality MCQs. All questions must be relevant to avian or reptile medicine.${focusInstruction}

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

async function callClaude(numQuestions, topicFocus) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set on the server.');
  }
  const text = gatherCourseText();
  if (!text) {
    throw new Error(
      'No PDFs with extracted text are available yet. If files were just uploaded, try again in a moment.'
    );
  }

  const client = new Anthropic({ apiKey, timeout: 240_000 });
  const prompt = buildPrompt(text, numQuestions, topicFocus);

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });

  let content = message.content[0].text.trim();
  const start = content.indexOf('[');
  const end = content.lastIndexOf(']');
  if (start !== -1 && end !== -1 && end > start) {
    content = content.slice(start, end + 1);
  }

  const questions = JSON.parse(content);
  const cost =
    (message.usage.input_tokens / 1_000_000) * INPUT_COST_PER_M +
    (message.usage.output_tokens / 1_000_000) * OUTPUT_COST_PER_M;

  return { questions, cost };
}

function startGeneration(numQuestions, topicFocus, excludeHashes) {
  const cached = cacheGet(numQuestions, topicFocus, excludeHashes);
  if (cached) {
    return {
      kind: 'sync',
      questions: cached.questions,
      cost: cached.cost,
      cached: true,
      quizHash: quizHash(cached.questions),
    };
  }

  purgeOldTasks();
  const taskId = crypto.randomBytes(16).toString('hex');
  tasks.set(taskId, { status: 'pending' });

  callClaude(numQuestions, topicFocus)
    .then(({ questions, cost }) => {
      cachePut(numQuestions, topicFocus, questions, cost);
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

  return { kind: 'async', taskId };
}

function getTask(taskId) {
  return tasks.get(taskId);
}

module.exports = {
  startGeneration,
  getTask,
  quizHash,
  indexedDocCount,
};
