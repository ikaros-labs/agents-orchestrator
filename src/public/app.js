let selectedId = null;
let mobileView = "sidebar";
function isMobile() {
  return window.matchMedia("(max-width: 768px)").matches;
}
function showMobilePanel(view) {
  mobileView = view;
  const isDetail = view === "detail";
  document
    .querySelector(".main")
    .classList.toggle("mobile-detail-active", isDetail);
  document.body.classList.toggle("mobile-detail-active", isDetail);
}
function goBack() {
  showMobilePanel("sidebar");
}

function showNewTask() {
  selectedId = null;
  history.replaceState(null, "", location.pathname);
  document
    .querySelectorAll(".session-item")
    .forEach((el) => el.classList.remove("selected"));
  document.getElementById("new-task-panel").classList.remove("hidden");
  document.getElementById("detail").classList.add("hidden");
  document.getElementById("prompt").focus();
  if (isMobile()) showMobilePanel("detail");
}

const sessions = {};
let renderDetailFresh = false; // when true, next renderDetail call always scrolls to bottom
let currentMode = "auto";
let currentModel = "claude-sonnet-4-6";
let currentEffort = "high";
let currentSandbox = "sandbox";
let showArchived = false;
let archivedCount = 0;
const approvalModels = {}; // sessionId → model selected for execution at approval time
let slashCommands = []; // { name, description, argumentHint }

// ── File browser state ──────────────────────────────────────────────────────
let activeDetailTab = "chat"; // "chat" | "files"
const fileTreeCache = {}; // sessionId → { [dirPath]: entries[] }
const expandedDirs = {}; // sessionId → Set of expanded dir paths
let selectedFile = null; // { sessionId, path }

// ── File attachment state ───────────────────────────────────────────────────
let pendingFiles = []; // { mediaType, data, objectUrl, name }

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result.split(",")[1]); // strip data-URL prefix
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Clipboard paste only handles images — browsers don't support pasting arbitrary files
async function handlePastedFiles(e, fileArray, renderFn) {
  const items = Array.from(e.clipboardData?.items || []);
  const imageItems = items.filter(
    (item) => item.kind === "file" && item.type.startsWith("image/"),
  );
  if (imageItems.length === 0) return; // nothing to do — let default paste proceed
  e.preventDefault(); // stop browser from inserting raw image data as text
  for (const item of imageItems) {
    const file = item.getAsFile();
    if (!file) continue;
    try {
      const data = await fileToBase64(file);
      fileArray.push({
        mediaType: file.type,
        data,
        objectUrl: URL.createObjectURL(file),
        name: file.name,
      });
    } catch {
      /* skip unreadable items */
    }
  }
  renderFn();
}

document.getElementById("image-input").addEventListener("change", async (e) => {
  for (const file of Array.from(e.target.files)) {
    try {
      const data = await fileToBase64(file);
      pendingFiles.push({
        mediaType: file.type,
        data,
        objectUrl: URL.createObjectURL(file),
        name: file.name,
      });
    } catch {
      /* skip unreadable files */
    }
  }
  e.target.value = ""; // reset so same file can be re-added after removal
  renderFilePreviews();
});

function filePreviewHtml(f, onclickExpr) {
  const preview = f.mediaType.startsWith("image/")
    ? `<img src="${escHtml(f.objectUrl)}" alt="Attached file">`
    : `<div class="file-chip">${escHtml(f.name)}</div>`;
  return `<div class="img-preview-item">${preview}<button class="img-remove-btn" onclick="${onclickExpr}" title="Remove">×</button></div>`;
}

function renderFilePreviews() {
  const el = document.getElementById("image-previews");
  if (!el) return;
  el.innerHTML = pendingFiles
    .map((f, i) => filePreviewHtml(f, `removePendingFile(${i})`))
    .join("");
}

function removePendingFile(index) {
  URL.revokeObjectURL(pendingFiles[index].objectUrl);
  pendingFiles.splice(index, 1);
  renderFilePreviews();
}

// ── Notification sounds ─────────────────────────────────────────────────────
function playSound(type) {
  if (localStorage.getItem("soundsMuted") === "true") return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    function beep(freq, startTime, duration, vol = 0.12) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.connect(g);
      g.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0, startTime);
      g.gain.linearRampToValueAtTime(vol, startTime + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
      osc.start(startTime);
      osc.stop(startTime + duration + 0.02);
    }
    const t = ctx.currentTime;
    if (type === "attention") {
      beep(660, t, 0.12);
      beep(880, t + 0.14, 0.12);
    } else if (type === "success") {
      beep(523, t, 0.09);
      beep(659, t + 0.1, 0.09);
      beep(784, t + 0.2, 0.14);
    } else if (type === "failure") {
      beep(330, t, 0.12, 0.11);
      beep(220, t + 0.14, 0.18, 0.09);
    }
    setTimeout(() => ctx.close(), 700);
  } catch (e) {
    /* ignore audio errors */
  }
}

function toggleMute() {
  const muted = localStorage.getItem("soundsMuted") === "true";
  localStorage.setItem("soundsMuted", String(!muted));
  updateMuteBtn();
}

