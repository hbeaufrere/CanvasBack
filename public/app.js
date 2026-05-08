// Tiny vanilla-JS frontend. No framework, just a state object and a render() function.

const state = {
  user: null,
  view: 'files', // 'files' | 'announcements' | 'mcq'
  folders: [],
  selectedFolderId: null,
  expanded: new Set(),
  files: [],
  announcements: [],
  viewer: null, // { id, name }
  loginError: '',
  toast: '',
  mcq: {
    info: null, // { docCount, enabled }
    phase: 'setup', // 'setup' | 'loading' | 'quiz' | 'results'
    numQuestions: 10,
    topicFocus: '',
    questions: [],
    currentIndex: 0,
    answers: {}, // { idx: 'A' }
    revealed: {}, // { idx: true }
    cost: 0,
    cached: false,
    error: '',
  },
};

const root = document.getElementById('app');

// ---------- API helpers ----------
async function api(method, url, body, isForm = false) {
  const opts = { method, headers: {} };
  if (body && !isForm) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (body && isForm) {
    opts.body = body;
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      msg = j.error || msg;
    } catch {}
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

function showToast(msg) {
  state.toast = msg;
  render();
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    state.toast = '';
    render();
  }, 2200);
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s.replace(' ', 'T') + 'Z');
  return d.toLocaleString();
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ---------- Bootstrap ----------
async function bootstrap() {
  try {
    const me = await api('GET', '/api/me');
    state.user = me.user;
  } catch {}
  if (state.user) await refreshAll();
  render();
}

async function refreshAll() {
  const [foldersRes, annRes] = await Promise.all([
    api('GET', '/api/folders'),
    api('GET', '/api/announcements'),
  ]);
  state.folders = foldersRes.folders;
  state.announcements = annRes.announcements;
  if (state.selectedFolderId) await loadFiles(state.selectedFolderId);
}

async function loadFiles(folderId) {
  const r = await api('GET', `/api/folders/${folderId}/files`);
  state.files = r.files;
}

// ---------- Login ----------
async function doLogin(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  state.loginError = '';
  try {
    const r = await api('POST', '/api/login', {
      password: fd.get('password'),
    });
    state.user = r.user;
    await refreshAll();
  } catch (err) {
    state.loginError = err.message;
  }
  render();
}

async function doLogout() {
  await api('POST', '/api/logout');
  state.user = null;
  state.folders = [];
  state.files = [];
  state.announcements = [];
  state.selectedFolderId = null;
  render();
}

// ---------- Folder actions ----------
async function createFolder(parentId) {
  const name = prompt(parentId ? 'Subfolder name:' : 'New folder name:');
  if (!name?.trim()) return;
  try {
    await api('POST', '/api/folders', { name: name.trim(), parentId });
    await refreshAll();
    if (parentId != null) state.expanded.add(parentId);
    render();
  } catch (e) {
    showToast(e.message);
  }
}

async function deleteFolder(id, name) {
  if (!confirm(`Delete folder "${name}" and all its contents?`)) return;
  try {
    await api('DELETE', `/api/folders/${id}`);
    if (state.selectedFolderId === id) {
      state.selectedFolderId = null;
      state.files = [];
    }
    await refreshAll();
    render();
  } catch (e) {
    showToast(e.message);
  }
}

async function renameFolder(id, currentName) {
  const next = prompt('Rename folder:', currentName);
  if (next == null) return;
  if (!next.trim() || next.trim() === currentName) return;
  try {
    await api('PATCH', `/api/folders/${id}`, { name: next.trim() });
    await refreshAll();
    render();
  } catch (e) {
    showToast(e.message);
  }
}

async function selectFolder(id) {
  state.selectedFolderId = id;
  try {
    await loadFiles(id);
  } catch (e) {
    showToast(e.message);
  }
  render();
}

function toggleExpand(id) {
  if (state.expanded.has(id)) state.expanded.delete(id);
  else state.expanded.add(id);
  render();
}

// ---------- File actions ----------
async function uploadFromInput(folderId, fileInput) {
  if (!fileInput.files?.length) return;
  await uploadFiles(folderId, fileInput.files);
  fileInput.value = '';
}

async function addLink(folderId) {
  const url = prompt('URL (must start with http:// or https://):');
  if (url == null) return;
  if (!url.trim()) return;
  const displayName = prompt('Title to display for this link:', '');
  if (displayName == null) return;
  if (!displayName.trim()) return;
  try {
    await api('POST', `/api/folders/${folderId}/links`, {
      url: url.trim(),
      displayName: displayName.trim(),
    });
    showToast('Link added');
    await loadFiles(folderId);
    render();
  } catch (e) {
    showToast(e.message);
  }
}

