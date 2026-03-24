let selectedId = null;
let jobs = {};

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
      ${j.cwd ? `<div style="font-size:10px;color:#555;font-family:monospace;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(j.cwd)}</div>` : ''}
    </div>
  `).join('');
}

function toolDetail(name, input) {
  if (!input) return '';
  let detail = '';
  if (name === 'Glob') detail = input.pattern ?? '';
  else if (name === 'Bash') detail = input.description || (input.command ? String(input.command).slice(0, 80) : '');
  else detail = Object.values(input).find(v => typeof v === 'string') ?? '';
  return detail ? ` <span style="opacity:0.6;font-weight:400">${escHtml(String(detail))}</span>` : '';
}

function renderDetail(job) {
  if (!job) { document.getElementById('detail').innerHTML = '<div class="detail-empty">Select a job to see details</div>'; return; }
  const started = job.startedAt ? new Date(job.startedAt).toLocaleTimeString() : '—';
  const finished = job.finishedAt ? new Date(job.finishedAt).toLocaleTimeString() : '—';
  const logHtml = job.log.map(e =>
    e.type === 'text'
      ? `<div class="log-text">${escHtml(e.text)}</div>`
      : `<div class="log-tool">${escHtml(e.name)}${toolDetail(e.name, e.input)}</div>`
  ).join('');
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
        <textarea id="followup-prompt-${job.id}" placeholder="Ask a follow-up question..." rows="2"></textarea>
        <button class="btn-followup" id="followup-btn-${job.id}" onclick="sendFollowUp('${job.id}')">Send Follow-up</button>
      </div>`
    : '';
  document.getElementById('detail').innerHTML = `
    <div class="detail-header">
      <div class="detail-prompt">${escHtml(job.prompt)}</div>
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
  if (feed) feed.scrollTop = feed.scrollHeight;
  const followupTa = document.getElementById('followup-prompt-' + job.id);
  if (followupTa) {
    followupTa.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendFollowUp(job.id);
    });
  }
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function selectJob(id) {
  selectedId = id;
  document.querySelectorAll('.job-item').forEach(el => el.classList.toggle('selected', el.onclick.toString().includes(id)));
  const job = await fetch('/jobs/' + id).then(r => r.json());
  jobs[id] = job;
  renderDetail(job);
}

async function poll() {
  const list = await fetch('/jobs').then(r => r.json()).catch(() => []);
  list.forEach(j => { if (!jobs[j.id] || jobs[j.id].status !== j.status) jobs[j.id] = j; });
  renderList(list);
  if (selectedId && jobs[selectedId] && ['pending','planning','awaiting_approval','running'].includes(jobs[selectedId].status)) {
    const job = await fetch('/jobs/' + selectedId).then(r => r.json()).catch(() => null);
    if (job) { jobs[selectedId] = job; renderDetail(job); }
  }
}

async function approveJob(id) {
  await fetch('/jobs/' + id + '/approve', { method: 'POST' });
  const job = await fetch('/jobs/' + id).then(r => r.json());
  jobs[id] = job;
  renderDetail(job);
}

async function rejectJob(id) {
  await fetch('/jobs/' + id + '/reject', { method: 'POST' });
  const job = await fetch('/jobs/' + id).then(r => r.json());
  jobs[id] = job;
  renderDetail(job);
}

async function sendFollowUp(id) {
  const ta = document.getElementById('followup-prompt-' + id);
  const btn = document.getElementById('followup-btn-' + id);
  const prompt = ta.value.trim();
  if (!prompt) return;
  btn.disabled = true; btn.textContent = 'Sending...';
  try {
    await fetch('/jobs/' + id + '/followup', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ prompt })
    });
    ta.value = '';
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
  const btn = document.getElementById('submit-btn');
  btn.disabled = true; btn.textContent = 'Submitting...';
  try {
    const res = await fetch('/jobs', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const job = await res.json();
    document.getElementById('prompt').value = '';
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