function updateMuteBtn() {
  const btn = document.getElementById("mute-btn");
  if (!btn) return;
  const muted = localStorage.getItem("soundsMuted") === "true";
  btn.title = muted
    ? "Sounds muted — click to enable"
    : "Sounds on — click to mute";
  btn.classList.toggle("muted", muted);
  btn.innerHTML = muted
    ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`
    : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function relTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return Math.floor(diff / 1000) + "s ago";
  if (diff < 3600000) return Math.floor(diff / 60000) + "m ago";
  return Math.floor(diff / 3600000) + "h ago";
}

// Statuses that display an animated spinner in the badge
const SPINNER_STATUSES = new Set(["running", "planning"]);

function badge(status) {
  const labels = {
    awaiting_approval: "needs approval",
    awaiting_tool_approval: "⚠ tool approval",
    awaiting_user_question: "⚠ question",
    stopped: "stopped",
  };
  const label = labels[status] ?? status;
  const spinner = SPINNER_STATUSES.has(status)
    ? '<span class="spinner"></span>'
    : "";
  return `<span class="badge badge-${status}">${spinner}${label}</span>`;
}

function setMode(mode) {
  currentMode = mode;
  document.querySelectorAll("#mode-selector .mode-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });
}

function setModel(model) {
  currentModel = model;
  document.querySelectorAll("#model-selector .mode-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.model === model);
  });
}

function setApprovalModel(id, model) {
  approvalModels[id] = model;
  document
    .querySelectorAll(`.approval-model-btn[data-session="${id}"]`)
    .forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.model === model);
    });
}

function setEffort(effort) {
  currentEffort = effort;
  document.querySelectorAll("#effort-selector .mode-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.effort === effort);
  });
}

function setSandbox(sandbox) {
  currentSandbox = sandbox;
  document.querySelectorAll("#sandbox-selector .mode-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.sandbox === sandbox);
  });
}

function onCwdSelectChange() {
  const sel = document.getElementById("cwd-select");
  if (sel.value === "__new__") openFolderBrowser();
}

function updateCwdSelect(list) {
  const sel = document.getElementById("cwd-select");
  const seen = new Set();
  const dirs = [];
  for (const j of list) {
    if (j.cwd && !j.cwd.includes("/.agent-orchestrator/worktrees/") && !seen.has(j.cwd)) {
      seen.add(j.cwd);
      dirs.push(j.cwd);
    }
  }
  const current = sel.value;
  Array.from(sel.options).forEach((o) => {
    if (o.value !== "" && o.value !== "__new__") o.remove();
  });
  const addNewOpt = sel.querySelector('option[value="__new__"]');
  dirs.forEach((dir) => {
    const opt = document.createElement("option");
    opt.value = dir;
    opt.textContent = displayPath(dir);
    sel.insertBefore(opt, addNewOpt);
  });
  if (current && current !== "__new__" && Array.from(sel.options).some((o) => o.value === current)) {
    sel.value = current;
  } else if ((!current || current === "__new__") && dirs.length) {
    sel.value = dirs[0];
  }
}

// ── Folder browser ──────────────────────────────────────────────────────────

let fbCurrentPath = "";
let fbShowHidden = false;
let fbFetchGen = 0;
let fbPrevSelectValue = "";
let fbHome = "";

function displayPath(p) {
  if (!fbHome) return p;
  if (p === fbHome) return "~";
  if (p.startsWith(fbHome + "/")) return "~" + p.slice(fbHome.length);
  return p;
}

function openFolderBrowser() {
  const sel = document.getElementById("cwd-select");
  fbPrevSelectValue = sel.value === "__new__" ? "" : sel.value;
  const overlay = document.getElementById("folder-browser-overlay");
  overlay.style.display = "";
  fbShowHidden = false;
  document.getElementById("fb-show-hidden").checked = false;
  fetchBrowse(fbPrevSelectValue || "");
}

function closeFolderBrowser() {
  document.getElementById("folder-browser-overlay").style.display = "none";
  // If user cancelled without selecting, revert select to its previous state
  const sel = document.getElementById("cwd-select");
  if (sel.value === "__new__") sel.value = fbPrevSelectValue;
}

function fbOverlayClick(e) {
  if (e.target === e.currentTarget) closeFolderBrowser();
}

async function fetchBrowse(path) {
  const gen = ++fbFetchGen;
  const params = new URLSearchParams();
  if (path) params.set("path", path);
  if (fbShowHidden) params.set("showHidden", "true");
  try {
    const res = await fetch("/browse?" + params).then((r) => r.json());
    if (gen !== fbFetchGen) return;
    fbCurrentPath = res.path;
    renderFbBreadcrumb(res.path);
    renderFbList(res.dirs, res.error);
  } catch {
    // ignore network errors during navigation
  }
}

function renderFbBreadcrumb(fullPath) {
  const el = document.getElementById("fb-breadcrumb");
  const segments = [];

  if (fbHome && (fullPath === fbHome || fullPath.startsWith(fbHome + "/"))) {
    segments.push({ label: "~", path: fbHome });
    const rest = fullPath.slice(fbHome.length).split("/").filter(Boolean);
    rest.forEach((part, i) => {
      segments.push({ label: part, path: fbHome + "/" + rest.slice(0, i + 1).join("/") });
    });
  } else {
    segments.push({ label: "/", path: "/" });
    const parts = fullPath.split("/").filter(Boolean);
    parts.forEach((part, i) => {
      segments.push({ label: part, path: "/" + parts.slice(0, i + 1).join("/") });
    });
  }

  let html = "";
  segments.forEach(({ label, path }, i) => {
    if (i > 0) html += `<span class="fb-breadcrumb-sep">/</span>`;
    html += `<span class="fb-breadcrumb-segment" data-path="${escHtml(path)}">${escHtml(label)}</span>`;
  });
  el.innerHTML = html;
  el.querySelectorAll(".fb-breadcrumb-segment").forEach((seg) => {
    seg.addEventListener("click", () => fetchBrowse(seg.dataset.path));
  });
}

function renderFbList(dirs, error) {
  const el = document.getElementById("fb-list");
  // Preserve any in-progress new-folder input
  const existingInput = el.querySelector(".fb-new-folder-row");
  el.innerHTML = "";
  if (existingInput) el.appendChild(existingInput);

  if (error) {
    const errDiv = document.createElement("div");
    errDiv.className = "fb-error";
    errDiv.textContent = error;
    el.appendChild(errDiv);
  }

  if (fbCurrentPath && fbCurrentPath !== "/") {
    const upItem = document.createElement("div");
    upItem.className = "fb-dir-item";
    upItem.innerHTML = `<span class="fb-dir-icon">📁</span><span class="fb-dir-name">..</span>`;
    upItem.addEventListener("click", () => {
      const parent = fbCurrentPath.replace(/\/[^/]+$/, "") || "/";
      fetchBrowse(parent);
    });
    el.appendChild(upItem);
  }

  if (dirs.length === 0 && !error) {
    const empty = document.createElement("div");
    empty.className = "fb-empty";
    empty.textContent = "No subdirectories";
    el.appendChild(empty);
  }

  for (const dir of dirs) {
    const item = document.createElement("div");
    item.className = "fb-dir-item";
    item.innerHTML = `<span class="fb-dir-icon">📁</span><span class="fb-dir-name">${escHtml(dir)}</span>`;
    const fullPath = (fbCurrentPath === "/" ? "" : fbCurrentPath) + "/" + dir;
    item.addEventListener("click", () => fetchBrowse(fullPath));
    el.appendChild(item);
  }
}


function fbSelectFolder() {
  const sel = document.getElementById("cwd-select");
  // Add the path as an option if it isn't already there
  if (!Array.from(sel.options).some((o) => o.value === fbCurrentPath)) {
    const opt = document.createElement("option");
    opt.value = fbCurrentPath;
    opt.textContent = displayPath(fbCurrentPath);
    sel.insertBefore(opt, sel.querySelector('option[value="__new__"]'));
  }
  sel.value = fbCurrentPath;
  fbPrevSelectValue = fbCurrentPath;
  document.getElementById("folder-browser-overlay").style.display = "none";
}

function fbToggleHidden() {
  fbShowHidden = document.getElementById("fb-show-hidden").checked;
  fetchBrowse(fbCurrentPath);
}

function fbNewFolder() {
  const list = document.getElementById("fb-list");
  if (list.querySelector(".fb-new-folder-row")) return;
  const row = document.createElement("div");
  row.className = "fb-new-folder-row";
  row.innerHTML = `<span class="fb-dir-icon">📁</span><input class="fb-new-folder-input" placeholder="New folder name...">`;
  list.prepend(row);
  const inp = row.querySelector("input");
  inp.focus();
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") fbCreateFolder(inp.value);
    if (e.key === "Escape") row.remove();
  });
}

async function fbCreateFolder(name) {
  name = name.trim();
  if (!name) return;
  const fullPath = (fbCurrentPath === "/" ? "" : fbCurrentPath) + "/" + name;
  const res = await fetch("/mkdir", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: fullPath }),
  });
  if (res.ok) {
    fetchBrowse(fbCurrentPath);
  } else {
    const err = await res.json().catch(() => ({}));
    alert(err.error || "Failed to create folder");
  }
}

document.addEventListener("keydown", (e) => {
  const overlay = document.getElementById("folder-browser-overlay");
  if (e.key === "Escape" && overlay && overlay.style.display !== "none") {
    closeFolderBrowser();
  }
});

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function md(text) {
  return DOMPurify.sanitize(marked.parse(String(text)));
}

// ── Session list ───────────────────────────────────────────────────────────
function renderList(list) {
  // Update sidebar header with archive toggle
  const hdr = document.getElementById("sidebar-header");
  if (hdr) {
    const archivedBtn =
      archivedCount > 0 || showArchived
        ? `<button class="btn-show-archived${showArchived ? " active" : ""}" onclick="toggleShowArchived()" title="${showArchived ? "Hide archived" : `Archived (${archivedCount})`}">
           <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
           ${showArchived ? "" : archivedCount}
         </button>`
        : "";
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

  const visible = showArchived ? list : list.filter((j) => !j.archived);
  const el = document.getElementById("session-list");
  if (!visible.length) {
    el.innerHTML = `<div class="session-list-empty">${list.length && !showArchived ? "No active sessions" : "No sessions yet"}</div>`;
    return;
  }
  el.innerHTML = visible
    .map(
      (j) => `
    <div class="session-item${selectedId === j.id ? " selected" : ""}${j.archived ? " archived" : ""}" onclick="selectJob('${j.id}')">
      <div class="session-item-top">
        ${badge(j.status)}
        ${j.mode && j.mode !== "auto" ? `<span class="mode-tag mode-tag-${j.mode}">${j.mode}</span>` : ""}
        ${j.model && j.model !== "claude-sonnet-4-6" ? `<span class="mode-tag mode-tag-${j.model === "claude-haiku-4-5-20251001" ? "haiku" : "opus"}">${j.model === "claude-haiku-4-5-20251001" ? "haiku" : "opus"}</span>` : ""}
        ${j.effort && j.effort !== "high" ? `<span class="mode-tag mode-tag-${j.effort}">${j.effort}</span>` : ""}
        ${j.sandbox && j.sandbox !== "none" ? `<span class="mode-tag mode-tag-${j.sandbox}">${j.sandbox === "docker" ? "🐳" : j.sandbox === "yolo" ? "⚡" : "🛡️"}</span>` : ""}
        <span class="session-time">${relTime(j.createdAt)}</span>
      </div>
      <div class="session-prompt">${escHtml(j.title || j.prompt)}</div>
      ${j.images && j.images.length ? `<div class="session-image-badge">📎 ${j.images.length} file${j.images.length > 1 ? "s" : ""}</div>` : ""}
      ${j.cwd ? `<div style="font-size:10px;color:#555;font-family:monospace;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(j.cwd)}</div>` : ""}
    </div>
  `,
    )
    .join("");
}

async function toggleShowArchived() {
  showArchived = !showArchived;
  if (showArchived) {
    const all = await fetch("/sessions?archived=true")
      .then((r) => r.json())
      .catch(() => []);
    all.forEach((j) => {
      sessions[j.id] = j;
    });
  }
  renderList(getSortedJobs());
}

// ── Job detail ─────────────────────────────────────────────────────────────
function toolDetail(name, input, cwd) {
  if (!input) return "";
  let detail = "";
  if (name === "Glob") detail = input.pattern ?? "";
  else if (name === "Bash")
    detail =
      input.description ||
      (input.command ? String(input.command).slice(0, 80) : "");
  else detail = Object.values(input).find((v) => typeof v === "string") ?? "";
  const cwdTools = new Set(["Read", "Edit", "Write", "MultiEdit"]);
  if (detail && cwd && cwdTools.has(name) && detail.startsWith(cwd)) {
    detail = "." + detail.slice(cwd.length);
  }
  return detail
    ? ` <span style="opacity:0.6;font-weight:400">${escHtml(String(detail))}</span>`
    : "";
}

function renderTodoWrite(todos) {
  if (!Array.isArray(todos) || !todos.length) return "";
  const icons = { completed: "✓", in_progress: "●", pending: "○" };
  const items = todos
    .map((t) => {
      const status = t.status ?? "pending";
      const icon = icons[status] ?? "○";
      return `<div class="todo-item todo-${escHtml(status)}">
      <span class="todo-icon">${icon}</span>
      <span class="todo-content">${escHtml(String(t.content ?? ""))}</span>
    </div>`;
    })
    .join("");
  return `<div class="chat-todo">${items}</div>`;
}

function renderBashTool(e) {
  const desc = e.input?.description
    ? escHtml(String(e.input.description))
    : null;
  const cmd = e.input?.command ? escHtml(String(e.input.command)) : null;
  const summary = desc || (cmd ? cmd.slice(0, 80) : "Bash");
  const hasOutput = e.output !== undefined && e.output !== null;
  const outputIsEmpty =
    !e.output || e.output === "(Bash completed with no output)";

  let bodyHtml = "";
  if (cmd) {
    bodyHtml += `<div class="tool-expand-row"><span class="tool-expand-key">cmd</span><pre class="tool-expand-code">${cmd}</pre></div>`;
  }
  if (hasOutput) {
    const outClass = outputIsEmpty ? " tool-expand-empty" : "";
    const outText = outputIsEmpty ? "(no output)" : escHtml(e.output);
    bodyHtml += `<div class="tool-expand-row${outClass}"><span class="tool-expand-key">out</span><pre class="tool-expand-code">${outText}</pre></div>`;
  }

  return `<details class="chat-tool-bash">
    <summary class="chat-tool">Bash <span class="tool-detail">${summary}</span></summary>
    <div class="tool-expand-body">${bodyHtml}</div>
  </details>`;
}

function renderAgentTool(e) {
  const inp = e.input ?? {};
  const desc = inp.description
    ? ` <span class="tool-detail">${escHtml(String(inp.description).slice(0, 120))}</span>`
    : "";
  const toolUseAttr = e.toolUseId
    ? ` data-tool-use-id="${escHtml(e.toolUseId)}"`
    : "";

  let paramsHtml = "";
  if (inp.subagent_type) {
    paramsHtml += `<div class="tool-expand-row"><span class="tool-expand-key">type</span><pre class="tool-expand-code">${escHtml(String(inp.subagent_type))}</pre></div>`;
  }
  if (inp.model) {
    paramsHtml += `<div class="tool-expand-row"><span class="tool-expand-key">model</span><pre class="tool-expand-code">${escHtml(String(inp.model))}</pre></div>`;
  }
  if (inp.isolation) {
    paramsHtml += `<div class="tool-expand-row"><span class="tool-expand-key">isolation</span><pre class="tool-expand-code">${escHtml(String(inp.isolation))}</pre></div>`;
  }
  if (inp.run_in_background) {
    paramsHtml += `<div class="tool-expand-row"><span class="tool-expand-key">bg</span><pre class="tool-expand-code">true</pre></div>`;
  }
  if (inp.prompt) {
    paramsHtml += `<div class="tool-expand-row"><span class="tool-expand-key">prompt</span><pre class="tool-expand-code">${escHtml(String(inp.prompt))}</pre></div>`;
  }
  if (e.output !== undefined && e.output !== null) {
    const outputIsEmpty = !e.output;
    const outClass = outputIsEmpty ? " tool-expand-empty" : "";
    const outText = outputIsEmpty ? "(no output)" : escHtml(String(e.output));
    paramsHtml += `<div class="tool-expand-row${outClass}"><span class="tool-expand-key">out</span><pre class="tool-expand-code">${outText}</pre></div>`;
  }

  const detailsHtml = paramsHtml
    ? `<details class="agent-params" onclick="event.stopPropagation()"><summary class="agent-params-summary">params</summary><div class="tool-expand-body">${paramsHtml}</div></details>`
    : "";

  return `<div class="chat-tool chat-tool-agent"${toolUseAttr}>Agent —${desc}${detailsHtml}</div>`;
}

function renderChatEntry(e, cwd) {
  if (e.type === "user") {
    return `<div class="chat-user">${escHtml(e.text)}</div>`;
  }
  if (e.type === "text") {
    return `<div class="chat-text markdown-body">${md(e.text)}</div>`;
  }
  if (e.type === "tool_call") {
    if (e.name === "ExitPlanMode") return renderPlanCard(e.input?.plan);
    if (e.name === "TodoWrite") return renderTodoWrite(e.input?.todos);
    if (e.name === "Bash") return renderBashTool(e);
    if (e.name === "Agent") return renderAgentTool(e);
    return `<div class="chat-tool">${escHtml(e.name)}${toolDetail(e.name, e.input, cwd)}</div>`;
  }
  if (e.type === "image") {
    return `<div class="chat-image"><img src="${escHtml(e.url)}" alt="Image" loading="lazy"></div>`;
  }
  return "";
}

function renderInputImages(job) {
  if (!job.images || !job.images.length) return "";
  const items = job.images
    .map((img, i) => {
      const url = `/images/${escHtml(job.id)}/${escHtml(img.filename)}`;
      if (img.mediaType.startsWith("image/")) {
        return `<a href="${url}" target="_blank" rel="noopener">
        <img src="${url}" alt="Attached image ${i + 1}" class="input-img-thumb" loading="lazy">
      </a>`;
      } else {
        return `<a href="${url}" target="_blank" rel="noopener" class="input-file-chip">${escHtml(img.filename)}</a>`;
      }
    })
    .join("");
  return `<div class="input-images-row">${items}</div>`;
}

// ── AskUserQuestion state & rendering ──────────────────────────────────────
// Preserves answer selections across polling DOM rebuilds, keyed by jobId.
const questionAnswers = {}; // { [jobId]: { [questionText]: string } }

function renderQuestionBar(job) {
  if (job.status !== "awaiting_user_question") return "";
  const askTool = (job.pendingTools ?? []).find(
    (t) => t.name === "AskUserQuestion",
  );
  if (!askTool) return "";
  const questions = askTool.input?.questions ?? [];
  if (!questions.length) return "";
  const id = job.id;
  const saved = questionAnswers[id] ?? {};

  const questionsHtml = questions
    .map((q, i) => {
      const name = `q_${id}_${i}`;
      const inputType = q.multiSelect ? "checkbox" : "radio";
      const savedVal = saved[q.question] ?? "";
      const savedArr = savedVal ? savedVal.split(", ") : [];

      const optionsHtml = (q.options ?? [])
        .map((opt) => {
          const checked = savedArr.includes(opt.label) ? "checked" : "";
          return `<label class="question-option">
        <input type="${inputType}" name="${name}" value="${escHtml(opt.label)}" ${checked}>
        <span class="question-option-body">
          <span class="question-option-label">${escHtml(opt.label)}</span>
          ${opt.description ? `<span class="question-option-desc markdown-body">${md(opt.description)}</span>` : ""}
        </span>
      </label>`;
        })
        .join("");

      // Detect if the current saved value is a free-text (not one of the preset labels)
      const presetLabels = (q.options ?? []).map((o) => o.label);
      const otherVals = savedArr.filter((v) => !presetLabels.includes(v));
      const otherChecked = otherVals.length ? "checked" : "";
      const otherText = otherVals.join(", ");

      const otherHtml = `<label class="question-option-other">
      <input type="${inputType}" name="${name}" value="__other__" ${otherChecked}>
      <span class="question-option-other-label">Other:</span>
      <input type="text" id="${name}_other" placeholder="Type a custom answer…" value="${escHtml(otherText)}" oninput="selectOtherRadio('${name}')">
    </label>`;

      return `<div class="question-item">
      ${q.header ? `<span class="question-header-chip">${escHtml(q.header)}</span>` : ""}
      <div class="question-text markdown-body">${md(q.question)}</div>
      <div class="question-options">
        ${optionsHtml}
        ${otherHtml}
      </div>
    </div>`;
    })
    .join('<hr class="question-divider">');

  return `<div class="question-bar">
    ${questionsHtml}
    <div class="question-bar-actions">
      <button class="btn-answer" id="answer-btn-${id}" onclick="answerQuestion('${id}')">Submit Answers</button>
    </div>
  </div>`;
}

function _snapshotQuestionAnswers(job) {
  // Read current form selections into questionAnswers before a DOM rebuild
  if (job.status !== "awaiting_user_question") return;
  const askTool = (job.pendingTools ?? []).find(
    (t) => t.name === "AskUserQuestion",
  );
  if (!askTool) return;
  const questions = askTool.input?.questions ?? [];
  const id = job.id;
  if (!questionAnswers[id]) questionAnswers[id] = {};
  questions.forEach((q, i) => {
    const name = `q_${id}_${i}`;
    const inputs = document.querySelectorAll(`[name="${name}"]`);
    if (q.multiSelect) {
      const vals = [];
      inputs.forEach((inp) => {
        if (inp.checked) {
          if (inp.value === "__other__") {
            const t = (
              document.getElementById(`${name}_other`)?.value ?? ""
            ).trim();
            if (t) vals.push(t);
          } else {
            vals.push(inp.value);
          }
        }
      });
      questionAnswers[id][q.question] = vals.join(", ");
    } else {
      const checked = Array.from(inputs).find((inp) => inp.checked);
      if (checked) {
        if (checked.value === "__other__") {
          questionAnswers[id][q.question] = (
            document.getElementById(`${name}_other`)?.value ?? ""
          ).trim();
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
  const askTool = (job.pendingTools ?? []).find(
    (t) => t.name === "AskUserQuestion",
  );
  const questions = askTool?.input?.questions ?? [];
  const answers = {};
  questions.forEach((q, i) => {
    const name = `q_${id}_${i}`;
    const inputs = document.querySelectorAll(`[name="${name}"]`);
    if (q.multiSelect) {
      const selected = [];
      inputs.forEach((inp) => {
        if (inp.checked) {
          if (inp.value === "__other__") {
            const t = (
              document.getElementById(`${name}_other`)?.value ?? ""
            ).trim();
            if (t) selected.push(t);
          } else {
            selected.push(inp.value);
          }
        }
      });
      answers[q.question] = selected.join(", ") || "";
    } else {
      const checked = Array.from(inputs).find((inp) => inp.checked);
      if (checked) {
        if (checked.value === "__other__") {
          answers[q.question] = (
            document.getElementById(`${name}_other`)?.value ?? ""
          ).trim();
        } else {
          answers[q.question] = checked.value;
        }
      }
    }
  });
  const btn = document.getElementById(`answer-btn-${id}`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Submitting…";
  }
  try {
    await fetch(`/sessions/${id}/answer-question`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers }),
    });
    delete questionAnswers[id];
    const refreshed = await fetch("/sessions/" + id)
      .then((r) => r.json())
      .catch((err) => {
        console.warn("[answerQuestion] failed to refresh session:", err);
        return null;
      });
    if (refreshed) {
      sessions[id] = refreshed;
      renderDetailFresh = true;
      renderDetail(refreshed);
    }
    // SSE will deliver subsequent chat_entry and session_status events
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Submit Answers";
    }
  }
}

// ── renderDetail sub-functions ──────────────────────────────────────────────

function renderPlanCard(planText) {
  if (!planText) return "";
  return `<div class="chat-plan"><span class="chat-plan-label">Plan</span><div class="markdown-body">${md(planText)}</div></div>`;
}

function renderResultBox(job) {
  if (job.error)
    return `<div class="chat-error"><span class="chat-error-label">Error</span>${escHtml(job.error)}</div>`;
  return "";
}

function renderApproveBar(job) {
  if (job.status !== "awaiting_approval") return "";
  if (!approvalModels[job.id])
    approvalModels[job.id] = job.model ?? "claude-sonnet-4-6";
  const isActive = (m) => (approvalModels[job.id] === m ? "active" : "");
  return `<div class="approve-bar">
    <div class="approve-model-row">
      <span class="approve-model-label">Run with</span>
      <div class="mode-selector">
        <button class="mode-btn approval-model-btn ${isActive("claude-haiku-4-5-20251001")}" data-session="${job.id}" data-model="claude-haiku-4-5-20251001" onclick="setApprovalModel('${job.id}', 'claude-haiku-4-5-20251001')">Haiku</button>
        <button class="mode-btn approval-model-btn ${isActive("claude-sonnet-4-6")}" data-session="${job.id}" data-model="claude-sonnet-4-6" onclick="setApprovalModel('${job.id}', 'claude-sonnet-4-6')">Sonnet</button>
        <button class="mode-btn approval-model-btn ${isActive("claude-opus-4-6")}" data-session="${job.id}" data-model="claude-opus-4-6" onclick="setApprovalModel('${job.id}', 'claude-opus-4-6')">Opus</button>
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
  if (job.status !== "awaiting_tool_approval") return "";
  const pendingToolsList = (job.pendingTools ?? []).filter(
    (t) => t.name !== "AskUserQuestion",
  );
  if (!pendingToolsList.length) return "";
  const tool = pendingToolsList[0];
  const queueCount = pendingToolsList.length - 1;
  const inputRows = Object.entries(tool.input || {})
    .map(([k, v]) => {
      const val = typeof v === "string" ? v : JSON.stringify(v, null, 2);
      return `<div class="tool-input-row"><span class="tool-input-key">${escHtml(k)}</span><span class="tool-input-val">${escHtml(val)}</span></div>`;
    })
    .join("");
  const toolUseID = escHtml(tool.toolUseID);
  const queueBadge =
    queueCount > 0
      ? `<div class="tool-queue-count">${queueCount} more pending in queue</div>`
      : "";
  return `<div class="tool-approval-bar">
      <div class="tool-approval-header">
        <span class="tool-approval-label">Tool request</span>
        <span class="tool-approval-name">${escHtml(tool.name)}</span>
      </div>
      ${inputRows ? `<div class="tool-input-detail">${inputRows}</div>` : ""}
      <div class="tool-approval-actions">
        <button class="btn-approve" onclick="approveToolUse('${job.id}', '${toolUseID}')">Approve</button>
        <input type="text" class="tool-deny-reason" placeholder="Reason for denying (optional)">
        <button class="btn-reject" onclick="rejectToolUse('${job.id}', '${toolUseID}', this)">Deny</button>
      </div>
    </div>${queueBadge}`;
}

