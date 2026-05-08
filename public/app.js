// Tiny vanilla-JS frontend. No framework, just a state object and a render() function.

const state = {
  user: null,
  view: 'files', // 'files' | 'announcements'
  folders: [],
  selectedFolderId: null,
  expanded: new Set(),
  files: [],
  announcements: [],
  viewer: null, // { id, name }
  loginError: '',
  toast: '',
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
async function uploadFile(folderId, fileInput) {
  const file = fileInput.files?.[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  try {
    await api('POST', `/api/folders/${folderId}/files`, fd, true);
    showToast('File uploaded');
    await loadFiles(folderId);
    fileInput.value = '';
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
  const byParent = new Map();
  for (const f of folders) {
    const k = f.parent_id ?? 'root';
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(f);
  }
  for (const arr of byParent.values()) arr.sort((a, b) => a.name.localeCompare(b.name));
  return byParent;
}

function renderFolderTree() {
  const isInstructor = state.user?.role === 'instructor';
  const byParent = buildFolderTree(state.folders);

  function renderNode(node) {
    const children = byParent.get(node.id) || [];
    const isExpanded = state.expanded.has(node.id);
    const hasChildren = children.length > 0;
    const isActive = state.selectedFolderId === node.id;
    return `
      <li>
        <div class="row ${isActive ? 'active' : ''}" data-id="${node.id}">
          <span class="caret" data-action="toggle" data-id="${node.id}">
            ${hasChildren ? (isExpanded ? '▾' : '▸') : '·'}
          </span>
          <span class="name" data-action="select" data-id="${node.id}">${escapeHtml(node.name)}</span>
          ${
            isInstructor
              ? `<span class="actions">
                  <button data-action="newSub" data-id="${node.id}" title="New subfolder">+</button>
                  <button class="danger" data-action="delFolder" data-id="${node.id}" data-name="${escapeHtml(node.name)}" title="Delete">×</button>
                </span>`
              : ''
          }
        </div>
        ${
          isExpanded && hasChildren
            ? `<ul>${children.map(renderNode).join('')}</ul>`
            : ''
        }
      </li>
    `;
  }

  const roots = byParent.get('root') || [];
  return `
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
          ? roots.map(renderNode).join('')
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
    <h2>${escapeHtml(folder.name)}</h2>
    <div class="toolbar">
      ${
        isInstructor
          ? `<label class="primary" style="display:inline-flex;align-items:center;gap:6px;background:var(--accent);color:#fff;padding:6px 12px;border-radius:6px;cursor:pointer;">
              Upload PDF
              <input id="upload-input" type="file" accept="application/pdf,.pdf" style="display:none" />
            </label>
            <button data-action="newSub" data-id="${folder.id}">+ New subfolder</button>`
          : ''
      }
    </div>
    ${
      state.files.length
        ? `<div class="file-list">
            <div class="row head">
              <div>Name</div><div>Size</div><div>Uploaded</div><div></div>
            </div>
            ${state.files
              .map(
                (f) => `
              <div class="row">
                <div class="name">
                  <span class="icon">PDF</span>
                  <a href="#" data-action="view" data-id="${f.id}">${escapeHtml(f.original_name)}</a>
                </div>
                <div class="meta">${fmtBytes(f.size_bytes)}</div>
                <div class="meta">${fmtDate(f.uploaded_at)}</div>
                <div class="actions">
                  <button data-action="view" data-id="${f.id}">View</button>
                  <a href="/api/files/${f.id}/download"><button>Download</button></a>
                  ${
                    isInstructor
                      ? `<button class="danger" data-action="delFile" data-id="${f.id}" data-name="${escapeHtml(f.original_name)}">Delete</button>`
                      : ''
                  }
                </div>
              </div>
            `
              )
              .join('')}
          </div>`
        : '<div class="empty">No files in this folder yet.</div>'
    }
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
          <button class="${isFiles ? 'active' : ''}" data-action="view-files">Course files</button>
          <button class="${!isFiles ? 'active' : ''}" data-action="view-ann">Announcements</button>
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
          ${isFiles ? renderContentFiles() : renderAnnouncements()}
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
      uploadFile(state.selectedFolderId, e.target)
    );
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
    case 'logout':
      doLogout();
      break;
    case 'newRoot':
      createFolder(null);
      break;
    case 'newSub':
      createFolder(id);
      break;
    case 'delFolder':
      deleteFolder(id, name);
      break;
    case 'toggle':
      toggleExpand(id);
      break;
    case 'select':
      selectFolder(id);
      break;
    case 'view': {
      const f = state.files.find((x) => x.id === id);
      if (f) viewFile(f);
      break;
    }
    case 'delFile':
      deleteFile(id, name);
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
bootstrap();