async function deleteFile(id, name) {
  if (!confirm(`Delete "${name}"?`)) return;
  try {
    await api('DELETE', `/api/files/${id}`);
    await loadFiles(state.selectedFolderId);
    render();
  } catch (e) {
    showToast(e.message);
  }
}

async function renameFile(id, currentDisplay, originalName) {
  const next = prompt(
    `Rename file (leave blank to reset to original "${originalName}"):`,
    currentDisplay
  );
  if (next == null) return;
  try {
    await api('PATCH', `/api/files/${id}`, { displayName: next.trim() || null });
    await loadFiles(state.selectedFolderId);
    render();
  } catch (e) {
    showToast(e.message);
  }
}

async function moveFile(id, direction) {
  try {
    await api('POST', `/api/files/${id}/move`, { direction });
    await loadFiles(state.selectedFolderId);
    render();
  } catch (e) {
    showToast(e.message);
  }
}

async function uploadFiles(folderId, fileList) {
  const pdfs = [...fileList].filter(
    (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name)
  );
  if (!pdfs.length) {
    showToast('Only PDF files are accepted.');
    return;
  }
  for (const file of pdfs) {
    const fd = new FormData();
    fd.append('file', file);
    try {
      await api('POST', `/api/folders/${folderId}/files`, fd, true);
    } catch (e) {
      showToast(`${file.name}: ${e.message}`);
    }
  }
  showToast(pdfs.length === 1 ? 'File uploaded' : `${pdfs.length} files uploaded`);
  await loadFiles(folderId);
  render();
}

function viewFile(file) {
  state.viewer = { id: file.id, name: file.original_name, mime: file.mime_type };
  render();
}

function closeViewer() {
  state.viewer = null;
  render();
}

// ---------- Announcements ----------
async function postAnnouncement(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api('POST', '/api/announcements', {
      title: fd.get('title'),
      body: fd.get('body'),
    });
    e.target.reset();
    const r = await api('GET', '/api/announcements');
    state.announcements = r.announcements;
    showToast('Announcement posted');
    render();
  } catch (err) {
    showToast(err.message);
  }
}

async function deleteAnnouncement(id) {
  if (!confirm('Delete this announcement?')) return;
  try {
    await api('DELETE', `/api/announcements/${id}`);
    state.announcements = state.announcements.filter((a) => a.id !== id);
    render();
  } catch (e) {
    showToast(e.message);
  }
}

// ---------- Rendering ----------
function buildFolderTree(folders) {
  // Server already sorts by display_order; preserve that order while grouping.
  const byParent = new Map();
  for (const f of folders) {
    const k = f.parent_id ?? 'root';
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(f);
  }
  return byParent;
}

function renderFolderTree() {
  const isInstructor = state.user?.role === 'instructor';
  const byParent = buildFolderTree(state.folders);

  function renderNode(node, depth = 0) {
    const children = byParent.get(node.id) || [];
    const isExpanded = state.expanded.has(node.id);
    const hasChildren = children.length > 0;
    const isActive = state.selectedFolderId === node.id;
    const draggable = isInstructor ? 'true' : 'false';
    const topClass = depth === 0 ? ' top-level' : '';
    return `
      <li>
        <div class="row${topClass} ${isActive ? 'active' : ''}"
             data-id="${node.id}"
             data-drag-id="${node.id}"
             draggable="${draggable}">
          <span class="caret" data-action="toggle" data-id="${node.id}">
            ${hasChildren ? (isExpanded ? '▾' : '▸') : '·'}
          </span>
          <span class="name" data-action="select" data-id="${node.id}">${escapeHtml(node.name)}</span>
          ${
            isInstructor
              ? `<span class="actions">
                  <button data-action="newSub" data-id="${node.id}" title="New subfolder">+</button>
                  <button data-action="renameFolder" data-id="${node.id}" data-name="${escapeHtml(node.name)}" title="Rename">✎</button>
                  <button class="danger" data-action="delFolder" data-id="${node.id}" data-name="${escapeHtml(node.name)}" title="Delete">×</button>
                </span>`
              : ''
          }
        </div>
        ${
          isExpanded && hasChildren
            ? `<ul>${children.map((c) => renderNode(c, depth + 1)).join('')}</ul>`
            : ''
        }
      </li>
    `;
  }

  const roots = byParent.get('root') || [];
  return `
    <a class="learn-more" href="https://www.allaboutbirds.org/guide/Canvasback/overview" target="_blank" rel="noopener noreferrer">
      <span class="learn-more-icon">i</span>
      <span>Learn more about Canvasback</span>
      <span class="learn-more-arrow">&rarr;</span>
    </a>
    <h3>Folders</h3>
    ${
      isInstructor
        ? `<div class="new-folder">
            <button class="primary" data-action="newRoot">+ New folder</button>
          </div>`
        : ''
    }
    <ul class="tree">
      ${
        roots.length
          ? roots.map((r) => renderNode(r, 0)).join('')
          : '<li style="color:var(--muted);padding:6px;">No folders yet.</li>'
      }
    </ul>
  `;
}