function renderFollowUpBar(job) {
  const showFollowUp =
    ((job.status === "completed" || job.status === "failed") &&
      job.claudeSessionId) ||
    job.status === "stopped";
  if (!showFollowUp) return "";
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
  const started = job.startedAt
    ? new Date(job.startedAt).toLocaleTimeString()
    : "—";
  const finished = job.finishedAt
    ? new Date(job.finishedAt).toLocaleTimeString()
    : "—";
  const NOT_STOPPABLE = new Set([
    "awaiting_approval",
    "completed",
    "failed",
    "stopped",
  ]);
  const stopBtnHtml = !NOT_STOPPABLE.has(job.status)
    ? `<button class="btn-stop" onclick="stopJob('${job.id}')">Stop</button>`
    : "";
  const archiveBtnHtml = job.archived
    ? `<button class="btn-archive active" onclick="unarchiveJob('${job.id}')">Unarchive</button>`
    : `<button class="btn-archive" onclick="archiveJob('${job.id}')">Archive</button>`;
  return `<div class="detail-header">
    <button class="mobile-back-btn" onclick="goBack()">&#8592; Back</button>
    <div class="detail-meta">
      ${badge(job.status)}
      <span>Started: ${started}</span>
      <span>Finished: ${finished}</span>
      ${job.cwd ? `<span style="font-family:monospace">cwd: ${escHtml(job.cwd)}</span>` : ""}
      ${job.worktreePath ? `<span style="font-family:monospace;color:#6b9eff" title="Isolated worktree created for this job">worktree: ${escHtml(job.worktreePath)}</span>` : ""}
      ${job.sandbox && job.sandbox !== "none" ? `<span class="mode-tag mode-tag-${job.sandbox}" title="Sandbox: ${job.sandbox}">${job.sandbox}</span>` : ""}
      ${job.usage ? `<span title="Token and cost usage for this job">$${job.usage.costUSD.toFixed(1)} · ${job.usage.totalTokens.toLocaleString()} tokens (${((job.usage.totalTokens / 200000) * 100).toFixed(1)}%)</span>` : ""}
      <div class="detail-actions">${stopBtnHtml}${archiveBtnHtml}</div>
    </div>
  </div>`;
}

