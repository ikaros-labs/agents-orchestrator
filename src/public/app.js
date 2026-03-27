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
  document.querySelectorAll('.job-item').forEach(el => el.classList.remove('selected'));
  document.getElementById('new-task-panel').classList.remove('hidden');
  document.getElementById('detail').classList.add('hidden');
  document.getElementById('prompt').focus();
  if (isMobile()) showMobilePanel('detail');
}

let jobs = {};
let renderDetailFresh = false; // when true, next renderDetail call always scrolls to bottom
let currentMode = 'auto';
let currentModel = 'claude-sonnet-4-6';
let currentEffort = 'high';
let showArchived = false;

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

function setEffort(effort) {
  currentEffort = effort;
  document.querySelectorAll('#effort-selector .mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.effort === effort);
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

// ── Job list ───────────────────────────────────────────────────────────────
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
      ${archivedBtn}`;
  }

  const visible = showArchived ? list : list.filter(j => !j.archived);
  const el = document.getElementById('job-list');
  if (!visible.length) {
    el.innerHTML = `<div class="job-list-empty">${list.length && !showArchived ? 'No active jobs' : 'No jobs yet'}</div>`;
    return;
  }
  el.innerHTML = visible.map(j => `
    <div class="job-item${selectedId === j.id ? ' selected' : ''}${j.archived ? ' archived' : ''}" onclick="selectJob('${j.id}')">
      <div class="job-item-top">
        ${badge(j.status)}
        ${j.mode && j.mode !== 'auto' ? `<span class="mode-tag mode-tag-${j.mode}">${j.mode}</span>` : ''}
        ${j.model && j.model !== 'claude-sonnet-4-6' ? `<span class="mode-tag mode-tag-${j.model === 'claude-haiku-4-5-20251001' ? 'haiku' : 'opus'}">${j.model === 'claude-haiku-4-5-20251001' ? 'haiku' : 'opus'}</span>` : ''}
        ${j.effort && j.effort !== 'high' ? `<span class="mode-tag mode-tag-${j.effort}">${j.effort}</span>` : ''}
        <span class="job-time">${relTime(j.createdAt)}</span>
      </div>
      <div class="job-prompt">${escHtml(j.title || j.prompt)}</div>
      ${j.images && j.images.length ? `<div class="job-image-badge">📎 ${j.images.length} file${j.images.length > 1 ? 's' : ''}</div>` : ''}
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
  return `<div class="log-todo">${items}</div>`;
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

  return `<details class="log-tool-bash">
    <summary class="log-tool">Bash <span class="tool-detail">${summary}</span></summary>
    <div class="tool-expand-body">${bodyHtml}</div>
  </details>`;
}

function renderLogEntry(e, cwd) {
  if (e.type === 'user') {
    return `<div class="log-user">${escHtml(e.text)}</div>`;
  }
  if (e.type === 'text') {
    return `<div class="log-text markdown-body">${md(e.text)}</div>`;
  }
  if (e.type === 'tool_call') {
    if (e.name === 'ExitPlanMode') return '';
    if (e.name === 'TodoWrite') return renderTodoWrite(e.input?.todos);
    if (e.name === 'Bash') return renderBashTool(e);
    return `<div class="log-tool">${escHtml(e.name)}${toolDetail(e.name, e.input, cwd)}</div>`;
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
      <input type="text" id="${name}_other" placeholder="Type a custom answer…" value="${escHtml(otherText)}">
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
    <div class="question-bar-header">
      <span class="question-bar-label">Clarifying questions</span>
      <span class="question-bar-title">Claude needs your input to continue</span>
    </div>
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

async function answerQuestion(id) {
  const job = jobs[id];
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
    await fetch(`/jobs/${id}/answer-question`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers }),
    });
    delete questionAnswers[id];
    const refreshed = await fetch('/jobs/' + id).then(r => r.json()).catch(err => { console.warn('[answerQuestion] failed to refresh job:', err); return null; });
    if (refreshed) { jobs[id] = refreshed; renderDetailFresh = true; renderDetail(refreshed); }
    // SSE will deliver subsequent log_entry and job_status events
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Submit Answers'; }
  }
}

