// Single-page quiz UI for the standalone VET437 MCQ generator.

const state = {
  info: null,
  phase: 'setup', // 'setup' | 'loading' | 'quiz' | 'results'
  questions: [],
  numQuestions: 10,
  topicFocus: '',
  cost: 0,
  cached: false,
  currentIndex: 0,
  answers: {},
  revealed: {},
  error: '',
  seen: JSON.parse(localStorage.getItem('mcqSeen') || '[]'),
};

const root = document.getElementById('app');

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      msg = (await res.json()).error || msg;
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

async function loadInfo() {
  try {
    state.info = await api('GET', '/api/info');
  } catch (e) {
    state.info = { docCount: 0, enabled: false };
  }
}

async function startGeneration() {
  state.phase = 'loading';
  state.error = '';
  state.questions = [];
  state.answers = {};
  state.revealed = {};
  state.currentIndex = 0;
  render();
  try {
    const r = await api('POST', '/api/generate', {
      num_questions: state.numQuestions,
      topic_focus: state.topicFocus || null,
      seen: state.seen,
    });
    if (r.questions) {
      state.questions = r.questions;
      state.cost = r.cost || 0;
      state.cached = !!r.cached;
      rememberSeen(r.quiz_hash);
      state.phase = 'quiz';
      render();
      return;
    }
    if (r.task_id) {
      await pollTask(r.task_id);
    } else {
      throw new Error('Unexpected response from server.');
    }
  } catch (e) {
    state.error = e.message;
    state.phase = 'setup';
    render();
  }
}

async function pollTask(taskId) {
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const resp = await api('GET', `/api/generate/status/${taskId}`).catch((e) => {
      throw e;
    });
    if (resp.status === 'pending') continue;
    if (resp.status === 'error') throw new Error(resp.error || 'Generation failed.');
    if (resp.status === 'done') {
      state.questions = resp.questions;
      state.cost = resp.cost || 0;
      state.cached = !!resp.cached;
      rememberSeen(resp.quiz_hash);
      state.phase = 'quiz';
      render();
      return;
    }
  }
  throw new Error('Generation timed out. Please try again.');
}

function rememberSeen(hash) {
  if (!hash) return;
  const set = new Set(state.seen);
  set.add(hash);
  state.seen = [...set].slice(-20);
  localStorage.setItem('mcqSeen', JSON.stringify(state.seen));
}

