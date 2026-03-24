let selectedId = null;
let jobs = {};
let renderDetailFresh = false; // when true, next renderDetail call always scrolls to bottom

// ── File attachment state ───────────────────────────────────────────────────
let pendingFiles = []; // { mediaType, data, objectUrl, name }

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result.split(',')[1]); // strip data-URL prefix
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Clipboard paste only handles images — browsers don't support pasting arbitrary files
async function handlePastedFiles(e, fileArray, renderFn) {
  const items = Array.from(e.clipboardData?.items || []);
  const imageItems = items.filter(item => item.kind === 'file' && item.type.startsWith('image/'));
  if (imageItems.length === 0) return; // nothing to do — let default paste proceed
  e.preventDefault(); // stop browser from inserting raw image data as text
  for (const item of imageItems) {
    const file = item.getAsFile();
    if (!file) continue;
    try {
      const data = await fileToBase64(file);
      fileArray.push({ mediaType: file.type, data, objectUrl: URL.createObjectURL(file), name: file.name });
    } catch { /* skip unreadable items */ }
  }
  renderFn();
}

document.getElementById('image-input').addEventListener('change', async (e) => {
  for (const file of Array.from(e.target.files)) {
    try {
      const data = await fileToBase64(file);
      pendingFiles.push({ mediaType: file.type, data, objectUrl: URL.createObjectURL(file), name: file.name });
    } catch { /* skip unreadable files */ }
  }
  e.target.value = ''; // reset so same file can be re-added after removal
  renderFilePreviews();
});

function filePreviewHtml(f, onclickExpr) {
  const preview = f.mediaType.startsWith('image/')
    ? `<img src="${escHtml(f.objectUrl)}" alt="Attached file">`
    : `<div class="file-chip">${escHtml(f.name)}</div>`;
  return `<div class="img-preview-item">${preview}<button class="img-remove-btn" onclick="${onclickExpr}" title="Remove">×</button></div>`;
}

function renderFilePreviews() {
  const el = document.getElementById('image-previews');
  if (!el) return;
  el.innerHTML = pendingFiles.map((f, i) => filePreviewHtml(f, `removePendingFile(${i})`)).join('');
}

function removePendingFile(index) {
  URL.revokeObjectURL(pendingFiles[index].objectUrl);
  pendingFiles.splice(index, 1);
  renderFilePreviews();
}

// ── Helpers ────────────────────────────────────────────────────────────────
function relTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return Math.floor(diff/1000) + 's ago';
  if (diff < 3600000) return Math.floor(diff/60000) + 'm ago';
  return Math.floor(diff/3600000) + 'h ago';
}

