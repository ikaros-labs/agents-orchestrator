let selectedId = null;
let jobs = {};
let renderDetailFresh = false; // when true, next renderDetail call always scrolls to bottom

// ── Image attachment state ──────────────────────────────────────────────────
let pendingImages = []; // { mediaType, data, objectUrl }

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result.split(',')[1]); // strip data-URL prefix
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

document.getElementById('image-input').addEventListener('change', async (e) => {
  for (const file of Array.from(e.target.files)) {
    try {
      const data = await fileToBase64(file);
      pendingImages.push({ mediaType: file.type, data, objectUrl: URL.createObjectURL(file) });
    } catch { /* skip unreadable files */ }
  }
  e.target.value = ''; // reset so same file can be re-added after removal
  renderImagePreviews();
});

function renderImagePreviews() {
  const el = document.getElementById('image-previews');
  if (!el) return;
  el.innerHTML = pendingImages.map((img, i) => `
    <div class="img-preview-item">
      <img src="${escHtml(img.objectUrl)}" alt="Attached image ${i+1}">
      <button class="img-remove-btn" onclick="removePendingImage(${i})" title="Remove">×</button>
    </div>
  `).join('');
}

function removePendingImage(index) {
  URL.revokeObjectURL(pendingImages[index].objectUrl);
  pendingImages.splice(index, 1);
  renderImagePreviews();
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
      ${j.images && j.images.length ? `<div class="job-image-badge">📎 ${j.images.length} image${j.images.length > 1 ? 's' : ''}</div>` : ''}
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
  const thumbs = job.images.map((img, i) =>
    `<a href="/images/${escHtml(job.id)}/${escHtml(img.filename)}" target="_blank" rel="noopener">
      <img src="/images/${escHtml(job.id)}/${escHtml(img.filename)}" alt="Attached image ${i+1}" class="input-img-thumb" loading="lazy">
    </a>`
  ).join('');
  return `<div class="input-images-row">${thumbs}</div>`;
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
  const planHtml = job.status === 'awaiting_approval' && job.plan
    ? `<div class="plan-box"><div class="plan-label">Plan</div>${escHtml(job.plan)}</div>`
    : '';
  const approveBarHtml = job.status === 'awaiting_approval'
    ? `<div class="approve-bar">
        <button class="btn-approve" onclick="approveJob('${job.id}')">Approve &amp; Run</button>
        <button class="btn-reject" onclick="rejectJob('${job.id}')">Reject</button>
      </div>`
    : '';
  const followupBarHtml = (job.status === 'completed' || job.status === 'failed') && job.sessionId
    ? `<div class="followup-bar">
        <div class="followup-input-row">
          <textarea id="followup-prompt-${job.id}" placeholder="Ask a follow-up question..." rows="2"></textarea>
        </div>
        <div class="followup-actions">
          <label class="attach-btn attach-btn-sm" for="followup-image-input-${job.id}" title="Attach images">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
          </label>
          <input type="file" id="followup-image-input-${job.id}" accept="image/png,image/jpeg,image/gif,image/webp" multiple style="display:none" onchange="handleFollowupImages('${job.id}', this)">
          <button class="btn-followup" id="followup-btn-${job.id}" onclick="sendFollowUp('${job.id}')">Send Follow-up</button>
        </div>
        <div id="followup-previews-${job.id}" class="image-previews"></div>
      </div>`
    : '';
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
    ${planHtml}
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
  const followupTa = document.getElementById('followup-prompt-' + job.id);
  if (followupTa) {
    followupTa.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendFollowUp(job.id);
    });
  }
}

// ── Follow-up image handling ───────────────────────────────────────────────
const followupImages = {}; // jobId → [{ mediaType, data, objectUrl }]

async function handleFollowupImages(jobId, input) {
  if (!followupImages[jobId]) followupImages[jobId] = [];
  for (const file of Array.from(input.files)) {
    try {
      const data = await fileToBase64(file);
      followupImages[jobId].push({ mediaType: file.type, data, objectUrl: URL.createObjectURL(file) });
    } catch { /* skip */ }
  }
  input.value = '';
  renderFollowupPreviews(jobId);
}

function renderFollowupPreviews(jobId) {
  const el = document.getElementById('followup-previews-' + jobId);
  if (!el) return;
  const imgs = followupImages[jobId] || [];
  el.innerHTML = imgs.map((img, i) => `
    <div class="img-preview-item">
      <img src="${escHtml(img.objectUrl)}" alt="Follow-up image ${i+1}">
      <button class="img-remove-btn" onclick="removeFollowupImage('${jobId}',${i})" title="Remove">×</button>
    </div>
  `).join('');
}

function removeFollowupImage(jobId, index) {
  const imgs = followupImages[jobId] || [];
  URL.revokeObjectURL(imgs[index].objectUrl);
  imgs.splice(index, 1);
  renderFollowupPreviews(jobId);
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
  if (pendingImages.length) {
    body.images = pendingImages.map(({ mediaType, data }) => ({ mediaType, data }));
  }
  const btn = document.getElementById('submit-btn');
  btn.disabled = true; btn.textContent = 'Submitting...';
  try {
    const res = await fetch('/jobs', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const job = await res.json();
    document.getElementById('prompt').value = '';
    // clear image attachments
    pendingImages.forEach(img => URL.revokeObjectURL(img.objectUrl));
    pendingImages = [];
    renderImagePreviews();
    selectedId = job.id;
    await poll();
  } finally {
    btn.disabled = false; btn.textContent = 'Run Agent';
  }
}

document.getElementById('prompt').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitJob();
});

poll();
setInterval(poll, 2000);
