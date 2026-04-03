let selectedId = null;
let mobileView = 'sidebar';
function isMobile() { return window.matchMedia('(max-width: 768px)').matches; }
function showMobilePanel(view) {
  mobileView = view;
  const isDetail = view === 'detail';
  document.querySelector('.main').classList.toggle('mobile-detail-active', isDetail);
  document.body.classList.toggle('mobile-detail-active', isDetail);
}
function goBack() { showMobilePanel('sidebar'); }

function showNewTask() {
  selectedId = null;
  history.replaceState(null, '', location.pathname);
  document.querySelectorAll('.session-item').forEach(el => el.classList.remove('selected'));
  document.getElementById('new-task-panel').classList.remove('hidden');
  document.getElementById('detail').classList.add('hidden');
  document.getElementById('prompt').focus();
  if (isMobile()) showMobilePanel('detail');
}

let sessions = {};
let renderDetailFresh = false; // when true, next renderDetail call always scrolls to bottom
let currentMode = 'auto';
let currentModel = 'claude-sonnet-4-6';
let currentEffort = 'high';
let currentSandbox = 'sandbox';
let showArchived = false;
const approvalModels = {}; // sessionId → model selected for execution at approval time

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

// ── Notification sounds ─────────────────────────────────────────────────────
function playSound(type) {
  if (localStorage.getItem('soundsMuted') === 'true') return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    function beep(freq, startTime, duration, vol = 0.12) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.connect(g);
      g.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0, startTime);
      g.gain.linearRampToValueAtTime(vol, startTime + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
      osc.start(startTime);
      osc.stop(startTime + duration + 0.02);
    }
    const t = ctx.currentTime;
    if (type === 'attention') {
      beep(660, t, 0.12);
      beep(880, t + 0.14, 0.12);
    } else if (type === 'success') {
      beep(523, t, 0.09);
      beep(659, t + 0.10, 0.09);
      beep(784, t + 0.20, 0.14);
    } else if (type === 'failure') {
      beep(330, t, 0.12, 0.11);
      beep(220, t + 0.14, 0.18, 0.09);
    }
    setTimeout(() => ctx.close(), 700);
  } catch (e) { /* ignore audio errors */ }
}

function toggleMute() {
  const muted = localStorage.getItem('soundsMuted') === 'true';
  localStorage.setItem('soundsMuted', String(!muted));
  updateMuteBtn();
}