function badge(status) {
  const label = status === 'awaiting_approval' ? 'needs approval' : status;
  const spinner = (status === 'running' || status === 'planning') ? '<span class="spinner"></span>' : '';
  return `<span class="badge badge-${status}">${spinner}${label}</span>`;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Job list ───────────────────────────────────────────────────────────────
function renderList(list) {
  const el = document.getElementById('job-list');
  if (!list.length) { el.innerHTML = '<div class="job-list-empty">No jobs yet</div>'; return; }
  el.innerHTML = list.map(j => `
    <div class="job-item${selectedId === j.id ? ' selected' : ''}" onclick="selectJob('${j.id}')">
      <div class="job-item-top">
        ${badge(j.status)}
        <span class="job-time">${relTime(j.createdAt)}</span>
      </div>
      <div class="job-prompt">${escHtml(j.prompt)}</div>
      ${j.images && j.images.length ? `<div class="job-image-badge">📎 ${j.images.length} file${j.images.length > 1 ? 's' : ''}</div>` : ''}
      ${j.cwd ? `<div style="font-size:10px;color:#555;font-family:monospace;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(j.cwd)}</div>` : ''}
    </div>
  `).join('');
}

// ── Job detail ─────────────────────────────────────────────────────────────
function toolDetail(name, input) {
  if (!input) return '';
  let detail = '';
  if (name === 'Glob') detail = input.pattern ?? '';
  else if (name === 'Bash') detail = input.description || (input.command ? String(input.command).slice(0, 80) : '');
  else detail = Object.values(input).find(v => typeof v === 'string') ?? '';
  return detail ? ` <span style="opacity:0.6;font-weight:400">${escHtml(String(detail))}</span>` : '';
}

function renderLogEntry(e) {
  if (e.type === 'user') {
    return `<div class="log-user">${escHtml(e.text)}</div>`;
  }
  if (e.type === 'text') {
    return `<div class="log-text">${escHtml(e.text)}</div>`;
  }
  if (e.type === 'tool_call') {
    return `<div class="log-tool">${escHtml(e.name)}${toolDetail(e.name, e.input)}</div>`;
  }
  if (e.type === 'image') {
    return `<div class="log-image"><img src="${escHtml(e.url)}" alt="Image" loading="lazy"></div>`;
  }
  return '';
}

function renderInputImages(job) {
  if (!job.images || !job.images.length) return '';
  const items = job.images.map((img, i) => {
    const url = `/images/${escHtml(job.id)}/${escHtml(img.filename)}`;
    if (img.mediaType.startsWith('image/')) {
      return `<a href="${url}" target="_blank" rel="noopener">
        <img src="${url}" alt="Attached image ${i+1}" class="input-img-thumb" loading="lazy">
      </a>`;
    } else {
      return `<a href="${url}" target="_blank" rel="noopener" class="input-file-chip">${escHtml(img.filename)}</a>`;
    }
  }).join('');
  return `<div class="input-images-row">${items}</div>`;
}

function renderDetail(job) {
  if (!job) { document.getElementById('detail').innerHTML = '<div class="detail-empty">Select a job to see details</div>'; return; }
  const started = job.startedAt ? new Date(job.startedAt).toLocaleTimeString() : '—';
  const finished = job.finishedAt ? new Date(job.finishedAt).toLocaleTimeString() : '—';
  const logHtml = job.log.map(renderLogEntry).join('');
  const resultHtml = job.result
    ? `<div class="result-box result-success">Result: ${escHtml(job.result)}</div>`
    : job.error
    ? `<div class="result-box result-error">Error: ${escHtml(job.error)}</div>`
    : '';
  const approveBarHtml = job.status === 'awaiting_approval'
    ? `<div class="approve-bar">
        <div class="approve-actions">
          <button class="btn-approve" onclick="approveJob('${job.id}')">Approve &amp; Run</button>
          <button class="btn-reject" onclick="rejectJob('${job.id}')">Reject</button>
        </div>
        <div class="approve-revise">
          <div class="followup-input-row">
            <textarea id="revise-prompt-${job.id}" placeholder="Request changes to the plan..." rows="2"></textarea>
          </div>
          <div class="followup-actions">
            <label class="attach-btn attach-btn-sm" for="revise-image-input-${job.id}" title="Attach files">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
            </label>
            <input type="file" id="revise-image-input-${job.id}" accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/html,text/csv,text/xml" multiple style="display:none" onchange="handleReviseImages('${job.id}', this)">
            <button class="btn-followup" id="revise-btn-${job.id}" onclick="requestChanges('${job.id}')">Request Changes</button>
          </div>
          <div id="revise-previews-${job.id}" class="image-previews"></div>
        </div>
      </div>`
    : '';
  const followupBarHtml = (job.status === 'completed' || job.status === 'failed') && job.sessionId
    ? `<div class="followup-bar">
        <div class="followup-input-row">
          <textarea id="followup-prompt-${job.id}" placeholder="Ask a follow-up question..." rows="2"></textarea>
        </div>
        <div class="followup-actions">
          <label class="attach-btn attach-btn-sm" for="followup-image-input-${job.id}" title="Attach files">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
          </label>
          <input type="file" id="followup-image-input-${job.id}" accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/html,text/csv,text/xml" multiple style="display:none" onchange="handleFollowupImages('${job.id}', this)">
          <button class="btn-followup" id="followup-btn-${job.id}" onclick="sendFollowUp('${job.id}')">Send Follow-up</button>
        </div>
        <div id="followup-previews-${job.id}" class="image-previews"></div>
      </div>`
    : '';
  // Preserve textarea contents and focus across DOM rebuilds (polling would otherwise erase typed text)
  const _reviseTaVal = (document.getElementById('revise-prompt-' + job.id) || {}).value || '';
  const _followupTaVal = (document.getElementById('followup-prompt-' + job.id) || {}).value || '';
  const _activeId = document.activeElement && document.activeElement.id ? document.activeElement.id : '';
  const _selStart = _activeId ? document.activeElement.selectionStart : null;
  const _selEnd   = _activeId ? document.activeElement.selectionEnd   : null;

  // Capture scroll state before destroying and recreating #log-feed
  const _oldFeed = document.getElementById('log-feed');
  let _oldScrollTop = 0, _oldScrollHeight = 0, _scrollWasAtBottom = true;
  if (_oldFeed && !renderDetailFresh) {
    _oldScrollTop = _oldFeed.scrollTop;
    _oldScrollHeight = _oldFeed.scrollHeight;
    // "at bottom" = within 80px of the maximum scroll position
    _scrollWasAtBottom = (_oldScrollHeight - _oldFeed.clientHeight - _oldScrollTop) <= 80;
  }

  document.getElementById('detail').innerHTML = `
    <div class="detail-header">
      <div class="detail-prompt">${escHtml(job.prompt)}</div>
      ${renderInputImages(job)}
      <div class="detail-meta">
        ${badge(job.status)}
        <span>Started: ${started}</span>
        <span>Finished: ${finished}</span>
        <span>Tools: ${job.tools.join(', ')}</span>
        ${job.cwd ? `<span style="font-family:monospace">cwd: ${escHtml(job.cwd)}</span>` : ''}
      </div>
    </div>
    <div class="log-feed" id="log-feed">${logHtml || '<span style="color:#444;font-size:13px">No log entries yet</span>'}</div>
    ${resultHtml}
    ${approveBarHtml}
    ${followupBarHtml}
  `;
  const feed = document.getElementById('log-feed');
  if (feed) {
    if (renderDetailFresh || _scrollWasAtBottom) {
      feed.scrollTop = feed.scrollHeight; // auto-scroll to bottom
    } else {
      // Anchor viewport: compensate for new content appended at the bottom
      feed.scrollTop = _oldScrollTop + (feed.scrollHeight - _oldScrollHeight);
    }
    renderDetailFresh = false; // consume the flag
  }
  // Restore textarea values and focus that were saved before the DOM rebuild
  if (_reviseTaVal) { const el = document.getElementById('revise-prompt-' + job.id); if (el) el.value = _reviseTaVal; }
  if (_followupTaVal) { const el = document.getElementById('followup-prompt-' + job.id); if (el) el.value = _followupTaVal; }
  if (_activeId) {
    const el = document.getElementById(_activeId);
    if (el) { el.focus(); if (_selStart !== null && el.setSelectionRange) el.setSelectionRange(_selStart, _selEnd); }
  }
  // Re-render any pending image previews (they live outside the rebuilt HTML)
  renderRevisePreviews(job.id);
  renderFollowupPreviews(job.id);
  const reviseTa = document.getElementById('revise-prompt-' + job.id);
  if (reviseTa) {
    reviseTa.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) requestChanges(job.id);
    });
    reviseTa.addEventListener('paste', async (e) => {
      if (!reviseImages[job.id]) reviseImages[job.id] = [];
      await handlePastedFiles(e, reviseImages[job.id], () => renderRevisePreviews(job.id));
    });
  }
  const followupTa = document.getElementById('followup-prompt-' + job.id);
  if (followupTa) {
    followupTa.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendFollowUp(job.id);
    });
    followupTa.addEventListener('paste', async (e) => {
      if (!followupImages[job.id]) followupImages[job.id] = [];
      await handlePastedFiles(e, followupImages[job.id], () => renderFollowupPreviews(job.id));
    });
  }
}

// ── Follow-up / revise file handling ──────────────────────────────────────
const followupImages = {}; // jobId → [{ mediaType, data, objectUrl, name }]
const reviseImages = {};   // jobId → [{ mediaType, data, objectUrl, name }]

async function handleFollowupImages(jobId, input) {
  if (!followupImages[jobId]) followupImages[jobId] = [];
  for (const file of Array.from(input.files)) {
    try {
      const data = await fileToBase64(file);
      followupImages[jobId].push({ mediaType: file.type, data, objectUrl: URL.createObjectURL(file), name: file.name });
    } catch { /* skip */ }
  }
  input.value = '';
  renderFollowupPreviews(jobId);
}

function renderFollowupPreviews(jobId) {
  const el = document.getElementById('followup-previews-' + jobId);
  if (!el) return;
  const files = followupImages[jobId] || [];
  el.innerHTML = files.map((f, i) => filePreviewHtml(f, `removeFollowupImage('${jobId}',${i})`)).join('');
}

function removeFollowupImage(jobId, index) {
  const imgs = followupImages[jobId] || [];
  URL.revokeObjectURL(imgs[index].objectUrl);
  imgs.splice(index, 1);
  renderFollowupPreviews(jobId);
}

async function handleReviseImages(jobId, input) {
  if (!reviseImages[jobId]) reviseImages[jobId] = [];
  for (const file of Array.from(input.files)) {
    try {
      const data = await fileToBase64(file);
      reviseImages[jobId].push({ mediaType: file.type, data, objectUrl: URL.createObjectURL(file), name: file.name });
    } catch { /* skip */ }
  }
  input.value = '';
  renderRevisePreviews(jobId);
}

function renderRevisePreviews(jobId) {
  const el = document.getElementById('revise-previews-' + jobId);
  if (!el) return;
  const files = reviseImages[jobId] || [];
  el.innerHTML = files.map((f, i) => filePreviewHtml(f, `removeReviseImage('${jobId}',${i})`)).join('');
}

function removeReviseImage(jobId, index) {
  const imgs = reviseImages[jobId] || [];
  URL.revokeObjectURL(imgs[index].objectUrl);
  imgs.splice(index, 1);
  renderRevisePreviews(jobId);
}

// ── API actions ────────────────────────────────────────────────────────────
async function selectJob(id) {
  selectedId = id;
  document.querySelectorAll('.job-item').forEach(el => el.classList.toggle('selected', el.onclick.toString().includes(id)));
  const job = await fetch('/jobs/' + id).then(r => r.json());
  jobs[id] = job;
  renderDetailFresh = true; // fresh view, always scroll to bottom
  renderDetail(job);
}

async function poll() {
  const list = await fetch('/jobs').then(r => r.json()).catch(() => []);
  const prevSelectedStatus = selectedId && jobs[selectedId] ? jobs[selectedId].status : null;
  list.forEach(j => { if (!jobs[j.id] || jobs[j.id].status !== j.status) jobs[j.id] = j; });
  renderList(list);
  if (selectedId && jobs[selectedId]) {
    const activeStatuses = ['pending', 'planning', 'awaiting_approval', 'running'];
    const statusChanged = prevSelectedStatus !== jobs[selectedId].status;
    if (activeStatuses.includes(jobs[selectedId].status) || statusChanged) {
      const job = await fetch('/jobs/' + selectedId).then(r => r.json()).catch(() => null);
      if (job) {
        // If the status changed, the layout shifts (new buttons appear/disappear) — scroll to bottom
        if (jobs[selectedId].status !== job.status) renderDetailFresh = true;
        jobs[selectedId] = job;
        renderDetail(job);
      }
    }
  }
}

async function approveJob(id) {
  await fetch('/jobs/' + id + '/approve', { method: 'POST' });
  const job = await fetch('/jobs/' + id).then(r => r.json());
  jobs[id] = job;
  renderDetailFresh = true; // job just transitioned, scroll to bottom
  renderDetail(job);
}

async function rejectJob(id) {
  await fetch('/jobs/' + id + '/reject', { method: 'POST' });
  const job = await fetch('/jobs/' + id).then(r => r.json());
  jobs[id] = job;
  renderDetailFresh = true; // job just transitioned, scroll to bottom
  renderDetail(job);
}

async function requestChanges(id) {
  const ta = document.getElementById('revise-prompt-' + id);
  const btn = document.getElementById('revise-btn-' + id);
  const prompt = ta.value.trim();
  if (!prompt) return;
  btn.disabled = true; btn.textContent = 'Sending...';
  const imgs = reviseImages[id] || [];
  const body = { prompt };
  if (imgs.length) body.images = imgs.map(({ mediaType, data }) => ({ mediaType, data }));
  try {
    await fetch('/jobs/' + id + '/revise', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body)
    });
    ta.value = '';
    (reviseImages[id] || []).forEach(img => URL.revokeObjectURL(img.objectUrl));
    delete reviseImages[id];
    selectedId = id;
    const refreshed = await fetch('/jobs/' + id).then(r => r.json()).catch(() => null);
    if (refreshed) {
      jobs[id] = refreshed;
      renderDetailFresh = true;
      renderDetail(refreshed);
    }
    await poll();
  } finally {
    btn.disabled = false; btn.textContent = 'Request Changes';
  }
}

async function sendFollowUp(id) {
  const ta = document.getElementById('followup-prompt-' + id);
  const btn = document.getElementById('followup-btn-' + id);
  const prompt = ta.value.trim();
  if (!prompt) return;
  btn.disabled = true; btn.textContent = 'Sending...';
  const imgs = followupImages[id] || [];
  const body = { prompt };
  if (imgs.length) body.images = imgs.map(({ mediaType, data }) => ({ mediaType, data }));
  try {
    await fetch('/jobs/' + id + '/followup', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body)
    });
    ta.value = '';
    // clean up follow-up image previews
    (followupImages[id] || []).forEach(img => URL.revokeObjectURL(img.objectUrl));
    delete followupImages[id];
    selectedId = id;
    // Unconditionally refresh the detail view so the user prompt appears immediately,
    // even if the follow-up completes before the next poll() status-change check.
    const refreshed = await fetch('/jobs/' + id).then(r => r.json()).catch(() => null);
    if (refreshed) {
      jobs[id] = refreshed;
      renderDetailFresh = true;
      renderDetail(refreshed);
    }
    await poll();
  } finally {
    btn.disabled = false; btn.textContent = 'Send Follow-up';
  }
}

async function submitJob() {
  const prompt = document.getElementById('prompt').value.trim();
  if (!prompt) return;
  const toolsRaw = document.getElementById('tools').value.trim();
  const tools = toolsRaw ? toolsRaw.split(',').map(s => s.trim()).filter(Boolean) : ['Read','Edit','Glob'];
  const cwdVal = document.getElementById('cwd').value.trim();
  const body = cwdVal ? {prompt, tools, cwd: cwdVal} : {prompt, tools};
  if (pendingFiles.length) {
    body.images = pendingFiles.map(({ mediaType, data }) => ({ mediaType, data }));
  }
  const btn = document.getElementById('submit-btn');
  btn.disabled = true; btn.textContent = 'Submitting...';
  try {
    const res = await fetch('/jobs', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const job = await res.json();
    document.getElementById('prompt').value = '';
    // clear file attachments
    pendingFiles.forEach(f => URL.revokeObjectURL(f.objectUrl));
    pendingFiles = [];
    renderFilePreviews();
    selectedId = job.id;
    await poll();
  } finally {
    btn.disabled = false; btn.textContent = 'Run Agent';
  }
}

document.getElementById('prompt').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitJob();
});
document.getElementById('prompt').addEventListener('paste', async (e) => {
  await handlePastedFiles(e, pendingFiles, renderFilePreviews);
});

poll();
setInterval(poll, 2000);