/** Capture scroll position of #chat-feed before a DOM rebuild. */
function captureScrollState() {
  const feed = document.getElementById("chat-feed");
  if (!feed || renderDetailFresh)
    return { wasAtBottom: true, scrollTop: 0, scrollHeight: 0 };
  const scrollTop = feed.scrollTop;
  const scrollHeight = feed.scrollHeight;
  // "at bottom" = within 80px of the maximum scroll position
  const wasAtBottom = scrollHeight - feed.clientHeight - scrollTop <= 80;
  return { wasAtBottom, scrollTop, scrollHeight };
}

/** Restore scroll position after a DOM rebuild, anchoring the viewport if not at bottom. */
function restoreScrollState(state) {
  const feed = document.getElementById("chat-feed");
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
  const activeId = document.activeElement?.id || "";
  return {
    reviseTaVal: document.getElementById("revise-prompt-" + jobId)?.value || "",
    followupTaVal:
      document.getElementById("followup-prompt-" + jobId)?.value || "",
    activeId,
    selStart: activeId ? document.activeElement.selectionStart : null,
    selEnd: activeId ? document.activeElement.selectionEnd : null,
  };
}

/** Restore textarea values and focus state after a DOM rebuild. */
function restoreInputState(state, jobId) {
  if (state.reviseTaVal) {
    const el = document.getElementById("revise-prompt-" + jobId);
    if (el) el.value = state.reviseTaVal;
  }
  if (state.followupTaVal) {
    const el = document.getElementById("followup-prompt-" + jobId);
    if (el) el.value = state.followupTaVal;
  }
  if (state.activeId) {
    const el = document.getElementById(state.activeId);
    if (el) {
      el.focus();
      if (state.selStart !== null && el.setSelectionRange)
        el.setSelectionRange(state.selStart, state.selEnd);
    }
  }
}

/** Attach keyboard and paste listeners to revise/follow-up textareas after a DOM rebuild. */
function attachTextareaListeners(jobId) {
  const reviseTa = document.getElementById("revise-prompt-" + jobId);
  if (reviseTa) {
    reviseTa.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) requestChanges(jobId);
    });
    reviseTa.addEventListener("paste", async (e) => {
      if (!reviseImages[jobId]) reviseImages[jobId] = [];
      await handlePastedFiles(e, reviseImages[jobId], () =>
        renderRevisePreviews(jobId),
      );
    });
  }
  const followupTa = document.getElementById("followup-prompt-" + jobId);
  if (followupTa) {
    followupTa.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) sendFollowUp(jobId);
    });
    followupTa.addEventListener("paste", async (e) => {
      if (!followupImages[jobId]) followupImages[jobId] = [];
      await handlePastedFiles(e, followupImages[jobId], () =>
        renderFollowupPreviews(jobId),
      );
    });
  }
}