function renderDetail(job) {
  if (!job) { document.getElementById('detail').innerHTML = '<div class="detail-empty">Select a job to see details</div>'; return; }
  const started = job.startedAt ? new Date(job.startedAt).toLocaleTimeString() : '—';
  const finished = job.finishedAt ? new Date(job.finishedAt).toLocaleTimeString() : '—';
  const logHtml = job.log.map(e => renderLogEntry(e, job.worktreePath ?? job.cwd)).join('');
  const initialEntryHtml = `<div class="log-user">${escHtml(job.prompt)}</div>${renderInputImages(job)}`;
  const planCardHtml = (job.status === 'awaiting_approval' && job.plan)
    ? `<div class="plan-card">
        <div class="plan-card-header">Plan</div>
        <div class="plan-card-body markdown-body">${md(job.plan)}</div>
      </div>`
    : '';
  const feedHtml = initialEntryHtml + logHtml;
  const resultHtml = job.result
    ? `<div class="result-box result-success markdown-body">${md(job.result)}</div>`
    : job.error
    ? `<div class="result-box result-error">${escHtml(job.error)}</div>`
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
  // Snapshot BEFORE renderQuestionBar so it can restore the fresh selections
  _snapshotQuestionAnswers(job);
  const questionBarHtml = renderQuestionBar(job);
  const pendingToolsList = job.status === 'awaiting_tool_approval'
    ? (job.pendingTools ?? []).filter(t => t.name !== 'AskUserQuestion')
    : [];
  const toolApprovalBarHtml = pendingToolsList.length > 0
    ? pendingToolsList.map(tool => {
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
      }).join('')
    : '';
  const followupBarHtml = ((job.status === 'completed' || job.status === 'failed') && job.sessionId) || job.status === 'stopped'
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

  const NOT_STOPPABLE = new Set(['awaiting_approval', 'completed', 'failed', 'stopped']);
  const stopBtnHtml = !NOT_STOPPABLE.has(job.status)
    ? `<button class="btn-stop" onclick="stopJob('${job.id}')">Stop</button>`
    : '';
  const archiveBtnHtml = job.archived
    ? `<button class="btn-archive active" onclick="unarchiveJob('${job.id}')">Unarchive</button>`
    : `<button class="btn-archive" onclick="archiveJob('${job.id}')">Archive</button>`;
  document.getElementById('detail').innerHTML = `
    <div class="detail-header">
      <button class="mobile-back-btn" onclick="goBack()">&#8592; Back</button>
      <div class="detail-meta">
        ${badge(job.status)}
        <span>Started: ${started}</span>
        <span>Finished: ${finished}</span>
        <span>Tools: ${job.tools.join(', ')}</span>
        ${job.cwd ? `<span style="font-family:monospace">cwd: ${escHtml(job.cwd)}</span>` : ''}
        ${job.worktreePath ? `<span style="font-family:monospace;color:#6b9eff" title="Isolated worktree created for this job">worktree: ${escHtml(job.worktreePath)}</span>` : ''}
        ${job.usage ? `<span title="Token and cost usage for this job">$${job.usage.costUSD.toFixed(1)} · ${job.usage.totalTokens.toLocaleString()} tokens (${(job.usage.totalTokens / 200000 * 100).toFixed(1)}%)</span>` : ''}
        <div class="detail-actions">${stopBtnHtml}${archiveBtnHtml}</div>
      </div>
    </div>
    <div class="log-feed" id="log-feed">${feedHtml}</div>
    ${planCardHtml}
    ${resultHtml}
    ${questionBarHtml}
    ${approveBarHtml}
    ${toolApprovalBarHtml}
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
  document.querySelectorAll('.job-item').forEach(el => el.classList.toggle('selected', el.onclick.toString().includes(id)));
  document.getElementById('new-task-panel').classList.add('hidden');
  document.getElementById('detail').classList.remove('hidden');
  const job = await fetch('/jobs/' + id).then(r => r.json());
  jobs[id] = job;
  renderDetailFresh = true; // fresh view, always scroll to bottom
  renderDetail(job);
  if (isMobile()) showMobilePanel('detail');
}

// ── SSE real-time updates ───────────────────────────────────────────────────

/** Sort jobs by latest user-message time, mirroring the server's listJobs() order. */
function _latestUserMsgTime(job) {
  const times = (job.log || []).filter(e => e.type === 'user').map(e => new Date(e.ts).getTime());
  return Math.max(new Date(job.createdAt).getTime(), ...times, 0);
}
function getSortedJobs() {
  return Object.values(jobs).sort((a, b) => _latestUserMsgTime(b) - _latestUserMsgTime(a));
}

/**
 * Append a single log entry to the visible #log-feed without rebuilding the
 * entire detail panel. Only runs when jobId === selectedId and the feed exists.
 * When index is provided, updates an existing element if present (for patches like Bash output).
 */
function appendLogEntryDOM(entry, jobId, index) {
  if (jobId !== selectedId) return;
  const feed = document.getElementById('log-feed');
  if (!feed) return;
  let html = renderLogEntry(entry, jobs[jobId]?.worktreePath ?? jobs[jobId]?.cwd);
  if (!html) return;
  // Inject data-log-index into the root element so we can find it for updates
  if (index !== undefined) {
    html = html.replace(/^(<\w+)/, `$1 data-log-index="${index}"`);
  }
  // If element with this index already exists, update it in-place
  if (index !== undefined) {
    const existing = feed.querySelector(`[data-log-index="${index}"]`);
    if (existing) {
      const wasOpen = existing.tagName === 'DETAILS' ? existing.open : existing.querySelector('details')?.open;
      existing.outerHTML = html;
      if (wasOpen) {
        const updated = feed.querySelector(`[data-log-index="${index}"]`);
        const details = updated?.tagName === 'DETAILS' ? updated : updated?.querySelector('details');
        if (details) details.open = true;
      }
      return;
    }
  }
  // Remove the "No log entries yet" placeholder on first real entry
  if (!feed.querySelector('.log-text, .log-user, .log-tool, .log-image, .log-tool-bash')) {
    feed.innerHTML = '';
  }
  const wasAtBottom = (feed.scrollHeight - feed.clientHeight - feed.scrollTop) <= 80;
  feed.insertAdjacentHTML('beforeend', html);
  if (wasAtBottom) feed.scrollTop = feed.scrollHeight;
}

function initSSE() {
  const es = new EventSource('/events');

  // Initial snapshot: full current state of all jobs (sent on every connect/reconnect)
  es.addEventListener('snapshot', e => {
    const list = JSON.parse(e.data);
    list.forEach(j => { jobs[j.id] = j; });
    renderList(list); // already server-sorted
    updateCwdSelect(list);
    if (selectedId && jobs[selectedId]) renderDetail(jobs[selectedId]);
  });

  // A brand-new job was created
  es.addEventListener('job_created', e => {
    const { job } = JSON.parse(e.data);
    jobs[job.id] = job;
    const sorted = getSortedJobs();
    renderList(sorted);
    updateCwdSelect(sorted);
    if (selectedId === job.id) {
      renderDetailFresh = true;
      renderDetail(job);
    }
  });

  // Job metadata changed: status, result, error, plan, pendingTools, timestamps, archived
  es.addEventListener('job_status', e => {
    const data = JSON.parse(e.data);
    const { jobId, status, startedAt, finishedAt, result, error, plan, sessionId, pendingTools, archived, usage, title } = data;
    const job = jobs[jobId];
    if (!job) return;
    const prevStatus = job.status;
    Object.assign(job, { status, startedAt, finishedAt, result, error, plan, sessionId, pendingTools, archived, usage, title });
    renderList(getSortedJobs());
    if (jobId === selectedId) {
      if (prevStatus !== status) renderDetailFresh = true;
      renderDetail(job);
    }
  });

  // A new log entry was appended — stream it directly into the feed DOM
  es.addEventListener('log_entry', e => {
    const { jobId, entry, index } = JSON.parse(e.data);
    const job = jobs[jobId];
    if (!job) return;
    // Keep the local log array in sync (sparse-safe)
    while (job.log.length <= index) job.log.push(null);
    job.log[index] = entry;
    appendLogEntryDOM(entry, jobId, index);
    // Re-sort sidebar when a new user message arrives (followup changes sort key)
    if (entry.type === 'user') renderList(getSortedJobs());
  });

  es.onerror = () => {
    // EventSource auto-reconnects; the snapshot event on reconnect re-bootstraps state
    console.warn('[SSE] connection lost, reconnecting…');
  };
}

async function stopJob(id) {
  await fetch('/jobs/' + id + '/stop', { method: 'POST' });
  // SSE job_status event will update the detail panel
}

async function archiveJob(id) {
  await fetch('/jobs/' + id + '/archive', { method: 'POST' });
  // SSE job_status event will update the detail panel and list
}

async function unarchiveJob(id) {
  await fetch('/jobs/' + id + '/unarchive', { method: 'POST' });
  // SSE job_status event will update the detail panel and list
}

async function approveToolUse(id, toolUseID) {
  await fetch('/jobs/' + id + '/approve-tool', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toolUseID }) });
  // SSE job_status event will update the detail panel
}

async function rejectToolUse(id, toolUseID, btn) {
  const reason = btn?.previousElementSibling?.value?.trim() || '';
  const body = reason ? { toolUseID, reason } : { toolUseID };
  await fetch('/jobs/' + id + '/reject-tool', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  // SSE job_status event will update the detail panel
}

async function approveJob(id) {
  await fetch('/jobs/' + id + '/approve', { method: 'POST' });
  // SSE job_status event will deliver the transition and scroll to bottom
}

async function rejectJob(id) {
  await fetch('/jobs/' + id + '/reject', { method: 'POST' });
  // SSE job_status event will deliver the transition and scroll to bottom
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
    const refreshed = await fetch('/jobs/' + id).then(r => r.json()).catch(err => { console.warn('[requestChanges] failed to refresh job:', err); return null; });
    if (refreshed) {
      jobs[id] = refreshed;
      renderDetailFresh = true;
      renderDetail(refreshed);
    }
    // SSE will deliver subsequent log_entry and job_status events
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
    // Refresh the detail view immediately so the user prompt appears without waiting for SSE.
    const refreshed = await fetch('/jobs/' + id).then(r => r.json()).catch(err => { console.warn('[sendFollowUp] failed to refresh job:', err); return null; });
    if (refreshed) {
      jobs[id] = refreshed;
      renderDetailFresh = true;
      renderDetail(refreshed);
    }
    // SSE will deliver subsequent log_entry and job_status events
  } finally {
    btn.disabled = false; btn.textContent = 'Send Follow-up';
  }
}

async function submitJob() {
  const prompt = document.getElementById('prompt').value.trim();
  if (!prompt) return;
  const toolsRaw = document.getElementById('tools').value.trim();
  const tools = toolsRaw ? toolsRaw.split(',').map(s => s.trim()).filter(Boolean) : ['Read','Edit','Glob'];
  const cwdSel = document.getElementById('cwd-select');
  const cwdVal = cwdSel.value === '__new__'
    ? document.getElementById('cwd-custom').value.trim()
    : cwdSel.value;
  const useWorktree = document.getElementById('use-worktree').checked;
  const body = cwdVal ? {prompt, tools, cwd: cwdVal, useWorktree, mode: currentMode, model: currentModel, effort: currentEffort} : {prompt, tools, useWorktree, mode: currentMode, model: currentModel, effort: currentEffort};
  if (pendingFiles.length) {
    body.images = pendingFiles.map(({ mediaType, data }) => ({ mediaType, data }));
  }
  const btn = document.getElementById('submit-btn');
  btn.disabled = true; btn.textContent = 'Submitting...';
  try {
    const res = await fetch('/jobs', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const { id } = await res.json();
    document.getElementById('prompt').value = '';
    // clear file attachments
    pendingFiles.forEach(f => URL.revokeObjectURL(f.objectUrl));
    pendingFiles = [];
    renderFilePreviews();
    selectedId = id;
    // Fetch and show the new job immediately; SSE will deliver all subsequent updates
    const job = await fetch('/jobs/' + id).then(r => r.json()).catch(() => null);
    if (job) {
      jobs[id] = job;
      document.getElementById('new-task-panel').classList.add('hidden');
      document.getElementById('detail').classList.remove('hidden');
      renderDetailFresh = true; renderDetail(job); if (isMobile()) showMobilePanel('detail');
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

initSSE();