function selectOption(letter) {
  const i = state.currentIndex;
  state.answers[i] = letter;
  state.revealed[i] = true;
  render();
}
function nav(delta) {
  const next = state.currentIndex + delta;
  if (next < 0 || next >= state.questions.length) return;
  state.currentIndex = next;
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function showResults() {
  state.phase = 'results';
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function resetQuiz() {
  state.phase = 'setup';
  state.questions = [];
  state.answers = {};
  state.revealed = {};
  state.currentIndex = 0;
  state.error = '';
  render();
}

function downloadPdf() {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    alert('PDF library not loaded.');
    return;
  }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 15;
  const maxW = pageW - margin * 2;
  let y = 20;
  function cp(n) {
    if (y + n > pageH - 15) {
      doc.addPage();
      y = 20;
    }
  }

  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.text('VET437 MCQ Practice - Results', margin, y);
  y += 10;
  let correct = 0;
  state.questions.forEach((q, i) => {
    if (state.answers[i] === q.correct_answer) correct++;
  });
  doc.setFontSize(14);
  doc.setFont('helvetica', 'normal');
  doc.text(
    `Score: ${correct} / ${state.questions.length} (${Math.round(
      (correct / state.questions.length) * 100
    )}%)`,
    margin,
    y
  );
  y += 12;

  doc.setFontSize(11);
  state.questions.forEach((q, i) => {
    cp(50);
    doc.setFont('helvetica', 'bold');
    const qLines = doc.splitTextToSize(`${i + 1}. ${q.question}`, maxW);
    doc.text(qLines, margin, y);
    y += qLines.length * 5 + 2;
    doc.setFont('helvetica', 'normal');
    for (const [letter, text] of Object.entries(q.options)) {
      cp(8);
      let prefix = '  ';
      if (letter === q.correct_answer) prefix = '[correct] ';
      else if (
        letter === state.answers[i] &&
        state.answers[i] !== q.correct_answer
      )
        prefix = '[wrong] ';
      const optLines = doc.splitTextToSize(`${prefix}${letter}. ${text}`, maxW - 5);
      doc.text(optLines, margin + 3, y);
      y += optLines.length * 5;
    }
    y += 2;
    cp(12);
    const isCorrect = state.answers[i] === q.correct_answer;
    doc.setFont('helvetica', 'bold');
    if (!state.answers[i]) doc.text('Not answered', margin + 3, y);
    else if (!isCorrect)
      doc.text(
        `Your answer: ${state.answers[i]}. ${q.options[state.answers[i]]}`,
        margin + 3,
        y
      );
    if (!isCorrect) y += 6;
    doc.text(
      `Correct answer: ${q.correct_answer}. ${q.options[q.correct_answer]}`,
      margin + 3,
      y
    );
    y += 6;
    cp(15);
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(10);
    const expLines = doc.splitTextToSize(`Explanation: ${q.explanation}`, maxW - 5);
    doc.text(expLines, margin + 3, y);
    y += expLines.length * 4.5 + 8;
    doc.setFontSize(11);
  });
  doc.save('VET437_quiz_results.pdf');
}

function renderSetup() {
  const { docCount = 0, enabled = false } = state.info || {};
  return `
    <div class="card">
      <h2>Generate Practice Questions</h2>
      <p class="muted">Questions are generated by Claude from PDFs in the course materials folder.</p>
      ${
        !enabled
          ? '<div class="warning">The MCQ generator is not configured (ANTHROPIC_API_KEY missing on the server).</div>'
          : docCount === 0
            ? '<div class="warning">No PDFs are indexed. Add files under <code>course_materials/</code> in the repo and redeploy.</div>'
            : `<p class="muted">Source: <strong>${docCount}</strong> indexed PDF${docCount === 1 ? '' : 's'}.</p>`
      }
      ${state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ''}
      <form id="setup-form">
        <div class="form-grid">
          <label>
            <span>Number of questions</span>
            <select name="num_questions">
              <option value="5" ${state.numQuestions === 5 ? 'selected' : ''}>5 questions</option>
              <option value="10" ${state.numQuestions === 10 ? 'selected' : ''}>10 questions</option>
              <option value="15" ${state.numQuestions === 15 ? 'selected' : ''}>15 questions</option>
            </select>
          </label>
          <label>
            <span>Topic focus (optional)</span>
            <input type="text" name="topic_focus" value="${escapeHtml(state.topicFocus)}"
                   placeholder="e.g., reptile anesthesia, avian respiratory disease..." />
          </label>
        </div>
        <div class="actions">
          <button class="primary" type="submit" ${!enabled || docCount === 0 ? 'disabled' : ''}>
            Generate Questions
          </button>
        </div>
      </form>
    </div>
  `;
}

function renderLoading() {
  return `
    <div class="card loading">
      <div class="spinner"></div>
      <p>Generating questions from your course materials...</p>
      <p class="muted">This may take 1&ndash;2 minutes.</p>
    </div>
  `;
}

function renderQuiz() {
  const i = state.currentIndex;
  const q = state.questions[i];
  if (!q) return renderSetup();
  const isRevealed = !!state.revealed[i];
  const userAns = state.answers[i];
  const total = state.questions.length;
  const pct = ((i + 1) / total) * 100;
  const isLast = i === total - 1;

  const optHtml = Object.entries(q.options)
    .map(([letter, text]) => {
      let cls = 'option';
      if (isRevealed) {
        cls += ' disabled';
        if (letter === q.correct_answer) cls += ' correct';
        else if (letter === userAns) cls += ' incorrect';
      } else if (userAns === letter) cls += ' selected';
      const action = isRevealed ? '' : `data-action="pick" data-letter="${letter}"`;
      return `
        <button class="${cls}" ${action}>
          <span class="opt-letter">${letter}</span>
          <span class="opt-text">${escapeHtml(text)}</span>
        </button>
      `;
    })
    .join('');

  return `
    <div class="disclaimer">AI-generated questions may be inaccurate. If unsure about an answer, email
      <a href="mailto:hbeaufrere@ucdavis.edu">hbeaufrere@ucdavis.edu</a>.</div>
    <div class="progress-meta">Question ${i + 1} of ${total}</div>
    <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
    <div class="card">
      <div class="muted" style="font-size:12px;text-transform:uppercase;letter-spacing:0.6px;">Question ${i + 1}</div>
      <p class="stem">${escapeHtml(q.question)}</p>
      <div class="options">${optHtml}</div>
      ${isRevealed ? `<div class="explanation"><strong>Explanation:</strong> ${escapeHtml(q.explanation)}</div>` : ''}
      <div class="nav">
        <button data-action="prev" ${i === 0 ? 'disabled' : ''}>Previous</button>
        ${
          isLast
            ? `<button class="primary" data-action="finish">Finish quiz</button>`
            : `<button class="primary" data-action="next" ${isRevealed ? '' : 'disabled'}>Next</button>`
        }
      </div>
    </div>
  `;
}

function renderResults() {
  const total = state.questions.length;
  let correct = 0;
  state.questions.forEach((q, i) => {
    if (state.answers[i] === q.correct_answer) correct++;
  });
  const pct = Math.round((correct / total) * 100);
  const review = state.questions
    .map((q, i) => {
      const isCorrect = state.answers[i] === q.correct_answer;
      const userAns = state.answers[i];
      const userLine = userAns
        ? isCorrect
          ? ''
          : `<div class="review-line your">Your answer: ${userAns}. ${escapeHtml(q.options[userAns])}</div>`
        : `<div class="review-line your">Not answered</div>`;
      return `
        <div class="review-item ${isCorrect ? 'ok' : 'bad'}">
          <div class="review-q"><strong>${i + 1}.</strong> ${escapeHtml(q.question)}</div>
          ${userLine}
          <div class="review-line correct">Correct: ${q.correct_answer}. ${escapeHtml(q.options[q.correct_answer])}</div>
          <div class="review-exp">${escapeHtml(q.explanation)}</div>
        </div>
      `;
    })
    .join('');
  return `
    <div class="card score-card">
      <h2>Quiz results</h2>
      <div class="score-circle">${correct}/${total}</div>
      <div class="score-pct">${pct}%</div>
    </div>
    <h3 style="margin:18px 0 10px;font-size:15px;">Review</h3>
    ${review}
    <div class="actions">
      <button data-action="download">Download PDF</button>
      <button class="primary" data-action="reset">Generate new quiz</button>
    </div>
  `;
}

function render() {
  switch (state.phase) {
    case 'loading':
      root.innerHTML = renderLoading();
      break;
    case 'quiz':
      root.innerHTML = renderQuiz();
      break;
    case 'results':
      root.innerHTML = renderResults();
      break;
    case 'setup':
    default:
      root.innerHTML = renderSetup();
      break;
  }
  const form = document.getElementById('setup-form');
  if (form)
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      state.numQuestions = Number(fd.get('num_questions'));
      state.topicFocus = (fd.get('topic_focus') || '').toString().trim();
      startGeneration();
    });
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  const action = t.dataset.action;
  switch (action) {
    case 'pick':
      selectOption(t.dataset.letter);
      break;
    case 'prev':
      nav(-1);
      break;
    case 'next':
      nav(1);
      break;
    case 'finish':
      showResults();
      break;
    case 'reset':
      resetQuiz();
      break;
    case 'download':
      downloadPdf();
      break;
  }
});

(async () => {
  await loadInfo();
  render();
})();