// ── Agent collapse ──────────────────────────────────────────────────────────
const collapsedAgents = new Set(); // toolUseIds of collapsed Agent entries

function applyAgentCollapseState(feed) {
  for (const id of collapsedAgents) {
    const agentEl = feed.querySelector(`.chat-tool-agent[data-tool-use-id="${CSS.escape(id)}"]`);
    if (agentEl) agentEl.classList.add("collapsed");
    const container = feed.querySelector(`.agent-children[data-agent-id="${CSS.escape(id)}"]`);
    if (container) container.classList.add("agent-children-collapsed");
  }
}

function toggleAgentCollapse(agentEl) {
  const id = agentEl.dataset.toolUseId;
  if (!id) return;
  const feed = agentEl.closest("#chat-feed");
  if (!feed) return;
  const container = feed.querySelector(`.agent-children[data-agent-id="${CSS.escape(id)}"]`);
  if (!container) return;
  if (collapsedAgents.has(id)) {
    collapsedAgents.delete(id);
    agentEl.classList.remove("collapsed");
    container.classList.remove("agent-children-collapsed");
  } else {
    collapsedAgents.add(id);
    agentEl.classList.add("collapsed");
    container.classList.add("agent-children-collapsed");
  }
}

function buildGroupedChatHtml(chat, cwd) {
  const agentIds = new Set();
  for (const e of chat) {
    if (e && e.type === "tool_call" && e.name === "Agent" && e.toolUseId) {
      agentIds.add(e.toolUseId);
    }
  }
  if (agentIds.size === 0) {
    return chat
      .map((e, chatIdx) => {
        if (!e) return "";
        let html = renderChatEntry(e, cwd);
        if (html) html = html.replace(/^(<\w+)/, `$1 data-chat-index="${chatIdx}"`);
        return html || "";
      })
      .join("");
  }
  const childBuckets = new Map();
  for (const id of agentIds) childBuckets.set(id, []);

  const topItems = [];
  for (let chatIdx = 0; chatIdx < chat.length; chatIdx++) {
    const e = chat[chatIdx];
    if (!e) continue;
    let html = renderChatEntry(e, cwd);
    if (!html) continue;
    html = html.replace(/^(<\w+)/, `$1 data-chat-index="${chatIdx}"`);
    const bucket =
      e.parentToolUseId && childBuckets.has(e.parentToolUseId)
        ? childBuckets.get(e.parentToolUseId)
        : topItems;

    bucket.push(html);
    if (
      e.type === "tool_call" &&
      e.name === "Agent" &&
      e.toolUseId &&
      childBuckets.has(e.toolUseId)
    ) {
      bucket.push({ agentId: e.toolUseId });
    }
  }

  function resolveItems(items) {
    return items
      .map((item) => {
        if (typeof item === "string") return item;
        const children = childBuckets.get(item.agentId) || [];
        const collapsed = collapsedAgents.has(item.agentId);
        return `<div class="agent-children${collapsed ? " agent-children-collapsed" : ""}" data-agent-id="${escHtml(item.agentId)}">${resolveItems(children)}</div>`;
      })
      .join("");
  }
  return resolveItems(topItems);
}

function renderDetail(job) {
  if (!job) {
    document.getElementById("detail").innerHTML =
      '<div class="detail-empty">Select a session to see details</div>';
    return;
  }
  // Snapshot question answers BEFORE rebuilding DOM so selections are preserved
  _snapshotQuestionAnswers(job);
  const scrollState = captureScrollState();
  const inputState = captureInputState(job.id);

  const cwd = job.worktreePath ?? job.cwd;
  const chatHtml = buildGroupedChatHtml(job.chat, cwd);

  const feedHtml =
    `<div class="chat-user">${escHtml(job.prompt)}</div>${renderInputImages(job)}` +
    chatHtml +
    renderResultBox(job) +
    renderQuestionBar(job);

  const effectiveCwd = job.worktreePath ?? job.cwd;
  const hasCwd = !!effectiveCwd;
  const tabsHtml = hasCwd
    ? `<div class="detail-tabs">
        <button class="detail-tab${activeDetailTab === "chat" ? " active" : ""}" onclick="setDetailTab('chat')">Chat</button>
        <button class="detail-tab${activeDetailTab === "files" ? " active" : ""}" onclick="setDetailTab('files')">Files</button>
      </div>`
    : "";

  document.getElementById("detail").innerHTML = `
    ${renderDetailHeader(job)}
    ${tabsHtml}
    <div class="detail-tab-pane${activeDetailTab === "chat" || !hasCwd ? "" : " hidden"}" id="chat-pane">
      <div class="chat-feed" id="chat-feed">${feedHtml}</div>
      ${renderApproveBar(job)}
      ${renderToolApprovalBar(job)}
      ${renderFollowUpBar(job)}
    </div>
    ${hasCwd ? `<div class="detail-tab-pane file-browser${activeDetailTab === "files" ? "" : " hidden"}" id="files-pane">
      <div class="file-browser-tree" id="file-browser-tree"><div class="file-tree-loading">Loading…</div></div>
      <div class="file-browser-viewer" id="file-browser-viewer">
        <div class="file-viewer-header" id="file-viewer-header"><span id="file-viewer-path">Select a file to view</span></div>
        <div class="file-viewer-content" id="file-viewer-content"></div>
      </div>
    </div>` : ""}
  `;

  restoreScrollState(scrollState);
  restoreInputState(inputState, job.id);
  applyAgentCollapseState(document.getElementById("chat-feed"));
  // Re-render any pending image previews (they live outside the rebuilt HTML)
  renderRevisePreviews(job.id);
  renderFollowupPreviews(job.id);
  attachTextareaListeners(job.id);

  if (hasCwd && activeDetailTab === "files") {
    loadFileTree(job.id);
  }
}

// ── Follow-up / revise file handling ──────────────────────────────────────
const followupImages = {}; // jobId → [{ mediaType, data, objectUrl, name }]
const reviseImages = {}; // jobId → [{ mediaType, data, objectUrl, name }]

/** Generic handler for file inputs attached to a job-scoped image store. */
async function handleJobImages(store, prefix, jobId, input) {
  if (!store[jobId]) store[jobId] = [];
  for (const file of Array.from(input.files)) {
    try {
      const data = await fileToBase64(file);
      store[jobId].push({
        mediaType: file.type,
        data,
        objectUrl: URL.createObjectURL(file),
        name: file.name,
      });
    } catch {
      /* skip unreadable files */
    }
  }
  input.value = "";
  renderJobImagePreviews(store, prefix, jobId);
}

function renderJobImagePreviews(store, prefix, jobId) {
  const el = document.getElementById(`${prefix}-previews-${jobId}`);
  if (!el) return;
  const files = store[jobId] || [];
  el.innerHTML = files
    .map((f, i) =>
      filePreviewHtml(
        f,
        `remove${prefix[0].toUpperCase()}${prefix.slice(1)}Image('${jobId}',${i})`,
      ),
    )
    .join("");
}

function removeJobImage(store, prefix, jobId, index) {
  const imgs = store[jobId] || [];
  URL.revokeObjectURL(imgs[index].objectUrl);
  imgs.splice(index, 1);
  renderJobImagePreviews(store, prefix, jobId);
}

// Named wrappers — referenced by HTML inline handlers and paste listeners
async function handleFollowupImages(jobId, input) {
  await handleJobImages(followupImages, "followup", jobId, input);
}
async function handleReviseImages(jobId, input) {
  await handleJobImages(reviseImages, "revise", jobId, input);
}
function renderFollowupPreviews(jobId) {
  renderJobImagePreviews(followupImages, "followup", jobId);
}
function renderRevisePreviews(jobId) {
  renderJobImagePreviews(reviseImages, "revise", jobId);
}
function removeFollowupImage(jobId, index) {
  removeJobImage(followupImages, "followup", jobId, index);
}
function removeReviseImage(jobId, index) {
  removeJobImage(reviseImages, "revise", jobId, index);
}

// ── API actions ────────────────────────────────────────────────────────────
async function selectJob(id) {
  if (selectedId !== id) {
    activeDetailTab = "chat";
    selectedFile = null;
    if (window.destroyCodeViewer) window.destroyCodeViewer();
  }
  selectedId = id;
  history.replaceState(null, "", "#" + id);
  document
    .querySelectorAll(".session-item")
    .forEach((el) =>
      el.classList.toggle("selected", el.onclick.toString().includes(id)),
    );
  document.getElementById("new-task-panel").classList.add("hidden");
  document.getElementById("detail").classList.remove("hidden");
  const session = await fetch("/sessions/" + id).then((r) => r.json());
  sessions[id] = session;
  renderDetailFresh = true; // fresh view, always scroll to bottom
  renderDetail(session);
  if (isMobile()) showMobilePanel("detail");
}

// ── SSE real-time updates ───────────────────────────────────────────────────

/** Sort sessions by latest user-message time, mirroring the server's listSessions() order. */
function _latestUserMsgTime(session) {
  const times = (session.chat || [])
    .filter((e) => e.type === "user")
    .map((e) => new Date(e.ts).getTime());
  return Math.max(new Date(session.createdAt).getTime(), ...times, 0);
}
function getSortedJobs() {
  return Object.values(sessions).sort(
    (a, b) => _latestUserMsgTime(b) - _latestUserMsgTime(a),
  );
}

