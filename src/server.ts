import { query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import * as store from "./store.ts";

const LOGS_DIR = "./logs";
await mkdir(LOGS_DIR, { recursive: true });

const UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Agents Orchestrator</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #0f0f0f; color: #e0e0e0; height: 100vh; display: flex; flex-direction: column; }
  header { padding: 12px 20px; border-bottom: 1px solid #2a2a2a; background: #141414; }
  header h1 { font-size: 15px; font-weight: 600; color: #fff; letter-spacing: 0.02em; }
  .create-form { padding: 16px 20px; border-bottom: 1px solid #2a2a2a; background: #141414; display: flex; gap: 10px; align-items: flex-start; }
  .create-form textarea { flex: 1; background: #1e1e1e; border: 1px solid #333; color: #e0e0e0; border-radius: 6px; padding: 8px 10px; font-size: 13px; resize: none; font-family: inherit; min-height: 60px; }
  .create-form textarea:focus { outline: none; border-color: #555; }
  .form-right { display: flex; flex-direction: column; gap: 8px; min-width: 160px; }
  .create-form input[type=text] { background: #1e1e1e; border: 1px solid #333; color: #e0e0e0; border-radius: 6px; padding: 8px 10px; font-size: 12px; font-family: monospace; }
  .create-form input[type=text]:focus { outline: none; border-color: #555; }
  .create-form button { background: #2563eb; color: #fff; border: none; border-radius: 6px; padding: 9px 16px; font-size: 13px; cursor: pointer; font-weight: 500; }
  .create-form button:hover { background: #1d4ed8; }
  .create-form button:disabled { background: #333; color: #666; cursor: default; }
  .main { display: flex; flex: 1; overflow: hidden; }
  .job-list { width: 320px; border-right: 1px solid #2a2a2a; overflow-y: auto; flex-shrink: 0; }
  .job-list-empty { padding: 24px 16px; color: #555; font-size: 13px; text-align: center; }
  .job-item { padding: 12px 16px; border-bottom: 1px solid #1e1e1e; cursor: pointer; }
  .job-item:hover { background: #181818; }
  .job-item.selected { background: #1a2035; }
  .job-item-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
  .job-prompt { font-size: 13px; color: #ccc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200px; }
  .job-time { font-size: 11px; color: #555; flex-shrink: 0; }
  .badge { font-size: 10px; font-weight: 600; padding: 2px 7px; border-radius: 999px; text-transform: uppercase; letter-spacing: 0.05em; }
  .badge-pending { background: #292210; color: #ca8a04; }
  .badge-running { background: #0d2035; color: #38bdf8; }
  .badge-completed { background: #0d2218; color: #22c55e; }
  .badge-failed { background: #2a0d0d; color: #ef4444; }
  .detail { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  .detail-empty { display: flex; align-items: center; justify-content: center; height: 100%; color: #444; font-size: 14px; }
  .detail-header { padding: 14px 20px; border-bottom: 1px solid #2a2a2a; }
  .detail-prompt { font-size: 14px; color: #ddd; line-height: 1.5; margin-bottom: 8px; white-space: pre-wrap; word-break: break-word; }
  .detail-meta { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .detail-meta span { font-size: 11px; color: #555; }
  .log-feed { flex: 1; overflow-y: auto; padding: 14px 20px; display: flex; flex-direction: column; gap: 6px; }
  .log-text { font-size: 13px; color: #c8c8c8; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
  .log-tool { display: inline-flex; align-items: center; gap: 6px; background: #1a1a2e; border: 1px solid #2a2a4a; border-radius: 4px; padding: 3px 10px; font-size: 11px; font-family: monospace; color: #818cf8; align-self: flex-start; }
  .log-tool::before { content: "⚙"; font-size: 10px; }
  .result-box { margin: 0 20px 16px; padding: 10px 14px; border-radius: 6px; font-size: 13px; }
  .result-success { background: #0d2218; border: 1px solid #166534; color: #4ade80; }
  .result-error { background: #2a0d0d; border: 1px solid #7f1d1d; color: #f87171; }
  .spinner { display: inline-block; width: 8px; height: 8px; border: 2px solid #38bdf8; border-top-color: transparent; border-radius: 50%; animation: spin 0.7s linear infinite; margin-right: 6px; vertical-align: middle; }
  @keyframes spin { to { transform: rotate(360deg); } }
  ::-webkit-scrollbar { width: 6px; } ::-webkit-scrollbar-track { background: transparent; } ::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }
</style>
</head>
<body>
<header><h1>Agents Orchestrator</h1></header>
<div class="create-form">
  <textarea id="prompt" placeholder="Enter a prompt for the agent..." rows="3"></textarea>
  <div class="form-right">
    <input type="text" id="tools" value="Read, Edit, Glob" placeholder="Tools (comma-separated)">
    <input type="text" id="cwd" placeholder="Working directory (optional)">
    <button id="submit-btn" onclick="submitJob()">Run Agent</button>
  </div>
</div>
<div class="main">
  <div class="job-list" id="job-list"><div class="job-list-empty">No jobs yet</div></div>
  <div class="detail" id="detail"><div class="detail-empty">Select a job to see details</div></div>
</div>
<script>
let selectedId = null;
let jobs = {};

function relTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return Math.floor(diff/1000) + 's ago';
  if (diff < 3600000) return Math.floor(diff/60000) + 'm ago';
  return Math.floor(diff/3600000) + 'h ago';
}

function badge(status) {
  return \`<span class="badge badge-\${status}">\${status === 'running' ? '<span class="spinner"></span>' : ''}\${status}</span>\`;
}

function renderList(list) {
  const el = document.getElementById('job-list');
  if (!list.length) { el.innerHTML = '<div class="job-list-empty">No jobs yet</div>'; return; }
  el.innerHTML = list.map(j => \`
    <div class="job-item\${selectedId === j.id ? ' selected' : ''}" onclick="selectJob('\${j.id}')">
      <div class="job-item-top">
        \${badge(j.status)}
        <span class="job-time">\${relTime(j.createdAt)}</span>
      </div>
      <div class="job-prompt">\${escHtml(j.prompt)}</div>
      \${j.cwd ? \`<div style="font-size:10px;color:#555;font-family:monospace;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${escHtml(j.cwd)}</div>\` : ''}
    </div>
  \`).join('');
}

function toolDetail(name, input) {
  if (!input) return '';
  let detail = '';
  if (name === 'Glob') detail = input.pattern ?? '';
  else if (name === 'Bash') detail = input.description || (input.command ? String(input.command).slice(0, 80) : '');
  else detail = Object.values(input).find(v => typeof v === 'string') ?? '';
  return detail ? \` <span style="opacity:0.6;font-weight:400">\${escHtml(String(detail))}</span>\` : '';
}

function renderDetail(job) {
  if (!job) { document.getElementById('detail').innerHTML = '<div class="detail-empty">Select a job to see details</div>'; return; }
  const started = job.startedAt ? new Date(job.startedAt).toLocaleTimeString() : '—';
  const finished = job.finishedAt ? new Date(job.finishedAt).toLocaleTimeString() : '—';
  const logHtml = job.log.map(e =>
    e.type === 'text'
      ? \`<div class="log-text">\${escHtml(e.text)}</div>\`
      : \`<div class="log-tool">\${escHtml(e.name)}\${toolDetail(e.name, e.input)}</div>\`
  ).join('');
  const resultHtml = job.result
    ? \`<div class="result-box result-success">Result: \${escHtml(job.result)}</div>\`
    : job.error
    ? \`<div class="result-box result-error">Error: \${escHtml(job.error)}</div>\`
    : '';
  document.getElementById('detail').innerHTML = \`
    <div class="detail-header">
      <div class="detail-prompt">\${escHtml(job.prompt)}</div>
      <div class="detail-meta">
        \${badge(job.status)}
        <span>Started: \${started}</span>
        <span>Finished: \${finished}</span>
        <span>Tools: \${job.tools.join(', ')}</span>
        \${job.cwd ? \`<span style="font-family:monospace">cwd: \${escHtml(job.cwd)}</span>\` : ''}
      </div>
    </div>
    <div class="log-feed" id="log-feed">\${logHtml || '<span style="color:#444;font-size:13px">No log entries yet</span>'}</div>
    \${resultHtml}
  \`;
  const feed = document.getElementById('log-feed');
  if (feed) feed.scrollTop = feed.scrollHeight;
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
  if (selectedId && jobs[selectedId] && ['pending','running'].includes(jobs[selectedId].status)) {
    const job = await fetch('/jobs/' + selectedId).then(r => r.json()).catch(() => null);
    if (job) { jobs[selectedId] = job; renderDetail(job); }
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
</script>
</body>
</html>
`;

const DEFAULT_TOOLS = ["Read", "Edit", "Glob"];
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "localhost";

async function runJob(id: string, prompt: string, tools: string[], cwd: string | null): Promise<void> {
  store.setStatus(id, "running");
  try {
    for await (const message of query({
      prompt,
      options: {
        allowedTools: tools,
        permissionMode: "acceptEdits",
        ...(cwd ? { cwd } : {}),
      },
    })) {
      const ts = new Date().toISOString();
      await appendFile(`${LOGS_DIR}/${id}.ndjson`, JSON.stringify({ ts, ...message }) + "\n");
      if (message.type === "assistant" && message.message?.content) {
        for (const block of message.message.content) {
          if ("text" in block) {
            store.appendLog(id, { type: "text", text: block.text, ts });
          } else if ("name" in block) {
            store.appendLog(id, { type: "tool_call", name: block.name, input: (block as any).input, ts });
          }
        }
      } else if (message.type === "result") {
        store.setResult(id, message.subtype);
      }
    }
    store.setStatus(id, "completed");
  } catch (err) {
    store.setError(id, err instanceof Error ? err.message : String(err));
    store.setStatus(id, "failed");
  }
}

function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonError(status: number, message: string): Response {
  return json(status, { error: message });
}

Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "GET" && path === "/") {
      return new Response(UI_HTML, { headers: { "Content-Type": "text/html" } });
    }

    if (req.method === "GET" && path === "/jobs") {
      return json(200, store.listJobs());
    }

    if (req.method === "POST" && path === "/jobs") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return jsonError(400, "Invalid JSON body");
      }

      if (typeof body !== "object" || body === null) {
        return jsonError(400, "Body must be a JSON object");
      }
      const b = body as Record<string, unknown>;
      if (typeof b["prompt"] !== "string" || b["prompt"].trim() === "") {
        return jsonError(400, "prompt must be a non-empty string");
      }
      const prompt = b["prompt"].trim();
      let tools = DEFAULT_TOOLS;
      if ("tools" in b) {
        if (!Array.isArray(b["tools"]) || !b["tools"].every((t) => typeof t === "string")) {
          return jsonError(400, "tools must be an array of strings");
        }
        tools = b["tools"] as string[];
      }

      let cwd: string | null = null;
      if ("cwd" in b) {
        if (typeof b["cwd"] !== "string") {
          return jsonError(400, "cwd must be a string");
        }
        cwd = b["cwd"];
      }

      const id = randomUUID();
      store.createJob(id, prompt, tools, cwd);
      Promise.resolve().then(() => runJob(id, prompt, tools, cwd));

      return json(202, { id, status: "pending" });
    }

    const jobMatch = path.match(/^\/jobs\/([^/]+)$/);
    if (req.method === "GET" && jobMatch) {
      const id = jobMatch[1]!;
      const job = store.getJob(id);
      if (!job) return jsonError(404, "Job not found");
      return json(200, job);
    }

    return jsonError(404, "Not found");
  },
});

console.log(`Listening on http://${HOST}:${PORT}`);