function updateMuteBtn() {
  const btn = document.getElementById('mute-btn');
  if (!btn) return;
  const muted = localStorage.getItem('soundsMuted') === 'true';
  btn.title = muted ? 'Sounds muted — click to enable' : 'Sounds on — click to mute';
  btn.classList.toggle('muted', muted);
  btn.innerHTML = muted
    ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`
    : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function relTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return Math.floor(diff/1000) + 's ago';
  if (diff < 3600000) return Math.floor(diff/60000) + 'm ago';
  return Math.floor(diff/3600000) + 'h ago';
}

// Statuses that display an animated spinner in the badge
const SPINNER_STATUSES = new Set(['running', 'planning']);

function badge(status) {
  const labels = {
    awaiting_approval: 'needs approval',
    awaiting_tool_approval: '⚠ tool approval',
    awaiting_user_question: '⚠ question',
    stopped: 'stopped',
  };
  const label = labels[status] ?? status;
  const spinner = SPINNER_STATUSES.has(status) ? '<span class="spinner"></span>' : '';
  return `<span class="badge badge-${status}">${spinner}${label}</span>`;
}

function setMode(mode) {
  currentMode = mode;
  document.querySelectorAll('#mode-selector .mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
}

function setModel(model) {
  currentModel = model;
  document.querySelectorAll('#model-selector .mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.model === model);
  });
}

function setApprovalModel(id, model) {
  approvalModels[id] = model;
  document.querySelectorAll(`.approval-model-btn[data-session="${id}"]`).forEach(btn => {
    btn.classList.toggle('active', btn.dataset.model === model);
  });
}

function setEffort(effort) {
  currentEffort = effort;
  document.querySelectorAll('#effort-selector .mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.effort === effort);
  });
}

function setSandbox(sandbox) {
  currentSandbox = sandbox;
  document.querySelectorAll('#sandbox-selector .mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.sandbox === sandbox);
  });
}

function onCwdSelectChange() {
  const sel = document.getElementById('cwd-select');
  const inp = document.getElementById('cwd-custom');
  const isNew = sel.value === '__new__';
  inp.style.display = isNew ? '' : 'none';
  if (isNew) inp.focus();
}

function updateCwdSelect(list) {
  const sel = document.getElementById('cwd-select');
  const seen = new Set();
  const dirs = [];
  for (const j of list) {
    if (j.cwd && !seen.has(j.cwd)) { seen.add(j.cwd); dirs.push(j.cwd); }
  }
  const current = sel.value;
  Array.from(sel.options).forEach(o => {
    if (o.value !== '' && o.value !== '__new__') o.remove();
  });
  const addNewOpt = sel.querySelector('option[value="__new__"]');
  dirs.forEach(dir => {
    const opt = document.createElement('option');
    opt.value = dir;
    opt.textContent = dir;
    sel.insertBefore(opt, addNewOpt);
  });
  if (current && Array.from(sel.options).some(o => o.value === current)) {
    sel.value = current; // restore previous selection
  } else if (!current && dirs.length) {
    sel.value = dirs[0]; // default to most recent on first load
  }
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function md(text) {
  return DOMPurify.sanitize(marked.parse(String(text)));
}

// ── Session list ───────────────────────────────────────────────────────────
function renderList(list) {
  // Update sidebar header with archive toggle
  const archivedCount = list.filter(j => j.archived).length;
  const hdr = document.getElementById('sidebar-header');
  if (hdr) {
    const archivedBtn = (archivedCount > 0 || showArchived)
      ? `<button class="btn-show-archived${showArchived ? ' active' : ''}" onclick="toggleShowArchived()" title="${showArchived ? 'Hide archived' : `Archived (${archivedCount})`}">
           <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
           ${showArchived ? '' : archivedCount}
         </button>`
      : '';
    hdr.innerHTML = `
      <button id="new-task-btn" onclick="showNewTask()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        New task
        <span class="kbd-hint"><span class="kbd-key">⌘</span><span class="kbd-key">⇧</span><span class="kbd-key">O</span></span>
      </button>
      ${archivedBtn}
      <button id="mute-btn" class="btn-mute" onclick="toggleMute()"></button>`;
    updateMuteBtn();
  }

  const visible = showArchived ? list : list.filter(j => !j.archived);
  const el = document.getElementById('session-list');
  if (!visible.length) {
    el.innerHTML = `<div class="session-list-empty">${list.length && !showArchived ? 'No active sessions' : 'No sessions yet'}</div>`;
    return;
  }
  el.innerHTML = visible.map(j => `
    <div class="session-item${selectedId === j.id ? ' selected' : ''}${j.archived ? ' archived' : ''}" onclick="selectJob('${j.id}')">
      <div class="session-item-top">
        ${badge(j.status)}
        ${j.mode && j.mode !== 'auto' ? `<span class="mode-tag mode-tag-${j.mode}">${j.mode}</span>` : ''}
        ${j.model && j.model !== 'claude-sonnet-4-6' ? `<span class="mode-tag mode-tag-${j.model === 'claude-haiku-4-5-20251001' ? 'haiku' : 'opus'}">${j.model === 'claude-haiku-4-5-20251001' ? 'haiku' : 'opus'}</span>` : ''}
        ${j.effort && j.effort !== 'high' ? `<span class="mode-tag mode-tag-${j.effort}">${j.effort}</span>` : ''}
        ${j.sandbox && j.sandbox !== 'none' ? `<span class="mode-tag mode-tag-${j.sandbox}">${j.sandbox === 'approval' ? '🔒' : j.sandbox === 'docker' ? '🐳' : '🛡️'}</span>` : ''}
        <span class="session-time">${relTime(j.createdAt)}</span>
      </div>
      <div class="session-prompt">${escHtml(j.title || j.prompt)}</div>
      ${j.images && j.images.length ? `<div class="session-image-badge">📎 ${j.images.length} file${j.images.length > 1 ? 's' : ''}</div>` : ''}
      ${j.cwd ? `<div style="font-size:10px;color:#555;font-family:monospace;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(j.cwd)}</div>` : ''}
    </div>
  `).join('');
}

function toggleShowArchived() {
  showArchived = !showArchived;
  renderList(getSortedJobs());
}

// ── Job detail ─────────────────────────────────────────────────────────────
function toolDetail(name, input, cwd) {
  if (!input) return '';
  let detail = '';
  if (name === 'Glob') detail = input.pattern ?? '';
  else if (name === 'Bash') detail = input.description || (input.command ? String(input.command).slice(0, 80) : '');
  else detail = Object.values(input).find(v => typeof v === 'string') ?? '';
  const cwdTools = new Set(['Read', 'Edit', 'Write', 'MultiEdit']);
  if (detail && cwd && cwdTools.has(name) && detail.startsWith(cwd)) {
    detail = '.' + detail.slice(cwd.length);
  }
  return detail ? ` <span style="opacity:0.6;font-weight:400">${escHtml(String(detail))}</span>` : '';
}

function renderTodoWrite(todos) {
  if (!Array.isArray(todos) || !todos.length) return '';
  const icons = { completed: '✓', in_progress: '●', pending: '○' };
  const items = todos.map(t => {
    const status = t.status ?? 'pending';
    const icon = icons[status] ?? '○';
    return `<div class="todo-item todo-${escHtml(status)}">
      <span class="todo-icon">${icon}</span>
      <span class="todo-content">${escHtml(String(t.content ?? ''))}</span>
    </div>`;
  }).join('');
  return `<div class="chat-todo">${items}</div>`;
}

function renderBashTool(e) {
  const desc = e.input?.description ? escHtml(String(e.input.description)) : null;
  const cmd = e.input?.command ? escHtml(String(e.input.command)) : null;
  const summary = desc || (cmd ? cmd.slice(0, 80) : 'Bash');
  const hasOutput = e.output !== undefined && e.output !== null;
  const outputIsEmpty = !e.output || e.output === '(Bash completed with no output)';

  let bodyHtml = '';
  if (cmd) {
    bodyHtml += `<div class="tool-expand-row"><span class="tool-expand-key">cmd</span><pre class="tool-expand-code">${cmd}</pre></div>`;
  }
  if (hasOutput) {
    const outClass = outputIsEmpty ? ' tool-expand-empty' : '';
    const outText = outputIsEmpty ? '(no output)' : escHtml(e.output);
    bodyHtml += `<div class="tool-expand-row${outClass}"><span class="tool-expand-key">out</span><pre class="tool-expand-code">${outText}</pre></div>`;
  }

  return `<details class="chat-tool-bash">
    <summary class="chat-tool">Bash <span class="tool-detail">${summary}</span></summary>
    <div class="tool-expand-body">${bodyHtml}</div>
  </details>`;
}

function renderChatEntry(e, cwd) {
  if (e.type === 'user') {
    return `<div class="chat-user">${escHtml(e.text)}</div>`;
  }
  if (e.type === 'text') {
    return `<div class="chat-text markdown-body">${md(e.text)}</div>`;
  }
  if (e.type === 'tool_call') {
    if (e.name === 'ExitPlanMode') return '';
    if (e.name === 'TodoWrite') return renderTodoWrite(e.input?.todos);
    if (e.name === 'Bash') return renderBashTool(e);
    return `<div class="chat-tool">${escHtml(e.name)}${toolDetail(e.name, e.input, cwd)}</div>`;
  }
  if (e.type === 'image') {
    return `<div class="chat-image"><img src="${escHtml(e.url)}" alt="Image" loading="lazy"></div>`;
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

// ── AskUserQuestion state & rendering ──────────────────────────────────────
// Preserves answer selections across polling DOM rebuilds, keyed by jobId.
const questionAnswers = {}; // { [jobId]: { [questionText]: string } }

function renderQuestionBar(job) {
  if (job.status !== 'awaiting_user_question') return '';
  const askTool = (job.pendingTools ?? []).find(t => t.name === 'AskUserQuestion');
  if (!askTool) return '';
  const questions = askTool.input?.questions ?? [];
  if (!questions.length) return '';
  const id = job.id;
  const saved = questionAnswers[id] ?? {};

  const questionsHtml = questions.map((q, i) => {
    const name = `q_${id}_${i}`;
    const inputType = q.multiSelect ? 'checkbox' : 'radio';
    const savedVal = saved[q.question] ?? '';
    const savedArr = savedVal ? savedVal.split(', ') : [];

    const optionsHtml = (q.options ?? []).map(opt => {
      const checked = savedArr.includes(opt.label) ? 'checked' : '';
      return `<label class="question-option">
        <input type="${inputType}" name="${name}" value="${escHtml(opt.label)}" ${checked}>
        <span class="question-option-body">
          <span class="question-option-label">${escHtml(opt.label)}</span>
          ${opt.description ? `<span class="question-option-desc">${escHtml(opt.description)}</span>` : ''}
        </span>
      </label>`;
    }).join('');

    // Detect if the current saved value is a free-text (not one of the preset labels)
    const presetLabels = (q.options ?? []).map(o => o.label);
    const otherVals = savedArr.filter(v => !presetLabels.includes(v));
    const otherChecked = otherVals.length ? 'checked' : '';
    const otherText = otherVals.join(', ');

    const otherHtml = `<label class="question-option-other">
      <input type="${inputType}" name="${name}" value="__other__" ${otherChecked}>
      <span class="question-option-other-label">Other:</span>
      <input type="text" id="${name}_other" placeholder="Type a custom answer…" value="${escHtml(otherText)}" oninput="selectOtherRadio('${name}')">
    </label>`;

    return `<div class="question-item">
      ${q.header ? `<span class="question-header-chip">${escHtml(q.header)}</span>` : ''}
      <div class="question-text markdown-body">${md(q.question)}</div>
      <div class="question-options">
        ${optionsHtml}
        ${otherHtml}
      </div>
    </div>`;
  }).join('<hr class="question-divider">');

  return `<div class="question-bar">
    ${questionsHtml}
    <div class="question-bar-actions">
      <button class="btn-answer" id="answer-btn-${id}" onclick="answerQuestion('${id}')">Submit Answers</button>
    </div>
  </div>`;
}

function _snapshotQuestionAnswers(job) {
  // Read current form selections into questionAnswers before a DOM rebuild
  if (job.status !== 'awaiting_user_question') return;
  const askTool = (job.pendingTools ?? []).find(t => t.name === 'AskUserQuestion');
  if (!askTool) return;
  const questions = askTool.input?.questions ?? [];
  const id = job.id;
  if (!questionAnswers[id]) questionAnswers[id] = {};
  questions.forEach((q, i) => {
    const name = `q_${id}_${i}`;
    const inputs = document.querySelectorAll(`[name="${name}"]`);
    if (q.multiSelect) {
      const vals = [];
      inputs.forEach(inp => {
        if (inp.checked) {
          if (inp.value === '__other__') {
            const t = (document.getElementById(`${name}_other`)?.value ?? '').trim();
            if (t) vals.push(t);
          } else {
            vals.push(inp.value);
          }
        }
      });
      questionAnswers[id][q.question] = vals.join(', ');
    } else {
      const checked = Array.from(inputs).find(inp => inp.checked);
      if (checked) {
        if (checked.value === '__other__') {
          questionAnswers[id][q.question] = (document.getElementById(`${name}_other`)?.value ?? '').trim();
        } else {
          questionAnswers[id][q.question] = checked.value;
        }
      }
    }
  });
}

function selectOtherRadio(name) {
  const el = document.querySelector(`[name="${name}"][value="__other__"]`);
  if (el) el.checked = true;
}

async function answerQuestion(id) {
  const job = sessions[id];
  if (!job) return;
  const askTool = (job.pendingTools ?? []).find(t => t.name === 'AskUserQuestion');
  const questions = askTool?.input?.questions ?? [];
  const answers = {};
  questions.forEach((q, i) => {
    const name = `q_${id}_${i}`;
    const inputs = document.querySelectorAll(`[name="${name}"]`);
    if (q.multiSelect) {
      const selected = [];
      inputs.forEach(inp => {
        if (inp.checked) {
          if (inp.value === '__other__') {
            const t = (document.getElementById(`${name}_other`)?.value ?? '').trim();
            if (t) selected.push(t);
          } else {
            selected.push(inp.value);
          }
        }
      });
      answers[q.question] = selected.join(', ') || '';
    } else {
      const checked = Array.from(inputs).find(inp => inp.checked);
      if (checked) {
        if (checked.value === '__other__') {
          answers[q.question] = (document.getElementById(`${name}_other`)?.value ?? '').trim();
        } else {
          answers[q.question] = checked.value;
        }
      }
    }
  });
  const btn = document.getElementById(`answer-btn-${id}`);
  if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }
  try {
    await fetch(`/sessions/${id}/answer-question`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers }),
    });
    delete questionAnswers[id];
    const refreshed = await fetch('/sessions/' + id).then(r => r.json()).catch(err => { console.warn('[answerQuestion] failed to refresh session:', err); return null; });
    if (refreshed) { sessions[id] = refreshed; renderDetailFresh = true; renderDetail(refreshed); }
    // SSE will deliver subsequent chat_entry and session_status events
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Submit Answers'; }
  }
}

// ── renderDetail sub-functions ──────────────────────────────────────────────

function renderPlanCard(planText) {
  if (!planText) return '';
  return `<div class="chat-plan"><span class="chat-plan-label">Plan</span><div class="markdown-body">${md(planText)}</div></div>`;
}

function renderResultBox(job) {
  if (job.error) return `<div class="chat-error"><span class="chat-error-label">Error</span>${escHtml(job.error)}</div>`;
  return '';
}

function renderApproveBar(job) {
  if (job.status !== 'awaiting_approval') return '';
  if (!approvalModels[job.id]) approvalModels[job.id] = job.model ?? 'claude-sonnet-4-6';
  const isActive = (m) => approvalModels[job.id] === m ? 'active' : '';
  return `<div class="approve-bar">
    <div class="approve-model-row">
      <span class="approve-model-label">Run with</span>
      <div class="mode-selector">
        <button class="mode-btn approval-model-btn ${isActive('claude-haiku-4-5-20251001')}" data-session="${job.id}" data-model="claude-haiku-4-5-20251001" onclick="setApprovalModel('${job.id}', 'claude-haiku-4-5-20251001')">Haiku</button>
        <button class="mode-btn approval-model-btn ${isActive('claude-sonnet-4-6')}" data-session="${job.id}" data-model="claude-sonnet-4-6" onclick="setApprovalModel('${job.id}', 'claude-sonnet-4-6')">Sonnet</button>
        <button class="mode-btn approval-model-btn ${isActive('claude-opus-4-6')}" data-session="${job.id}" data-model="claude-opus-4-6" onclick="setApprovalModel('${job.id}', 'claude-opus-4-6')">Opus</button>
      </div>
    </div>
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
  </div>`;
}

function renderToolApprovalBar(job) {
  if (job.status !== 'awaiting_tool_approval') return '';
  const pendingToolsList = (job.pendingTools ?? []).filter(t => t.name !== 'AskUserQuestion');
  if (!pendingToolsList.length) return '';
  return pendingToolsList.map(tool => {
    const inputRows = Object.entries(tool.input || {})
      .map(([k, v]) => {
        const val = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
        return `<div class="tool-input-row"><span class="tool-input-key">${escHtml(k)}</span><span class="tool-input-val">${escHtml(val)}</span></div>`;
      }).join('');
    const toolUseID = escHtml(tool.toolUseID);
    return `<div class="tool-approval-bar">
      <div class="tool-approval-header">
        <span class="tool-approval-label">Tool request</span>
        <span class="tool-approval-name">${escHtml(tool.name)}</span>
      </div>
      ${inputRows ? `<div class="tool-input-detail">${inputRows}</div>` : ''}
      <div class="tool-approval-actions">
        <button class="btn-approve" onclick="approveToolUse('${job.id}', '${toolUseID}')">Approve</button>
        <input type="text" class="tool-deny-reason" placeholder="Reason for denying (optional)">
        <button class="btn-reject" onclick="rejectToolUse('${job.id}', '${toolUseID}', this)">Deny</button>
      </div>
    </div>`;
  }).join('');
}

function renderFollowUpBar(job) {
  const showFollowUp = ((job.status === 'completed' || job.status === 'failed') && job.claudeSessionId) || job.status === 'stopped';
  if (!showFollowUp) return '';
  return `<div class="followup-bar">
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
  </div>`;
}

function renderDetailHeader(job) {
  const started = job.startedAt ? new Date(job.startedAt).toLocaleTimeString() : '—';
  const finished = job.finishedAt ? new Date(job.finishedAt).toLocaleTimeString() : '—';
  const NOT_STOPPABLE = new Set(['awaiting_approval', 'completed', 'failed', 'stopped']);
  const stopBtnHtml = !NOT_STOPPABLE.has(job.status)
    ? `<button class="btn-stop" onclick="stopJob('${job.id}')">Stop</button>`
    : '';
  const archiveBtnHtml = job.archived
    ? `<button class="btn-archive active" onclick="unarchiveJob('${job.id}')">Unarchive</button>`
    : `<button class="btn-archive" onclick="archiveJob('${job.id}')">Archive</button>`;
  return `<div class="detail-header">
    <button class="mobile-back-btn" onclick="goBack()">&#8592; Back</button>
    <div class="detail-meta">
      ${badge(job.status)}
      <span>Started: ${started}</span>
      <span>Finished: ${finished}</span>
      ${job.cwd ? `<span style="font-family:monospace">cwd: ${escHtml(job.cwd)}</span>` : ''}
      ${job.worktreePath ? `<span style="font-family:monospace;color:#6b9eff" title="Isolated worktree created for this job">worktree: ${escHtml(job.worktreePath)}</span>` : ''}
      ${job.sandbox && job.sandbox !== 'none' ? `<span class="mode-tag mode-tag-${job.sandbox}" title="Sandbox: ${job.sandbox}">${job.sandbox}</span>` : ''}
      ${job.usage ? `<span title="Token and cost usage for this job">$${job.usage.costUSD.toFixed(1)} · ${job.usage.totalTokens.toLocaleString()} tokens (${(job.usage.totalTokens / 200000 * 100).toFixed(1)}%)</span>` : ''}
      <div class="detail-actions">${stopBtnHtml}${archiveBtnHtml}</div>
    </div>
  </div>`;
}

/** Capture scroll position of #chat-feed before a DOM rebuild. */
function captureScrollState() {
  const feed = document.getElementById('chat-feed');
  if (!feed || renderDetailFresh) return { wasAtBottom: true, scrollTop: 0, scrollHeight: 0 };
  const scrollTop = feed.scrollTop;
  const scrollHeight = feed.scrollHeight;
  // "at bottom" = within 80px of the maximum scroll position
  const wasAtBottom = (scrollHeight - feed.clientHeight - scrollTop) <= 80;
  return { wasAtBottom, scrollTop, scrollHeight };
}

/** Restore scroll position after a DOM rebuild, anchoring the viewport if not at bottom. */
function restoreScrollState(state) {
  const feed = document.getElementById('chat-feed');
  if (!feed) return;
  if (renderDetailFresh || state.wasAtBottom) {
    feed.scrollTop = feed.scrollHeight; // auto-scroll to bottom
  } else {
    // Anchor viewport: compensate for new content appended at the bottom
    feed.scrollTop = state.scrollTop + (feed.scrollHeight - state.scrollHeight);
  }
  renderDetailFresh = false; // consume the flag
}

/** Capture textarea values and focus state before a DOM rebuild. */
function captureInputState(jobId) {
  const activeId = document.activeElement?.id || '';
  return {
    reviseTaVal: document.getElementById('revise-prompt-' + jobId)?.value || '',
    followupTaVal: document.getElementById('followup-prompt-' + jobId)?.value || '',
    activeId,
    selStart: activeId ? document.activeElement.selectionStart : null,
    selEnd: activeId ? document.activeElement.selectionEnd : null,
  };
}

/** Restore textarea values and focus state after a DOM rebuild. */
function restoreInputState(state, jobId) {
  if (state.reviseTaVal) { const el = document.getElementById('revise-prompt-' + jobId); if (el) el.value = state.reviseTaVal; }
  if (state.followupTaVal) { const el = document.getElementById('followup-prompt-' + jobId); if (el) el.value = state.followupTaVal; }
  if (state.activeId) {
    const el = document.getElementById(state.activeId);
    if (el) { el.focus(); if (state.selStart !== null && el.setSelectionRange) el.setSelectionRange(state.selStart, state.selEnd); }
  }
}

/** Attach keyboard and paste listeners to revise/follow-up textareas after a DOM rebuild. */
function attachTextareaListeners(jobId) {
  const reviseTa = document.getElementById('revise-prompt-' + jobId);
  if (reviseTa) {
    reviseTa.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) requestChanges(jobId);
    });
    reviseTa.addEventListener('paste', async (e) => {
      if (!reviseImages[jobId]) reviseImages[jobId] = [];
      await handlePastedFiles(e, reviseImages[jobId], () => renderRevisePreviews(jobId));
    });
  }
  const followupTa = document.getElementById('followup-prompt-' + jobId);
  if (followupTa) {
    followupTa.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendFollowUp(jobId);
    });
    followupTa.addEventListener('paste', async (e) => {
      if (!followupImages[jobId]) followupImages[jobId] = [];
      await handlePastedFiles(e, followupImages[jobId], () => renderFollowupPreviews(jobId));
    });
  }
}

function renderDetail(job) {
  if (!job) { document.getElementById('detail').innerHTML = '<div class="detail-empty">Select a session to see details</div>'; return; }
  // Snapshot question answers BEFORE rebuilding DOM so selections are preserved
  _snapshotQuestionAnswers(job);
  const scrollState = captureScrollState();
  const inputState = captureInputState(job.id);

  const cwd = job.worktreePath ?? job.cwd;
  const chatHtml = job.chat.map(e => {
    const html = renderChatEntry(e, cwd);
    if (e.type === 'tool_call' && e.name === 'ExitPlanMode') return html + renderPlanCard(e.input?.plan);
    return html;
  }).join('');

  const feedHtml = `<div class="chat-user">${escHtml(job.prompt)}</div>${renderInputImages(job)}`
    + chatHtml
    + renderResultBox(job)
    + renderQuestionBar(job);

  document.getElementById('detail').innerHTML = `
    ${renderDetailHeader(job)}
    <div class="chat-feed" id="chat-feed">${feedHtml}</div>
    ${renderApproveBar(job)}
    ${renderToolApprovalBar(job)}
    ${renderFollowUpBar(job)}
  `;

  restoreScrollState(scrollState);
  restoreInputState(inputState, job.id);
  // Re-render any pending image previews (they live outside the rebuilt HTML)
  renderRevisePreviews(job.id);
  renderFollowupPreviews(job.id);
  attachTextareaListeners(job.id);
}

// ── Follow-up / revise file handling ──────────────────────────────────────
const followupImages = {}; // jobId → [{ mediaType, data, objectUrl, name }]
const reviseImages = {};   // jobId → [{ mediaType, data, objectUrl, name }]

/** Generic handler for file inputs attached to a job-scoped image store. */
async function handleJobImages(store, prefix, jobId, input) {
  if (!store[jobId]) store[jobId] = [];
  for (const file of Array.from(input.files)) {
    try {
      const data = await fileToBase64(file);
      store[jobId].push({ mediaType: file.type, data, objectUrl: URL.createObjectURL(file), name: file.name });
    } catch { /* skip unreadable files */ }
  }
  input.value = '';
  renderJobImagePreviews(store, prefix, jobId);
}

function renderJobImagePreviews(store, prefix, jobId) {
  const el = document.getElementById(`${prefix}-previews-${jobId}`);
  if (!el) return;
  const files = store[jobId] || [];
  el.innerHTML = files.map((f, i) => filePreviewHtml(f, `remove${prefix[0].toUpperCase()}${prefix.slice(1)}Image('${jobId}',${i})`)).join('');
}

function removeJobImage(store, prefix, jobId, index) {
  const imgs = store[jobId] || [];
  URL.revokeObjectURL(imgs[index].objectUrl);
  imgs.splice(index, 1);
  renderJobImagePreviews(store, prefix, jobId);
}

// Named wrappers — referenced by HTML inline handlers and paste listeners
async function handleFollowupImages(jobId, input) { await handleJobImages(followupImages, 'followup', jobId, input); }
async function handleReviseImages(jobId, input) { await handleJobImages(reviseImages, 'revise', jobId, input); }
function renderFollowupPreviews(jobId) { renderJobImagePreviews(followupImages, 'followup', jobId); }
function renderRevisePreviews(jobId) { renderJobImagePreviews(reviseImages, 'revise', jobId); }
function removeFollowupImage(jobId, index) { removeJobImage(followupImages, 'followup', jobId, index); }
function removeReviseImage(jobId, index) { removeJobImage(reviseImages, 'revise', jobId, index); }

// ── API actions ────────────────────────────────────────────────────────────
async function selectJob(id) {
  selectedId = id;
  history.replaceState(null, '', '#' + id);
  document.querySelectorAll('.session-item').forEach(el => el.classList.toggle('selected', el.onclick.toString().includes(id)));
  document.getElementById('new-task-panel').classList.add('hidden');
  document.getElementById('detail').classList.remove('hidden');
  const session = await fetch('/sessions/' + id).then(r => r.json());
  sessions[id] = session;
  renderDetailFresh = true; // fresh view, always scroll to bottom
  renderDetail(session);
  if (isMobile()) showMobilePanel('detail');
}

// ── SSE real-time updates ───────────────────────────────────────────────────

/** Sort sessions by latest user-message time, mirroring the server's listSessions() order. */
function _latestUserMsgTime(session) {
  const times = (session.chat || []).filter(e => e.type === 'user').map(e => new Date(e.ts).getTime());
  return Math.max(new Date(session.createdAt).getTime(), ...times, 0);
}
function getSortedJobs() {
  return Object.values(sessions).sort((a, b) => _latestUserMsgTime(b) - _latestUserMsgTime(a));
}

/**
 * Append a single chat entry to the visible #chat-feed without rebuilding the
 * entire detail panel. Only runs when jobId === selectedId and the feed exists.
 * When index is provided, updates an existing element if present (for patches like Bash output).
 */
function appendChatEntryDOM(entry, jobId, index) {
  if (jobId !== selectedId) return;
  const feed = document.getElementById('chat-feed');
  if (!feed) return;
  let html = renderChatEntry(entry, sessions[jobId]?.worktreePath ?? sessions[jobId]?.cwd);
  if (!html) return;
  // Inject data-chat-index into the root element so we can find it for updates
  if (index !== undefined) {
    html = html.replace(/^(<\w+)/, `$1 data-chat-index="${index}"`);
  }
  // If element with this index already exists, update it in-place
  if (index !== undefined) {
    const existing = feed.querySelector(`[data-chat-index="${index}"]`);
    if (existing) {
      const wasOpen = existing.tagName === 'DETAILS' ? existing.open : existing.querySelector('details')?.open;
      existing.outerHTML = html;
      if (wasOpen) {
        const updated = feed.querySelector(`[data-chat-index="${index}"]`);
        const details = updated?.tagName === 'DETAILS' ? updated : updated?.querySelector('details');
        if (details) details.open = true;
      }
      return;
    }
  }
  // Remove placeholder on first real entry
  if (!feed.querySelector('.chat-text, .chat-user, .chat-tool, .chat-image, .chat-tool-bash')) {
    feed.innerHTML = '';
  }
  const wasAtBottom = (feed.scrollHeight - feed.clientHeight - feed.scrollTop) <= 80;
  feed.insertAdjacentHTML('beforeend', html);
  if (wasAtBottom) feed.scrollTop = feed.scrollHeight;
}

function initSSE() {
  const es = new EventSource('/events');

  // Initial snapshot: full current state of all sessions (sent on every connect/reconnect)
  es.addEventListener('snapshot', e => {
    const list = JSON.parse(e.data);
    list.forEach(j => { sessions[j.id] = j; });
    renderList(list); // already server-sorted
    updateCwdSelect(list);
    const hashId = location.hash.slice(1);
    if (hashId && sessions[hashId] && !selectedId) {
      // First load: restore from hash using snapshot data (no extra fetch)
      selectedId = hashId;
      document.querySelectorAll('.session-item').forEach(el => el.classList.toggle('selected', el.onclick.toString().includes(hashId)));
      document.getElementById('new-task-panel').classList.add('hidden');
      document.getElementById('detail').classList.remove('hidden');
      renderDetailFresh = true;
      renderDetail(sessions[hashId]);
      if (isMobile()) showMobilePanel('detail');
    } else if (selectedId && sessions[selectedId]) {
      renderDetail(sessions[selectedId]);
    }
  });

  // A brand-new session was created
  es.addEventListener('session_created', e => {
    const { job } = JSON.parse(e.data);
    sessions[job.id] = job;
    const sorted = getSortedJobs();
    renderList(sorted);
    updateCwdSelect(sorted);
    if (selectedId === job.id) {
      renderDetailFresh = true;
      renderDetail(job);
    }
  });

  // Session metadata changed: status, result, error, plan, pendingTools, timestamps, archived
  es.addEventListener('session_status', e => {
    const data = JSON.parse(e.data);
    const { jobId, status, startedAt, finishedAt, result, error, claudeSessionId, pendingTools, archived, usage, title } = data;
    const session = sessions[jobId];
    if (!session) return;
    const prevStatus = session.status;
    Object.assign(session, { status, startedAt, finishedAt, result, error, claudeSessionId, pendingTools, archived, usage, title });
    if (prevStatus !== status) {
      if (['awaiting_approval', 'awaiting_tool_approval', 'awaiting_user_question'].includes(status)) {
        playSound('attention');
      } else if (status === 'completed') {
        playSound('success');
      } else if (status === 'failed' || status === 'stopped') {
        playSound('failure');
      }
    }
    renderList(getSortedJobs());
    if (jobId === selectedId) {
      if (prevStatus !== status) renderDetailFresh = true;
      renderDetail(session);
    }
  });

  // A new chat entry was appended — stream it directly into the feed DOM
  es.addEventListener('chat_entry', e => {
    const { jobId, entry, index } = JSON.parse(e.data);
    const session = sessions[jobId];
    if (!session) return;
    // Keep the local chat array in sync (sparse-safe)
    while (session.chat.length <= index) session.chat.push(null);
    session.chat[index] = entry;
    appendChatEntryDOM(entry, jobId, index);
    // Re-sort sidebar when a new user message arrives (followup changes sort key)
    if (entry.type === 'user') renderList(getSortedJobs());
  });

  es.onerror = () => {
    // EventSource auto-reconnects; the snapshot event on reconnect re-bootstraps state
    console.warn('[SSE] connection lost, reconnecting…');
  };
}

async function stopJob(id) {
  await fetch('/sessions/' + id + '/stop', { method: 'POST' });
  // SSE session_status event will update the detail panel
}

async function archiveJob(id) {
  await fetch('/sessions/' + id + '/archive', { method: 'POST' });
  // SSE session_status event will update the detail panel and list
}

async function unarchiveJob(id) {
  await fetch('/sessions/' + id + '/unarchive', { method: 'POST' });
  // SSE session_status event will update the detail panel and list
}

async function approveToolUse(id, toolUseID) {
  await fetch('/sessions/' + id + '/approve-tool', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toolUseID }) });
  // SSE session_status event will update the detail panel
}

async function rejectToolUse(id, toolUseID, btn) {
  const reason = btn?.previousElementSibling?.value?.trim() || '';
  const body = reason ? { toolUseID, reason } : { toolUseID };
  await fetch('/sessions/' + id + '/reject-tool', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  // SSE session_status event will update the detail panel
}

async function approveJob(id) {
  const model = approvalModels[id];
  const opts = model
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) }
    : { method: 'POST' };
  await fetch('/sessions/' + id + '/approve', opts);
  // SSE session_status event will deliver the transition and scroll to bottom
}

async function rejectJob(id) {
  await fetch('/sessions/' + id + '/reject', { method: 'POST' });
  // SSE session_status event will deliver the transition and scroll to bottom
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
    await fetch('/sessions/' + id + '/revise', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body)
    });
    ta.value = '';
    (reviseImages[id] || []).forEach(img => URL.revokeObjectURL(img.objectUrl));
    delete reviseImages[id];
    selectedId = id;
    const refreshed = await fetch('/sessions/' + id).then(r => r.json()).catch(err => { console.warn('[requestChanges] failed to refresh session:', err); return null; });
    if (refreshed) {
      sessions[id] = refreshed;
      renderDetailFresh = true;
      renderDetail(refreshed);
    }
    // SSE will deliver subsequent chat_entry and session_status events
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
    await fetch('/sessions/' + id + '/followup', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body)
    });
    ta.value = '';
    // clean up follow-up image previews
    (followupImages[id] || []).forEach(img => URL.revokeObjectURL(img.objectUrl));
    delete followupImages[id];
    selectedId = id;
    // Refresh the detail view immediately so the user prompt appears without waiting for SSE.
    const refreshed = await fetch('/sessions/' + id).then(r => r.json()).catch(err => { console.warn('[sendFollowUp] failed to refresh session:', err); return null; });
    if (refreshed) {
      sessions[id] = refreshed;
      renderDetailFresh = true;
      renderDetail(refreshed);
    }
    // SSE will deliver subsequent chat_entry and session_status events
  } finally {
    btn.disabled = false; btn.textContent = 'Send Follow-up';
  }
}

async function submitJob() {
  const prompt = document.getElementById('prompt').value.trim();
  if (!prompt) return;
  const cwdSel = document.getElementById('cwd-select');
  const cwdVal = cwdSel.value === '__new__'
    ? document.getElementById('cwd-custom').value.trim()
    : cwdSel.value;
  const useWorktree = document.getElementById('use-worktree').checked;
  const body = cwdVal ? {prompt, cwd: cwdVal, useWorktree, mode: currentMode, model: currentModel, effort: currentEffort, sandbox: currentSandbox} : {prompt, useWorktree, mode: currentMode, model: currentModel, effort: currentEffort, sandbox: currentSandbox};
  if (pendingFiles.length) {
    body.images = pendingFiles.map(({ mediaType, data }) => ({ mediaType, data }));
  }
  const btn = document.getElementById('submit-btn');
  btn.disabled = true; btn.textContent = 'Submitting...';
  try {
    const res = await fetch('/sessions', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const { id } = await res.json();
    document.getElementById('prompt').value = '';
    // clear file attachments
    pendingFiles.forEach(f => URL.revokeObjectURL(f.objectUrl));
    pendingFiles = [];
    renderFilePreviews();
    selectedId = id;
    // Fetch and show the new session immediately; SSE will deliver all subsequent updates
    const session = await fetch('/sessions/' + id).then(r => r.json()).catch(() => null);
    if (session) {
      sessions[id] = session;
      document.getElementById('new-task-panel').classList.add('hidden');
      document.getElementById('detail').classList.remove('hidden');
      renderDetailFresh = true; renderDetail(session); if (isMobile()) showMobilePanel('detail');
    }
  } finally {
    btn.disabled = false; btn.textContent = 'Run Agent';
  }
}

document.getElementById('prompt').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitJob();
});

document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'o') {
    e.preventDefault();
    showNewTask();
    return;
  }
  if (e.key === 'Tab' && e.shiftKey) {
    e.preventDefault();
    const modes = ['auto', 'plan', 'edit'];
    const next = modes[(modes.indexOf(currentMode) + 1) % modes.length];
    setMode(next);
  }
});
document.getElementById('prompt').addEventListener('paste', async (e) => {
  await handlePastedFiles(e, pendingFiles, renderFilePreviews);
});

window.addEventListener('resize', () => {
  const main = document.querySelector('.main');
  const active = isMobile() && mobileView === 'detail' && selectedId;
  main.classList.toggle('mobile-detail-active', !!active);
  document.body.classList.toggle('mobile-detail-active', !!active);
});

// Eagerly show the detail panel if a job hash is in the URL, to avoid the
// flash of the new-task form before the SSE snapshot arrives.
if (location.hash.slice(1)) {
  document.getElementById('new-task-panel').classList.add('hidden');
  document.getElementById('detail').classList.remove('hidden');
}

initSSE();