/**
 * Append a single chat entry to the visible #chat-feed without rebuilding the
 * entire detail panel. Only runs when jobId === selectedId and the feed exists.
 * When index is provided, updates an existing element if present (for patches like Bash output).
 */
function appendChatEntryDOM(entry, jobId, index) {
  if (jobId !== selectedId) return;
  const feed = document.getElementById("chat-feed");
  if (!feed) return;
  let html = renderChatEntry(
    entry,
    sessions[jobId]?.worktreePath ?? sessions[jobId]?.cwd,
  );
  if (!html) return;
  // Inject data-chat-index into the root element so we can find it for updates
  if (index !== undefined) {
    html = html.replace(/^(<\w+)/, `$1 data-chat-index="${index}"`);
  }
  const isAgent =
    entry.type === "tool_call" && entry.name === "Agent" && entry.toolUseId;
  // If element with this index already exists, update it in-place
  if (index !== undefined) {
    const existing = feed.querySelector(`[data-chat-index="${index}"]`);
    if (existing) {
      const wasOpen =
        existing.tagName === "DETAILS"
          ? existing.open
          : existing.querySelector("details")?.open;
      existing.outerHTML = html;
      if (wasOpen) {
        const updated = feed.querySelector(`[data-chat-index="${index}"]`);
        const details =
          updated?.tagName === "DETAILS"
            ? updated
            : updated?.querySelector("details");
        if (details) details.open = true;
      }
      return;
    }
  }
  // Remove placeholder on first real entry
  if (
    !feed.querySelector(
      ".chat-text, .chat-user, .chat-tool, .chat-image, .chat-tool-bash",
    )
  ) {
    feed.innerHTML = "";
  }
  // If this is an Agent entry, append an empty children container after the header
  if (isAgent) {
    html += `<div class="agent-children" data-agent-id="${escHtml(entry.toolUseId)}"></div>`;
  }
  // Determine target: insert into parent agent's container if applicable
  let target = feed;
  if (entry.parentToolUseId) {
    const container = feed.querySelector(
      `.agent-children[data-agent-id="${CSS.escape(entry.parentToolUseId)}"]`,
    );
    if (container) target = container;
  }
  const wasAtBottom =
    feed.scrollHeight - feed.clientHeight - feed.scrollTop <= 80;
  // Insert at the correct position based on index order rather than always appending.
  // This handles concurrent tool calls that arrive via SSE out of index order.
  let inserted = false;
  if (index !== undefined) {
    const nextEl = Array.from(target.children).find((el) => {
      const elIdx = el.getAttribute("data-chat-index");
      return elIdx !== null && parseInt(elIdx, 10) > index;
    });
    if (nextEl) {
      nextEl.insertAdjacentHTML("beforebegin", html);
      inserted = true;
    }
  }
  if (!inserted) target.insertAdjacentHTML("beforeend", html);
  if (wasAtBottom) feed.scrollTop = feed.scrollHeight;
}

function initSSE() {
  const es = new EventSource("/events");

  // Initial snapshot: active sessions + archived count (sent on every connect/reconnect)
  es.addEventListener("snapshot", (e) => {
    const data = JSON.parse(e.data);
    const list = data.sessions;
    archivedCount = data.archivedCount;
    if (data.slashCommands) slashCommands = data.slashCommands;
    if (data.home) fbHome = data.home;
    list.forEach((j) => {
      sessions[j.id] = j;
    });
    renderList(list); // already server-sorted
    updateCwdSelect(list);
    const hashId = location.hash.slice(1);
    if (hashId && sessions[hashId] && !selectedId) {
      // First load: restore from hash using snapshot data (no extra fetch)
      selectedId = hashId;
      document
        .querySelectorAll(".session-item")
        .forEach((el) =>
          el.classList.toggle(
            "selected",
            el.onclick.toString().includes(hashId),
          ),
        );
      document.getElementById("new-task-panel").classList.add("hidden");
      document.getElementById("detail").classList.remove("hidden");
      renderDetailFresh = true;
      renderDetail(sessions[hashId]);
      if (isMobile()) showMobilePanel("detail");
    } else if (selectedId && sessions[selectedId]) {
      renderDetail(sessions[selectedId]);
    }
  });

  // A brand-new session was created
  es.addEventListener("session_created", (e) => {
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
  es.addEventListener("session_status", (e) => {
    const data = JSON.parse(e.data);
    const {
      jobId,
      status,
      startedAt,
      finishedAt,
      result,
      error,
      claudeSessionId,
      pendingTools,
      archived,
      usage,
      title,
    } = data;
    const session = sessions[jobId];
    if (!session) return;
    const prevStatus = session.status;
    const prevArchived = session.archived;
    Object.assign(session, {
      status,
      startedAt,
      finishedAt,
      result,
      error,
      claudeSessionId,
      pendingTools,
      archived,
      usage,
      title,
    });
    if (prevArchived !== archived) {
      archivedCount += archived ? 1 : -1;
    }
    if (prevStatus !== status) {
      if (
        [
          "awaiting_approval",
          "awaiting_tool_approval",
          "awaiting_user_question",
        ].includes(status)
      ) {
        playSound("attention");
      } else if (status === "completed") {
        playSound("success");
      } else if (status === "failed" || status === "stopped") {
        playSound("failure");
      }
    }
    renderList(getSortedJobs());
    if (jobId === selectedId) {
      if (prevStatus !== status) renderDetailFresh = true;
      renderDetail(session);
    }
  });

  // A new chat entry was appended — stream it directly into the feed DOM
  es.addEventListener("chat_entry", (e) => {
    const { jobId, entry, index } = JSON.parse(e.data);
    const session = sessions[jobId];
    if (!session) return;
    // Keep the local chat array in sync (sparse-safe)
    while (session.chat.length <= index) session.chat.push(null);
    session.chat[index] = entry;
    appendChatEntryDOM(entry, jobId, index);
    // Re-sort sidebar when a new user message arrives (followup changes sort key)
    if (entry.type === "user") renderList(getSortedJobs());
  });

  es.onerror = () => {
    // EventSource auto-reconnects; the snapshot event on reconnect re-bootstraps state
    console.warn("[SSE] connection lost, reconnecting…");
  };
}

async function stopJob(id) {
  await fetch("/sessions/" + id + "/stop", { method: "POST" });
  // SSE session_status event will update the detail panel
}

async function archiveJob(id) {
  await fetch("/sessions/" + id + "/archive", { method: "POST" });
  // SSE session_status event will update the detail panel and list
}

async function unarchiveJob(id) {
  await fetch("/sessions/" + id + "/unarchive", { method: "POST" });
  // SSE session_status event will update the detail panel and list
}

async function approveToolUse(id, toolUseID) {
  await fetch("/sessions/" + id + "/approve-tool", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ toolUseID }),
  });
  // SSE session_status event will update the detail panel
}

async function rejectToolUse(id, toolUseID, btn) {
  const reason = btn?.previousElementSibling?.value?.trim() || "";
  const body = reason ? { toolUseID, reason } : { toolUseID };
  await fetch("/sessions/" + id + "/reject-tool", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // SSE session_status event will update the detail panel
}

async function approveJob(id) {
  const model = approvalModels[id];
  const opts = model
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      }
    : { method: "POST" };
  await fetch("/sessions/" + id + "/approve", opts);
  // SSE session_status event will deliver the transition and scroll to bottom
}

async function rejectJob(id) {
  await fetch("/sessions/" + id + "/reject", { method: "POST" });
  // SSE session_status event will deliver the transition and scroll to bottom
}