function findFolder(id) {
  return state.folders.find((f) => f.id === id);
}
function folderPath(id) {
  const out = [];
  let cur = findFolder(id);
  while (cur) {
    out.unshift(cur);
    cur = cur.parent_id ? findFolder(cur.parent_id) : null;
  }
  return out;
}

function renderContentFiles() {
  const isInstructor = state.user?.role === 'instructor';
  const folder = state.selectedFolderId ? findFolder(state.selectedFolderId) : null;

  if (!folder) {
    return `
      <div class="empty">
        <p>Select a folder on the left to view its files.</p>
        ${
          isInstructor && !state.folders.length
            ? '<p>Tip: create your first folder to get started.</p>'
            : ''
        }
      </div>
    `;
  }
  const crumbs = folderPath(folder.id)
    .map((f) => `<span>${escapeHtml(f.name)}</span>`)
    .join('');

  return `
    <div class="crumbs">${crumbs}</div>
    <h2 class="section-title">${escapeHtml(folder.name)}</h2>
    <div class="toolbar">
      ${
        isInstructor
          ? `<label class="primary upload-label">
              Upload PDF(s)
              <input id="upload-input" type="file" accept="application/pdf,.pdf" multiple style="display:none" />
            </label>
            <button data-action="addLink" data-id="${folder.id}">+ Add link</button>
            <button data-action="newSub" data-id="${folder.id}">+ New subfolder</button>
            <button data-action="renameFolder" data-id="${folder.id}" data-name="${escapeHtml(folder.name)}">Rename folder</button>`
          : ''
      }
    </div>
    <div class="drop-zone ${isInstructor ? 'enabled' : ''}" id="drop-zone">
      ${
        isInstructor
          ? '<div class="drop-hint">Drag &amp; drop PDF files here to upload</div>'
          : ''
      }
      ${
        state.files.length
          ? `<div class="file-list">
              <div class="row head">
                <div>Name</div>
                <div class="meta-col">Size</div>
                <div class="meta-col">Uploaded</div>
                <div></div>
              </div>
              ${state.files
                .map((f, idx) => {
                  const isUrl = f.kind === 'url';
                  const title = f.display_name || f.original_name;
                  const isFirst = idx === 0;
                  const isLast = idx === state.files.length - 1;
                  const tooltip = isUrl ? f.url : title;
                  const iconHtml = isUrl
                    ? '<span class="icon icon-url" title="Link">URL</span>'
                    : '<span class="icon">PDF</span>';
                  const openButtons = isUrl
                    ? `<a href="${escapeHtml(f.url)}" target="_blank" rel="noopener noreferrer"><button>Open</button></a>`
                    : `<button data-action="view" data-id="${f.id}">View</button>
                       <a href="/api/files/${f.id}/download"><button>Download</button></a>`;
                  const titleAnchor = isUrl
                    ? `<a href="${escapeHtml(f.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(tooltip)}">${escapeHtml(title)}</a>`
                    : `<a href="#" data-action="view" data-id="${f.id}" title="${escapeHtml(tooltip)}">${escapeHtml(title)}</a>`;
                  return `
                <div class="row">
                  <div class="name">
                    ${iconHtml}
                    ${titleAnchor}
                  </div>
                  <div class="meta meta-col">${isUrl ? '&mdash;' : fmtBytes(f.size_bytes)}</div>
                  <div class="meta meta-col">${fmtDate(f.uploaded_at)}</div>
                  <div class="actions">
                    ${
                      isInstructor
                        ? `<button class="iconbtn" data-action="moveUp" data-id="${f.id}" title="Move up" ${isFirst ? 'disabled' : ''}>&#9650;</button>
                           <button class="iconbtn" data-action="moveDown" data-id="${f.id}" title="Move down" ${isLast ? 'disabled' : ''}>&#9660;</button>`
                        : ''
                    }
                    ${openButtons}
                    ${
                      isInstructor
                        ? `<button data-action="renameFile" data-id="${f.id}" data-display="${escapeHtml(f.display_name || '')}" data-orig="${escapeHtml(f.original_name)}">Rename</button>
                           <button class="danger" data-action="delFile" data-id="${f.id}" data-name="${escapeHtml(title)}">Delete</button>`
                        : ''
                    }
                  </div>
                </div>
              `;
                })
                .join('')}
            </div>`
          : '<div class="empty">No files in this folder yet.</div>'
      }
    </div>
  `;
}

function renderAnnouncements() {
  const isInstructor = state.user?.role === 'instructor';
  return `
    <h2>Announcements</h2>
    ${
      isInstructor
        ? `<form class="compose" id="ann-form">
            <label>Title</label>
            <input type="text" name="title" required maxlength="160" />
            <label>Message</label>
            <textarea name="body" required></textarea>
            <div class="actions">
              <button class="primary" type="submit">Post announcement</button>
            </div>
          </form>`
        : ''
    }
    ${
      state.announcements.length
        ? `<div class="announcements">
            ${state.announcements
              .map(
                (a) => `
              <div class="announcement">
                <h3>${escapeHtml(a.title)}</h3>
                <div class="meta">${escapeHtml(a.author_name || 'Unknown')} · ${fmtDate(a.created_at)}</div>
                <div class="body">${escapeHtml(a.body)}</div>
                ${
                  isInstructor
                    ? `<div class="row-actions"><button class="danger" data-action="delAnn" data-id="${a.id}">Delete</button></div>`
                    : ''
                }
              </div>
            `
              )
              .join('')}
          </div>`
        : '<div class="empty">No announcements yet.</div>'
    }
  `;
}

// ---------- MCQ Practice ----------
async function loadMcqInfo() {
  try {
    state.mcq.info = await api('GET', '/api/mcq/info');
  } catch (e) {
    state.mcq.info = { docCount: 0, enabled: false };
  }
}

async function startMcqGeneration() {
  state.mcq.phase = 'loading';
  state.mcq.error = '';
  state.mcq.questions = [];
  state.mcq.answers = {};
  state.mcq.revealed = {};
  state.mcq.currentIndex = 0;
  render();
  try {
    const r = await api('POST', '/api/mcq/generate', {
      num_questions: state.mcq.numQuestions,
      topic_focus: state.mcq.topicFocus || null,
    });
    if (r.questions) {
      state.mcq.questions = r.questions;
      state.mcq.cost = r.cost || 0;
      state.mcq.cached = !!r.cached;
      state.mcq.phase = 'quiz';
      render();
      return;
    }
    if (r.task_id) {
      await pollMcqTask(r.task_id);
    } else {
      throw new Error('Unexpected response from server.');
    }
  } catch (err) {
    state.mcq.error = err.message;
    state.mcq.phase = 'setup';
    render();
  }
}

async function pollMcqTask(taskId) {
  // Poll for up to ~4 minutes (every 2s).
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    let resp;
    try {
      resp = await api('GET', `/api/mcq/status/${taskId}`);
    } catch (e) {
      throw e;
    }
    if (resp.status === 'pending') continue;
    if (resp.status === 'error') throw new Error(resp.error || 'Generation failed.');
    if (resp.status === 'done') {
      state.mcq.questions = resp.questions;
      state.mcq.cost = resp.cost || 0;
      state.mcq.cached = !!resp.cached;
      state.mcq.phase = 'quiz';
      render();
      return;
    }
  }
  throw new Error('Generation timed out. Please try again.');
}

function selectMcqOption(letter) {
  const idx = state.mcq.currentIndex;
  state.mcq.answers[idx] = letter;
  state.mcq.revealed[idx] = true;
  render();
}

function navMcq(delta) {
  const next = state.mcq.currentIndex + delta;
  if (next < 0 || next >= state.mcq.questions.length) return;
  state.mcq.currentIndex = next;
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showMcqResults() {
  state.mcq.phase = 'results';
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetMcq() {
  state.mcq.phase = 'setup';
  state.mcq.questions = [];
  state.mcq.answers = {};
  state.mcq.revealed = {};
  state.mcq.currentIndex = 0;
  state.mcq.error = '';
  render();
}

function downloadMcqPdf() {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    showToast('PDF library failed to load.');
    return;
  }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 15;
  const maxW = pageW - margin * 2;
  let y = 20;

  function checkPage(needed) {
    if (y + needed > pageH - 15) {
      doc.addPage();
      y = 20;
    }
  }

  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.text('VET437 MCQ Practice - Results', margin, y);
  y += 10;

  let correct = 0;
  state.mcq.questions.forEach((q, i) => {
    if (state.mcq.answers[i] === q.correct_answer) correct++;
  });
  doc.setFontSize(14);
  doc.setFont('helvetica', 'normal');
  doc.text(
    `Score: ${correct} / ${state.mcq.questions.length} (${Math.round(
      (correct / state.mcq.questions.length) * 100
    )}%)`,
    margin,
    y
  );
  y += 12;

  doc.setFontSize(11);
  state.mcq.questions.forEach((q, i) => {
    checkPage(50);
    doc.setFont('helvetica', 'bold');
    const qLines = doc.splitTextToSize(`${i + 1}. ${q.question}`, maxW);
    doc.text(qLines, margin, y);
    y += qLines.length * 5 + 2;

    doc.setFont('helvetica', 'normal');
    for (const [letter, text] of Object.entries(q.options)) {
      checkPage(8);
      let prefix = '  ';
      if (letter === q.correct_answer) prefix = '[correct] ';
      else if (
        letter === state.mcq.answers[i] &&
        state.mcq.answers[i] !== q.correct_answer
      )
        prefix = '[wrong] ';
      const optLines = doc.splitTextToSize(`${prefix}${letter}. ${text}`, maxW - 5);
      doc.text(optLines, margin + 3, y);
      y += optLines.length * 5;
    }
    y += 2;

    checkPage(12);
    const isCorrect = state.mcq.answers[i] === q.correct_answer;
    doc.setFont('helvetica', 'bold');
    if (!state.mcq.answers[i]) {
      doc.text('Not answered', margin + 3, y);
    } else if (!isCorrect) {
      doc.text(
        `Your answer: ${state.mcq.answers[i]}. ${q.options[state.mcq.answers[i]]}`,
        margin + 3,
        y
      );
    }
    if (!isCorrect) y += 6;
    doc.text(
      `Correct answer: ${q.correct_answer}. ${q.options[q.correct_answer]}`,
      margin + 3,
      y
    );
    y += 6;

    checkPage(15);
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(10);
    const expLines = doc.splitTextToSize(`Explanation: ${q.explanation}`, maxW - 5);
    doc.text(expLines, margin + 3, y);
    y += expLines.length * 4.5 + 8;
    doc.setFontSize(11);
  });

  doc.save('VET437_quiz_results.pdf');
}

function renderMcqSetup() {
  const info = state.mcq.info;
  const docCount = info ? info.docCount : 0;
  const enabled = info ? info.enabled : true;
  return `
    <div class="mcq-card">
      <h2>Generate Practice Questions</h2>
      <p class="muted">Questions are generated from PDFs uploaded in Course files using Claude.</p>
      ${
        !enabled
          ? '<div class="mcq-warning">The MCQ generator is not configured (ANTHROPIC_API_KEY missing on the server).</div>'
          : docCount === 0
            ? '<div class="mcq-warning">No PDFs with extracted text yet. Upload some PDFs in Course files first.</div>'
            : `<p class="muted">Source: <strong>${docCount}</strong> indexed PDF${docCount === 1 ? '' : 's'}.</p>`
      }
      ${
        state.mcq.error
          ? `<div class="mcq-error">${escapeHtml(state.mcq.error)}</div>`
          : ''
      }
      <form id="mcq-setup-form">
        <div class="mcq-grid">
          <label>
            <span>Number of questions</span>
            <select name="num_questions">
              <option value="5" ${state.mcq.numQuestions === 5 ? 'selected' : ''}>5 questions</option>
              <option value="10" ${state.mcq.numQuestions === 10 ? 'selected' : ''}>10 questions</option>
              <option value="15" ${state.mcq.numQuestions === 15 ? 'selected' : ''}>15 questions</option>
            </select>
          </label>
          <label>
            <span>Topic focus (optional)</span>
            <input type="text" name="topic_focus" value="${escapeHtml(state.mcq.topicFocus)}"
                   placeholder="e.g., reptile anesthesia, avian respiratory disease..." />
          </label>
        </div>
        <div class="mcq-actions">
          <button class="primary" type="submit" ${!enabled || docCount === 0 ? 'disabled' : ''}>
            Generate Questions
          </button>
        </div>
      </form>
    </div>
  `;
}

function renderMcqLoading() {
  return `
    <div class="mcq-card mcq-loading">
      <div class="spinner"></div>
      <p>Generating questions from your course materials...</p>
      <p class="muted">This may take 1–2 minutes. Please be patient.</p>
    </div>
  `;
}

function renderMcqQuiz() {
  const i = state.mcq.currentIndex;
  const q = state.mcq.questions[i];
  if (!q) return renderMcqSetup();
  const isRevealed = !!state.mcq.revealed[i];
  const userAns = state.mcq.answers[i];
  const total = state.mcq.questions.length;
  const pct = ((i + 1) / total) * 100;
  const isLast = i === total - 1;

  const optionHtml = Object.entries(q.options)
    .map(([letter, text]) => {
      let cls = 'mcq-option';
      if (isRevealed) {
        cls += ' disabled';
        if (letter === q.correct_answer) cls += ' correct';
        else if (letter === userAns) cls += ' incorrect';
      } else if (userAns === letter) {
        cls += ' selected';
      }
      const action = isRevealed ? '' : `data-action="mcqPick" data-letter="${letter}"`;
      return `
        <button class="${cls}" ${action}>
          <span class="mcq-letter">${letter}</span>
          <span class="mcq-text">${escapeHtml(text)}</span>
        </button>
      `;
    })
    .join('');

  return `
    <div class="mcq-disclaimer">AI-generated questions may be inaccurate. If unsure about an answer, email
      <a href="mailto:hbeaufrere@ucdavis.edu">hbeaufrere@ucdavis.edu</a>.</div>
    <div class="mcq-progress-wrap">
      <div class="mcq-progress-meta">Question ${i + 1} of ${total}</div>
      <div class="mcq-progress-bar"><div class="mcq-progress-fill" style="width:${pct}%"></div></div>
    </div>
    <div class="mcq-card mcq-question">
      <div class="muted" style="font-size:12px;text-transform:uppercase;letter-spacing:0.6px;">Question ${i + 1}</div>
      <p class="mcq-stem">${escapeHtml(q.question)}</p>
      <div class="mcq-options">${optionHtml}</div>
      ${
        isRevealed
          ? `<div class="mcq-explanation"><strong>Explanation:</strong> ${escapeHtml(q.explanation)}</div>`
          : ''
      }
      <div class="mcq-nav">
        <button data-action="mcqPrev" ${i === 0 ? 'disabled' : ''}>Previous</button>
        ${
          isLast
            ? `<button class="primary" data-action="mcqFinish">Finish quiz</button>`
            : `<button class="primary" data-action="mcqNext" ${isRevealed ? '' : 'disabled'}>Next</button>`
        }
      </div>
    </div>
  `;
}

function renderMcqResults() {
  const total = state.mcq.questions.length;
  let correct = 0;
  state.mcq.questions.forEach((q, i) => {
    if (state.mcq.answers[i] === q.correct_answer) correct++;
  });
  const pct = Math.round((correct / total) * 100);
  const reviewHtml = state.mcq.questions
    .map((q, i) => {
      const isCorrect = state.mcq.answers[i] === q.correct_answer;
      const userAns = state.mcq.answers[i];
      const userLine = userAns
        ? isCorrect
          ? ''
          : `<div class="mcq-review-line your">Your answer: ${userAns}. ${escapeHtml(q.options[userAns])}</div>`
        : `<div class="mcq-review-line your">Not answered</div>`;
      return `
        <div class="mcq-review-item ${isCorrect ? 'ok' : 'bad'}">
          <div class="mcq-review-q"><strong>${i + 1}.</strong> ${escapeHtml(q.question)}</div>
          ${userLine}
          <div class="mcq-review-line correct">Correct: ${q.correct_answer}. ${escapeHtml(q.options[q.correct_answer])}</div>
          <div class="mcq-review-exp">${escapeHtml(q.explanation)}</div>
        </div>
      `;
    })
    .join('');
  return `
    <div class="mcq-card mcq-score">
      <h2>Quiz results</h2>
      <div class="mcq-score-circle"><span>${correct}</span>/<span>${total}</span></div>
      <div class="mcq-score-pct">${pct}%</div>
    </div>
    <div class="mcq-review">
      <h3>Review</h3>
      ${reviewHtml}
    </div>
    <div class="mcq-actions">
      <button data-action="mcqDownload">Download PDF</button>
      <button class="primary" data-action="mcqReset">Generate new quiz</button>
    </div>
  `;
}

function renderMcq() {
  switch (state.mcq.phase) {
    case 'loading':
      return renderMcqLoading();
    case 'quiz':
      return renderMcqQuiz();
    case 'results':
      return renderMcqResults();
    case 'setup':
    default:
      return renderMcqSetup();
  }
}

function renderViewer() {
  if (!state.viewer) return '';
  const v = state.viewer;
  return `
    <div class="modal">
      <div class="panel">
        <header>
          <div class="title">${escapeHtml(v.name)}</div>
          <div class="actions">
            <a href="/api/files/${v.id}/download"><button>Download</button></a>
            <button data-action="closeViewer">Close</button>
          </div>
        </header>
        <iframe src="/api/files/${v.id}/view" title="${escapeHtml(v.name)}"></iframe>
      </div>
    </div>
  `;
}

function render() {
  if (!state.user) {
    root.innerHTML = `
      <div class="login-wrap">
        <div class="login-card">
          <div class="course-header">
            <span class="course-univ">UC DAVIS</span>
            <span class="course-sep">&mdash;</span>
            <span class="course-code">VET437</span>
          </div>
          <img class="logo" src="/canvasback-logo.jpg" alt="CanvasBack logo" onerror="this.style.display='none'" />
          <p class="motto">When Canvas does not have your back, use CanvasBack.</p>
          <h1>CanvasBack</h1>
          <p>Enter the course password to sign in.</p>
          <form id="login-form">
            <label>Password</label>
            <input type="password" name="password" autocomplete="current-password" autofocus required />
            <div class="err">${escapeHtml(state.loginError)}</div>
            <div style="margin-top:14px;text-align:right;">
              <button class="primary" type="submit">Sign in</button>
            </div>
          </form>
        </div>
      </div>
    `;
    document.getElementById('login-form').addEventListener('submit', doLogin);
    return;
  }

  const isFiles = state.view === 'files';
  root.innerHTML = `
    <div class="app">
      <div class="topbar">
        <div class="brand">
          <img class="brand-logo" src="/canvasback-logo.jpg" alt="" onerror="this.style.display='none'" />
          <div class="brand-text">
            <div class="brand-name">CanvasBack</div>
            <div class="brand-motto">When Canvas does not have your back, use CanvasBack.</div>
          </div>
        </div>
        <nav>
          <button class="${state.view === 'files' ? 'active' : ''}" data-action="view-files">Course files</button>
          <button class="${state.view === 'announcements' ? 'active' : ''}" data-action="view-ann">Announcements</button>
          <button class="${state.view === 'mcq' ? 'active' : ''}" data-action="view-mcq">MCQ Practice</button>
        </nav>
        <div class="user">
          <span>${escapeHtml(state.user.displayName)}</span>
          <span class="role">${state.user.role}</span>
          <button data-action="logout">Sign out</button>
        </div>
      </div>
      <div class="main ${isFiles ? '' : 'single'}">
        ${isFiles ? `<aside class="sidebar">${renderFolderTree()}</aside>` : ''}
        <section class="content">
          ${
            state.view === 'files'
              ? renderContentFiles()
              : state.view === 'announcements'
                ? renderAnnouncements()
                : renderMcq()
          }
        </section>
      </div>
      ${renderViewer()}
      ${state.toast ? `<div class="toast">${escapeHtml(state.toast)}</div>` : ''}
    </div>
  `;

  const form = document.getElementById('ann-form');
  if (form) form.addEventListener('submit', postAnnouncement);
  const upload = document.getElementById('upload-input');
  if (upload)
    upload.addEventListener('change', (e) =>
      uploadFromInput(state.selectedFolderId, e.target)
    );
  const mcqForm = document.getElementById('mcq-setup-form');
  if (mcqForm) {
    mcqForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      state.mcq.numQuestions = Number(fd.get('num_questions'));
      state.mcq.topicFocus = (fd.get('topic_focus') || '').toString().trim();
      startMcqGeneration();
    });
  }
}

function onClick(e) {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  e.preventDefault();
  const action = t.dataset.action;
  const id = t.dataset.id ? Number(t.dataset.id) : null;
  const name = t.dataset.name || '';

  switch (action) {
    case 'view-files':
      state.view = 'files';
      render();
      break;
    case 'view-ann':
      state.view = 'announcements';
      render();
      break;
    case 'view-mcq':
      state.view = 'mcq';
      render();
      loadMcqInfo().then(render);
      break;
    case 'mcqPick':
      selectMcqOption(t.dataset.letter);
      break;
    case 'mcqNext':
      navMcq(1);
      break;
    case 'mcqPrev':
      navMcq(-1);
      break;
    case 'mcqFinish':
      showMcqResults();
      break;
    case 'mcqReset':
      resetMcq();
      break;
    case 'mcqDownload':
      downloadMcqPdf();
      break;
    case 'logout':
      doLogout();
      break;
    case 'newRoot':
      createFolder(null);
      break;
    case 'newSub':
      createFolder(id);
      break;
    case 'addLink':
      addLink(id);
      break;
    case 'delFolder':
      deleteFolder(id, name);
      break;
    case 'renameFolder':
      renameFolder(id, name);
      break;
    case 'toggle':
      toggleExpand(id);
      break;
    case 'select': {
      // For top-level folders, also toggle expansion so clicking the title
      // opens/closes the section without having to aim for the caret.
      const isTop = t.closest('.row')?.classList.contains('top-level');
      if (isTop) toggleExpand(id);
      selectFolder(id);
      break;
    }
    case 'view': {
      const f = state.files.find((x) => x.id === id);
      if (f) viewFile(f);
      break;
    }
    case 'delFile':
      deleteFile(id, name);
      break;
    case 'renameFile': {
      const display = t.dataset.display || '';
      const orig = t.dataset.orig || '';
      renameFile(id, display, orig);
      break;
    }
    case 'moveUp':
      moveFile(id, 'up');
      break;
    case 'moveDown':
      moveFile(id, 'down');
      break;
    case 'closeViewer':
      closeViewer();
      break;
    case 'delAnn':
      deleteAnnouncement(id);
      break;
    default:
      // unknown - ignore
      break;
  }
}

root.addEventListener('click', onClick);

// ---------- Folder drag-and-drop reorder (instructor only) ----------
let draggingFolderId = null;

function clearFolderDropMarkers() {
  document.querySelectorAll('.tree .row.drop-above, .tree .row.drop-below, .tree .row.dragging')
    .forEach((el) => el.classList.remove('drop-above', 'drop-below', 'dragging'));
}

function isDescendant(ancestorId, candidateId) {
  if (ancestorId === candidateId) return true;
  const stack = [ancestorId];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === candidateId) return true;
    for (const f of state.folders) {
      if (f.parent_id === cur) stack.push(f.id);
    }
  }
  return false;
}

root.addEventListener('dragstart', (e) => {
  const row = e.target.closest('.tree .row[data-drag-id]');
  if (!row || state.user?.role !== 'instructor') return;
  draggingFolderId = Number(row.dataset.dragId);
  row.classList.add('dragging');
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    // Set arbitrary data so Firefox initiates the drag.
    e.dataTransfer.setData('text/plain', String(draggingFolderId));
  }
});

root.addEventListener('dragend', () => {
  draggingFolderId = null;
  clearFolderDropMarkers();
});

root.addEventListener('dragover', (e) => {
  if (draggingFolderId == null) return;
  const row = e.target.closest('.tree .row[data-drag-id]');
  if (!row) return;
  const targetId = Number(row.dataset.dragId);
  if (isDescendant(draggingFolderId, targetId)) return; // would create cycle
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  const rect = row.getBoundingClientRect();
  const above = e.clientY - rect.top < rect.height / 2;
  document.querySelectorAll('.tree .row.drop-above, .tree .row.drop-below')
    .forEach((el) => el.classList.remove('drop-above', 'drop-below'));
  row.classList.add(above ? 'drop-above' : 'drop-below');
});

root.addEventListener('drop', async (e) => {
  // Folder reorder drop
  if (draggingFolderId != null) {
    const row = e.target.closest('.tree .row[data-drag-id]');
    if (!row) {
      clearFolderDropMarkers();
      draggingFolderId = null;
      return;
    }
    e.preventDefault();
    const targetId = Number(row.dataset.dragId);
    if (targetId === draggingFolderId || isDescendant(draggingFolderId, targetId)) {
      clearFolderDropMarkers();
      draggingFolderId = null;
      return;
    }
    const target = state.folders.find((f) => f.id === targetId);
    const rect = row.getBoundingClientRect();
    const above = e.clientY - rect.top < rect.height / 2;
    const parentId = target.parent_id;
    const movingId = draggingFolderId;
    let beforeId;
    if (above) {
      beforeId = targetId;
    } else {
      // Exclude the moving folder from siblings so that dropping below your
      // own predecessor stays put instead of jumping to the end of the list.
      const siblings = state.folders
        .filter((f) => f.parent_id === parentId && f.id !== movingId)
        .sort((a, b) => a.display_order - b.display_order);
      const idx = siblings.findIndex((s) => s.id === targetId);
      const next = siblings[idx + 1];
      beforeId = next ? next.id : null;
    }
    draggingFolderId = null;
    clearFolderDropMarkers();
    try {
      await api('POST', `/api/folders/${movingId}/place`, { parentId, beforeId });
      await refreshAll();
      render();
    } catch (err) {
      showToast(err.message);
    }
  }
});

// ---------- PDF drag-and-drop upload (from desktop, instructor only) ----------
function isFileDrag(e) {
  return e.dataTransfer && e.dataTransfer.types && [...e.dataTransfer.types].includes('Files');
}
function shouldAcceptUpload() {
  return state.user?.role === 'instructor' && state.selectedFolderId != null;
}

document.addEventListener('dragover', (e) => {
  if (!isFileDrag(e) || !shouldAcceptUpload()) return;
  e.preventDefault();
  const zone = document.getElementById('drop-zone');
  if (zone) zone.classList.add('dragover');
});
document.addEventListener('dragleave', (e) => {
  if (!isFileDrag(e)) return;
  // Only clear when leaving the window entirely.
  if (e.relatedTarget == null) {
    document.getElementById('drop-zone')?.classList.remove('dragover');
  }
});
document.addEventListener('drop', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  document.getElementById('drop-zone')?.classList.remove('dragover');
  if (!shouldAcceptUpload()) {
    showToast('Select a folder first to upload PDFs.');
    return;
  }
  const files = e.dataTransfer.files;
  if (files && files.length) uploadFiles(state.selectedFolderId, files);
});

bootstrap();