async function requestChanges(id) {
  const ta = document.getElementById("revise-prompt-" + id);
  const btn = document.getElementById("revise-btn-" + id);
  const prompt = ta.value.trim();
  if (!prompt) return;
  btn.disabled = true;
  btn.textContent = "Sending...";
  const imgs = reviseImages[id] || [];
  const body = { prompt };
  if (imgs.length)
    body.images = imgs.map(({ mediaType, data }) => ({ mediaType, data }));
  try {
    await fetch("/sessions/" + id + "/revise", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    ta.value = "";
    (reviseImages[id] || []).forEach((img) =>
      URL.revokeObjectURL(img.objectUrl),
    );
    delete reviseImages[id];
    selectedId = id;
    const refreshed = await fetch("/sessions/" + id)
      .then((r) => r.json())
      .catch((err) => {
        console.warn("[requestChanges] failed to refresh session:", err);
        return null;
      });
    if (refreshed) {
      sessions[id] = refreshed;
      renderDetailFresh = true;
      renderDetail(refreshed);
    }
    // SSE will deliver subsequent chat_entry and session_status events
  } finally {
    btn.disabled = false;
    btn.textContent = "Request Changes";
  }
}

async function sendFollowUp(id) {
  const ta = document.getElementById("followup-prompt-" + id);
  const btn = document.getElementById("followup-btn-" + id);
  const prompt = ta.value.trim();
  if (!prompt) return;
  btn.disabled = true;
  btn.textContent = "Sending...";
  const imgs = followupImages[id] || [];
  const body = { prompt };
  if (imgs.length)
    body.images = imgs.map(({ mediaType, data }) => ({ mediaType, data }));
  try {
    await fetch("/sessions/" + id + "/followup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    ta.value = "";
    // clean up follow-up image previews
    (followupImages[id] || []).forEach((img) =>
      URL.revokeObjectURL(img.objectUrl),
    );
    delete followupImages[id];
    selectedId = id;
    // Refresh the detail view immediately so the user prompt appears without waiting for SSE.
    const refreshed = await fetch("/sessions/" + id)
      .then((r) => r.json())
      .catch((err) => {
        console.warn("[sendFollowUp] failed to refresh session:", err);
        return null;
      });
    if (refreshed) {
      sessions[id] = refreshed;
      renderDetailFresh = true;
      renderDetail(refreshed);
    }
    // SSE will deliver subsequent chat_entry and session_status events
  } finally {
    btn.disabled = false;
    btn.textContent = "Send Follow-up";
  }
}

async function submitJob() {
  const prompt = document.getElementById("prompt").value.trim();
  if (!prompt) return;
  const cwdVal = document.getElementById("cwd-select").value || "";
  const useWorktree = document.getElementById("use-worktree").checked;
  const body = cwdVal
    ? {
        prompt,
        cwd: cwdVal,
        useWorktree,
        mode: currentMode,
        model: currentModel,
        effort: currentEffort,
        sandbox: currentSandbox,
      }
    : {
        prompt,
        useWorktree,
        mode: currentMode,
        model: currentModel,
        effort: currentEffort,
        sandbox: currentSandbox,
      };
  if (pendingFiles.length) {
    body.images = pendingFiles.map(({ mediaType, data }) => ({
      mediaType,
      data,
    }));
  }
  const btn = document.getElementById("submit-btn");
  btn.disabled = true;
  btn.textContent = "Submitting...";
  try {
    const res = await fetch("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const { id } = await res.json();
    document.getElementById("prompt").value = "";
    // clear file attachments
    pendingFiles.forEach((f) => URL.revokeObjectURL(f.objectUrl));
    pendingFiles = [];
    renderFilePreviews();
    selectedId = id;
    // Fetch and show the new session immediately; SSE will deliver all subsequent updates
    const session = await fetch("/sessions/" + id)
      .then((r) => r.json())
      .catch(() => null);
    if (session) {
      sessions[id] = session;
      document.getElementById("new-task-panel").classList.add("hidden");
      document.getElementById("detail").classList.remove("hidden");
      renderDetailFresh = true;
      renderDetail(session);
      if (isMobile()) showMobilePanel("detail");
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "Run Agent";
  }
}

document.getElementById("prompt").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitJob();
});

document.addEventListener("click", (e) => {
  if (e.target.closest(".agent-params")) return;
  const agentEl = e.target.closest(".chat-tool-agent");
  if (agentEl && agentEl.dataset.toolUseId) toggleAgentCollapse(agentEl);
});

document.addEventListener("keydown", (e) => {
  if (
    (e.metaKey || e.ctrlKey) &&
    e.shiftKey &&
    !e.altKey &&
    e.key.toLowerCase() === "o"
  ) {
    e.preventDefault();
    showNewTask();
    return;
  }
  if (e.key === "Tab" && e.shiftKey) {
    e.preventDefault();
    const modes = ["auto", "plan", "edit"];
    const next = modes[(modes.indexOf(currentMode) + 1) % modes.length];
    setMode(next);
  }
});
document.getElementById("prompt").addEventListener("paste", async (e) => {
  await handlePastedFiles(e, pendingFiles, renderFilePreviews);
});

window.addEventListener("resize", () => {
  const main = document.querySelector(".main");
  const active = isMobile() && mobileView === "detail" && selectedId;
  main.classList.toggle("mobile-detail-active", !!active);
  document.body.classList.toggle("mobile-detail-active", !!active);
});

// ── Slash command autocomplete ──────────────────────────────────────────────
let acDropdown = null;
let acTextarea = null;
let acFiltered = [];
let acIndex = 0;

function getSlashPrefix(textarea) {
  const val = textarea.value;
  const cursor = textarea.selectionStart;
  const textBefore = val.slice(0, cursor);
  const match = textBefore.match(/(^|\s)(\/\S*)$/);
  return match ? match[2] : null;
}

function updateActiveClass() {
  if (!acDropdown) return;
  acDropdown.querySelectorAll(".slash-ac-item").forEach((item, i) => {
    item.classList.toggle("active", i === acIndex);
  });
}

function ensureDropdown() {
  if (acDropdown) return acDropdown;
  const el = document.createElement("div");
  el.className = "slash-autocomplete";
  el.style.display = "none";
  document.body.appendChild(el);
  acDropdown = el;
  return el;
}

function showAutocomplete(textarea) {
  const dd = ensureDropdown();
  acTextarea = textarea;
  const rect = textarea.getBoundingClientRect();
  dd.style.position = "fixed";
  dd.style.left = rect.left + "px";
  dd.style.bottom = (window.innerHeight - rect.top + 4) + "px";
  dd.style.width = Math.min(rect.width, 420) + "px";
  dd.style.display = "";
  updateAutocompleteFilter();
}

function hideAutocomplete() {
  if (acDropdown) acDropdown.style.display = "none";
  acTextarea = null;
  acFiltered = [];
  acIndex = 0;
}

function updateAutocompleteFilter() {
  if (!acTextarea || !acDropdown) return;
  const slashWord = getSlashPrefix(acTextarea);
  if (!slashWord) { hideAutocomplete(); return; }
  const typed = slashWord.slice(1).toLowerCase();
  acFiltered = slashCommands.filter(cmd =>
    cmd.name.toLowerCase().includes(typed)
  );
  if (acFiltered.length === 0) {
    acDropdown.style.display = "none";
    return;
  }
  acDropdown.style.display = "";
  acIndex = Math.min(acIndex, acFiltered.length - 1);
  renderAutocomplete();
}

function renderAutocomplete() {
  if (!acDropdown) return;
  acDropdown.innerHTML = acFiltered.map((cmd, i) => `
    <div class="slash-ac-item${i === acIndex ? " active" : ""}" data-ac-index="${i}">
      <span class="slash-ac-name">/${escHtml(cmd.name)}</span>
      ${cmd.argumentHint ? `<span class="slash-ac-hint">${escHtml(cmd.argumentHint)}</span>` : ""}
      ${cmd.description ? `<span class="slash-ac-desc">${escHtml(cmd.description)}</span>` : ""}
    </div>
  `).join("");
}

function selectAutocomplete(index) {
  if (!acTextarea || !acFiltered[index]) return;
  const cmd = acFiltered[index];
  const val = acTextarea.value;
  const cursor = acTextarea.selectionStart;
  const textBefore = val.slice(0, cursor);
  const match = textBefore.match(/(^|\s)(\/\S*)$/);
  if (!match) { hideAutocomplete(); return; }
  const slashStart = textBefore.length - match[2].length;
  const textAfter = val.slice(cursor);
  acTextarea.value = val.slice(0, slashStart) + "/" + cmd.name + textAfter;
  const newCursor = slashStart + cmd.name.length + 1;
  acTextarea.setSelectionRange(newCursor, newCursor);
  acTextarea.focus();
  hideAutocomplete();
}

document.addEventListener("input", (e) => {
  if (e.target.tagName !== "TEXTAREA") return;
  const ta = e.target;
  if (ta.id === "prompt" || ta.id.startsWith("followup-prompt-") || ta.id.startsWith("revise-prompt-")) {
    const slashWord = getSlashPrefix(ta);
    if (slashWord !== null && slashCommands.length > 0) {
      if (acTextarea !== ta) showAutocomplete(ta);
      else updateAutocompleteFilter();
    } else {
      if (acTextarea === ta) hideAutocomplete();
    }
  }
});

document.addEventListener("keydown", (e) => {
  if (!acTextarea || !acDropdown || acDropdown.style.display === "none") return;
  if (e.target !== acTextarea) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    acIndex = Math.min(acIndex + 1, acFiltered.length - 1);
    renderAutocomplete();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    acIndex = Math.max(acIndex - 1, 0);
    renderAutocomplete();
  } else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && acFiltered.length > 0) {
    e.preventDefault();
    e.stopPropagation();
    selectAutocomplete(acIndex);
  } else if (e.key === "Tab" && !e.shiftKey && acFiltered.length > 0) {
    e.preventDefault();
    e.stopPropagation();
    selectAutocomplete(acIndex);
  } else if (e.key === "Escape") {
    e.preventDefault();
    hideAutocomplete();
  }
}, true);

document.addEventListener("mousedown", (e) => {
  if (!acDropdown) return;
  const item = e.target.closest(".slash-ac-item");
  if (item && acDropdown.contains(item)) {
    e.preventDefault();
    selectAutocomplete(Number(item.dataset.acIndex));
    return;
  }
  if (acTextarea && !acDropdown.contains(e.target) && e.target !== acTextarea) {
    hideAutocomplete();
  }
});

document.addEventListener("mouseover", (e) => {
  if (!acDropdown) return;
  const item = e.target.closest(".slash-ac-item");
  if (item && acDropdown.contains(item)) {
    acIndex = Number(item.dataset.acIndex);
    updateActiveClass();
  }
});

// ── File browser ─────────────────────────────────────────────────────────────

function setDetailTab(tab) {
  activeDetailTab = tab;
  const chatPane = document.getElementById("chat-pane");
  const filesPane = document.getElementById("files-pane");
  document.querySelectorAll(".detail-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.textContent.trim().toLowerCase() === tab);
  });
  if (chatPane) chatPane.classList.toggle("hidden", tab !== "chat");
  if (filesPane) filesPane.classList.toggle("hidden", tab !== "files");
  if (tab === "files" && selectedId) loadFileTree(selectedId);
}

async function fetchDirEntries(sessionId, dirPath) {
  if (!fileTreeCache[sessionId]) fileTreeCache[sessionId] = {};
  if (fileTreeCache[sessionId][dirPath] !== undefined) {
    return fileTreeCache[sessionId][dirPath];
  }
  const resp = await fetch(`/sessions/${sessionId}/files?path=${encodeURIComponent(dirPath)}`);
  if (!resp.ok) throw new Error(await resp.text());
  const data = await resp.json();
  fileTreeCache[sessionId][dirPath] = data.entries;
  return data.entries;
}

function getFileIcon(name, isDir) {
  if (isDir) return "▸";
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["js", "ts", "jsx", "tsx", "mjs", "cjs", "mts"].includes(ext)) return "JS";
  if (["json", "jsonc"].includes(ext)) return "{}";
  if (["md", "markdown"].includes(ext)) return "MD";
  if (["css", "scss", "less"].includes(ext)) return "CS";
  if (["html", "htm"].includes(ext)) return "HT";
  if (["py"].includes(ext)) return "PY";
  if (["rs"].includes(ext)) return "RS";
  if (["sh", "bash", "zsh"].includes(ext)) return "SH";
  if (["yml", "yaml"].includes(ext)) return "YM";
  return "  ";
}

function jsStr(s) {
  // Escape a string for safe embedding inside a single-quoted JS string in an HTML attribute
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function renderTreeEntries(sessionId, entries, parentPath, depth) {
  return entries.map((entry) => {
    const entryPath = parentPath === "." ? entry.name : `${parentPath}/${entry.name}`;
    const isDir = entry.type === "directory";
    const expanded = expandedDirs[sessionId]?.has(entryPath);
    const isSelected = selectedFile?.sessionId === sessionId && selectedFile?.path === entryPath;
    const indent = depth * 14;
    const icon = isDir ? (expanded ? "▾" : "▸") : getFileIcon(entry.name, false);
    const iconClass = isDir ? "file-icon dir-icon" : "file-icon";
    const action = isDir
      ? `toggleTreeDir('${jsStr(sessionId)}', '${jsStr(entryPath)}')`
      : `openTreeFile('${jsStr(sessionId)}', '${jsStr(entryPath)}')`;

    const row = `<div class="file-tree-entry${isSelected ? " selected" : ""}" data-path="${escHtml(entryPath)}" onclick="${action}" style="padding-left:${8 + indent}px">
      <span class="${iconClass}">${icon}</span>
      <span class="file-name">${escHtml(entry.name)}</span>
    </div>`;

    const childrenId = `ftc-${sessionId}-${entryPath.replace(/[^a-z0-9]/gi, "_")}`;
    const childrenHtml = isDir
      ? `<div class="file-tree-children" id="${childrenId}" style="display:${expanded ? "block" : "none"}"></div>`
      : "";

    return row + childrenHtml;
  }).join("");
}

async function loadFileTree(sessionId) {
  const treeEl = document.getElementById("file-browser-tree");
  if (!treeEl) return;
  if (!expandedDirs[sessionId]) expandedDirs[sessionId] = new Set();

  try {
    const entries = await fetchDirEntries(sessionId, ".");
    treeEl.innerHTML = `
      <div class="file-tree-header">
        <span class="file-tree-root">${escHtml(sessions[sessionId]?.worktreePath ?? sessions[sessionId]?.cwd ?? "")}</span>
        <button class="file-tree-refresh" onclick="refreshFileTree('${sessionId}')" title="Refresh">↻</button>
      </div>
      <div class="file-tree-entries" id="file-tree-entries">${renderTreeEntries(sessionId, entries, ".", 0)}</div>
    `;
  } catch (err) {
    treeEl.innerHTML = `<div class="file-tree-error">Failed to load files: ${escHtml(String(err))}</div>`;
  }
}

async function toggleTreeDir(sessionId, dirPath) {
  if (!expandedDirs[sessionId]) expandedDirs[sessionId] = new Set();
  const childrenId = `ftc-${sessionId}-${dirPath.replace(/[^a-z0-9]/gi, "_")}`;
  const childrenEl = document.getElementById(childrenId);
  const entryEl = document.querySelector(`.file-tree-entry[data-path="${CSS.escape(dirPath)}"]`);

  if (expandedDirs[sessionId].has(dirPath)) {
    expandedDirs[sessionId].delete(dirPath);
    if (childrenEl) childrenEl.style.display = "none";
    if (entryEl) entryEl.querySelector(".file-icon").textContent = "▸";
  } else {
    expandedDirs[sessionId].add(dirPath);
    if (entryEl) entryEl.querySelector(".file-icon").textContent = "▾";
    if (childrenEl) {
      if (!fileTreeCache[sessionId]?.[dirPath]) {
        childrenEl.innerHTML = `<div class="file-tree-loading" style="padding-left:${8 + (dirPath.split("/").length) * 14}px">Loading…</div>`;
        childrenEl.style.display = "block";
        try {
          const entries = await fetchDirEntries(sessionId, dirPath);
          const depth = dirPath.split("/").length;
          childrenEl.innerHTML = renderTreeEntries(sessionId, entries, dirPath, depth);
        } catch {
          childrenEl.innerHTML = `<div class="file-tree-error">Failed to load</div>`;
        }
      } else {
        childrenEl.style.display = "block";
      }
    }
  }
}

async function openTreeFile(sessionId, filePath) {
  // Update selected state
  document.querySelectorAll(".file-tree-entry.selected").forEach((el) => el.classList.remove("selected"));
  const entryEl = document.querySelector(`.file-tree-entry[data-path="${CSS.escape(filePath)}"]`);
  if (entryEl) entryEl.classList.add("selected");
  selectedFile = { sessionId, path: filePath };

  const headerEl = document.getElementById("file-viewer-header");
  const contentEl = document.getElementById("file-viewer-content");
  if (!headerEl || !contentEl) return;

  const pathEl = document.getElementById("file-viewer-path");
  if (pathEl) pathEl.textContent = filePath;
  contentEl.innerHTML = `<div class="file-viewer-loading">Loading…</div>`;
  if (window.destroyCodeViewer) window.destroyCodeViewer();

  // Remove any existing save button before adding a new one
  headerEl.querySelector(".file-save-btn")?.remove();

  try {
    const resp = await fetch(`/sessions/${sessionId}/file-content?path=${encodeURIComponent(filePath)}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    if (data.binary) {
      contentEl.innerHTML = `<div class="file-viewer-message">Binary file — cannot display</div>`;
    } else if (data.truncated) {
      contentEl.innerHTML = `<div class="file-viewer-message">File too large to display (${(data.size / 1024 / 1024).toFixed(1)} MB)</div>`;
    } else {
      contentEl.innerHTML = `<div id="cm-editor" style="height:100%"></div>`;
      if (window.initCodeViewer) {
        window.initCodeViewer("cm-editor", data.content, filePath.split("/").pop() ?? filePath);
      } else {
        const pre = document.createElement("pre");
        pre.className = "file-viewer-plain";
        pre.textContent = data.content;
        contentEl.innerHTML = "";
        contentEl.appendChild(pre);
      }
      // Add save button
      const saveBtn = document.createElement("button");
      saveBtn.className = "file-save-btn";
      saveBtn.textContent = "Save";
      saveBtn.onclick = () => saveFile(sessionId, filePath, saveBtn);
      headerEl.appendChild(saveBtn);
    }
  } catch (err) {
    contentEl.innerHTML = `<div class="file-viewer-message file-viewer-error">Error loading file: ${escHtml(String(err))}</div>`;
  }
}

async function saveFile(sessionId, filePath, btn) {
  const content = window.getEditorContent?.();
  if (content === null || content === undefined) return;
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    const resp = await fetch(`/sessions/${sessionId}/file-content?path=${encodeURIComponent(filePath)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    btn.textContent = "Saved ✓";
    btn.classList.add("saved");
    setTimeout(() => {
      btn.textContent = "Save";
      btn.classList.remove("saved");
      btn.disabled = false;
    }, 2000);
  } catch (err) {
    btn.textContent = "Error";
    btn.classList.add("error");
    setTimeout(() => {
      btn.textContent = "Save";
      btn.classList.remove("error");
      btn.disabled = false;
    }, 2000);
  }
}

// Cmd/Ctrl+S saves the currently open file
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "s" && selectedFile) {
    const saveBtn = document.querySelector(".file-save-btn");
    if (saveBtn && !saveBtn.disabled) {
      e.preventDefault();
      saveFile(selectedFile.sessionId, selectedFile.path, saveBtn);
    }
  }
});

function refreshFileTree(sessionId) {
  delete fileTreeCache[sessionId];
  if (expandedDirs[sessionId]) expandedDirs[sessionId].clear();
  if (window.destroyCodeViewer) window.destroyCodeViewer();
  selectedFile = null;
  loadFileTree(sessionId);
}

// Eagerly show the detail panel if a job hash is in the URL, to avoid the
// flash of the new-task form before the SSE snapshot arrives.
if (location.hash.slice(1)) {
  document.getElementById("new-task-panel").classList.add("hidden");
  document.getElementById("detail").classList.remove("hidden");
}

initSSE();
