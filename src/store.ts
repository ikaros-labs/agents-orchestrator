import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { InputFile, Session, SessionEffort, SessionMode, SessionStatus, SessionUsage, ChatEntry, SandboxMode } from "./types.ts";
import logger from './logger.ts';

const log = logger.child({ component: 'store' });

const AGENT_DIR = process.env.AGENT_ORCHESTRATOR_DIR ?? join(homedir(), ".agent-orchestrator");
const DATA_DIR = join(AGENT_DIR, "jobs");
mkdirSync(DATA_DIR, { recursive: true });

const sessions = new Map<string, Session>();

// ── Event emitter ─────────────────────────────────────────────────────────────

export type StoreEvent =
  | { type: "session_created"; job: Session }
  | { type: "session_status"; jobId: string; status: SessionStatus; startedAt: string | null; finishedAt: string | null; result: string | null; error: string | null; claudeSessionId: string | null; pendingTools: Session["pendingTools"]; archived: boolean; usage: SessionUsage | null; title: string | null }
  | { type: "chat_entry"; jobId: string; entry: ChatEntry; index: number };

const subscribers = new Set<(e: StoreEvent) => void>();

export function subscribe(fn: (e: StoreEvent) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function emit(e: StoreEvent): void {
  subscribers.forEach(fn => fn(e));
}

function emitSessionStatus(session: Session): void {
  emit({
    type: "session_status",
    jobId: session.id,
    status: session.status,
    startedAt: session.startedAt,
    finishedAt: session.finishedAt,
    result: session.result,
    error: session.error,
    claudeSessionId: session.claudeSessionId,
    pendingTools: session.pendingTools,
    archived: session.archived,
    usage: session.usage,
    title: session.title,
  });
}

function persistSession(session: Session): void {
  writeFileSync(`${DATA_DIR}/${session.id}.json`, JSON.stringify(session, null, 2));
}

const TERMINAL_STATUSES = new Set<SessionStatus>(["completed", "failed", "stopped"]);

export function loadStore(): void {
  for (const file of readdirSync(DATA_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const session = JSON.parse(readFileSync(`${DATA_DIR}/${file}`, "utf8")) as Session;
      // Migrate old single-pendingTool format to array
      if (!Array.isArray(session.pendingTools)) {
        session.pendingTools = [];
      }
      // Migrate sessions created before worktree support
      if (session.useWorktree === undefined) session.useWorktree = false;
      if (session.worktreePath === undefined) session.worktreePath = null;
      // Migrate sessions created before archive support
      if (session.archived === undefined) session.archived = false;
      // Migrate sessions created before usage tracking
      if (session.usage === undefined) session.usage = null;
      // Migrate sessions created before model/effort selection
      if (session.model === undefined) session.model = null;
      if (session.effort === undefined) session.effort = null;
      // Migrate sessions created before title generation
      if (session.title === undefined) session.title = null;
      // Migrate sessions created before sandbox support
      if ((session as any).sandbox === undefined) (session as any).sandbox = "sandbox";
      // Migrate log → chat field rename
      if ((session as any).log !== undefined && (session as any).chat === undefined) {
        (session as any).chat = (session as any).log;
      }
      // Migrate sessionId → claudeSessionId field rename
      if ((session as any).sessionId !== undefined && (session as any).claudeSessionId === undefined) {
        (session as any).claudeSessionId = (session as any).sessionId;
      }
      sessions.set(session.id, session);
    } catch {
      // skip corrupt files
    }
  }

  // Stop any sessions that were in-progress when the server last shut down.
  // Their AbortControllers and SDK streams are gone; mark them stopped so
  // the user can resume via the follow-up bar.
  const restartTs = new Date().toISOString();
  for (const [, session] of sessions) {
    if (TERMINAL_STATUSES.has(session.status)) continue;
    session.status = "stopped";
    session.finishedAt = restartTs;
    session.pendingTools = [];
    session.chat.push({
      type: "text",
      text: "Server restarted — session was stopped. Use the follow-up bar to resume.",
      ts: restartTs,
    });
    persistSession(session);
  }
}

export function createSession(id: string, prompt: string, cwd: string | null = null, images: InputFile[] = [], mode: SessionMode = "auto", useWorktree: boolean = true, model: string | null = null, effort: SessionEffort | null = null, sandbox: SandboxMode = "none"): Session {
  const session: Session = {
    id,
    status: "pending",
    mode,
    model,
    effort,
    prompt,
    title: null,
    cwd,
    useWorktree,
    worktreePath: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    chat: [],
    claudeSessionId: null,
    result: null,
    error: null,
    images,
    pendingTools: [],
    archived: false,
    sandbox,
    usage: null,
  };
  sessions.set(id, session);
  persistSession(session);
  emit({ type: "session_created", job: session });
  return session;
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

function getSessionOrWarn(id: string, caller: string): Session | undefined {
  const session = sessions.get(id);
  if (!session) log.warn({ caller, id }, 'session not found');
  return session;
}

export function setStatus(id: string, status: SessionStatus): void {
  const session = getSessionOrWarn(id, "setStatus");
  if (!session) return;
  session.status = status;
  if (status === "running") session.startedAt = new Date().toISOString();
  if (status === "completed" || status === "failed" || status === "stopped") session.finishedAt = new Date().toISOString();
  persistSession(session);
  emitSessionStatus(session);
}

export function appendChat(id: string, entry: ChatEntry): void {
  const session = getSessionOrWarn(id, "appendChat");
  if (!session) return;
  session.chat.push(entry);
  persistSession(session);
  emit({ type: "chat_entry", jobId: id, entry, index: session.chat.length - 1 });
}

export function patchChat(id: string, index: number, patch: Record<string, unknown>): void {
  const session = getSessionOrWarn(id, "patchChat");
  if (!session) return;
  const entry = session.chat[index];
  if (!entry) return;
  Object.assign(entry, patch);
  persistSession(session);
  emit({ type: "chat_entry", jobId: id, entry: { ...entry } as ChatEntry, index });
}

export function setClaudeSessionId(id: string, claudeSessionId: string): void {
  const session = getSessionOrWarn(id, "setClaudeSessionId");
  if (!session) return;
  session.claudeSessionId = claudeSessionId;
  persistSession(session);
}

export function setTitle(id: string, title: string): void {
  const session = getSessionOrWarn(id, "setTitle");
  if (!session) return;
  session.title = title;
  persistSession(session);
  emitSessionStatus(session);
}

export function setMode(id: string, mode: SessionMode): void {
  const session = getSessionOrWarn(id, "setMode");
  if (!session) return;
  session.mode = mode;
  persistSession(session);
  emitSessionStatus(session);
}

export function setModel(id: string, model: string): void {
  const session = getSessionOrWarn(id, "setModel");
  if (!session) return;
  session.model = model;
  persistSession(session);
  emitSessionStatus(session);
}

export function setWorktreePath(id: string, worktreePath: string): void {
  const session = getSessionOrWarn(id, "setWorktreePath");
  if (!session) return;
  session.worktreePath = worktreePath;
  persistSession(session);
}

export function setResult(id: string, result: string): void {
  const session = getSessionOrWarn(id, "setResult");
  if (!session) return;
  session.result = result;
  persistSession(session);
  emitSessionStatus(session);
}

export function setError(id: string, error: string): void {
  const session = getSessionOrWarn(id, "setError");
  if (!session) return;
  session.error = error;
  persistSession(session);
  emitSessionStatus(session);
}

export function addPendingTool(id: string, toolUseID: string, name: string, input: Record<string, unknown>, agentID?: string): void {
  const session = getSessionOrWarn(id, "addPendingTool");
  if (!session) return;
  session.pendingTools.push({ toolUseID, name, input, agentID });
  persistSession(session);
  emitSessionStatus(session);
}

export function removePendingTool(id: string, toolUseID: string): void {
  const session = getSessionOrWarn(id, "removePendingTool");
  if (!session) return;
  session.pendingTools = session.pendingTools.filter(t => t.toolUseID !== toolUseID);
  persistSession(session);
  emitSessionStatus(session);
}

export function clearResult(id: string): void {
  const session = getSessionOrWarn(id, "clearResult");
  if (!session) return;
  session.result = null;
  session.error = null;
  persistSession(session);
  emitSessionStatus(session);
}

export function setArchived(id: string, archived: boolean): void {
  const session = getSessionOrWarn(id, "setArchived");
  if (!session) return;
  session.archived = archived;
  persistSession(session);
  emitSessionStatus(session);
}

export function addUsage(id: string, delta: SessionUsage): void {
  const session = getSessionOrWarn(id, "addUsage");
  if (!session) return;
  if (session.usage === null) {
    session.usage = { totalTokens: delta.totalTokens, costUSD: delta.costUSD };
  } else {
    session.usage.totalTokens += delta.totalTokens;
    session.usage.costUSD += delta.costUSD;
  }
  persistSession(session);
  emitSessionStatus(session);
}

function getLatestUserMessageTime(session: Session): number {
  const times = session.chat
    .filter(e => e.type === "user")
    .map(e => new Date(e.ts).getTime());
  return Math.max(new Date(session.createdAt).getTime(), ...times);
}

export function listSessions(): Session[] {
  return Array.from(sessions.values()).sort(
    (a, b) => getLatestUserMessageTime(b) - getLatestUserMessageTime(a)
  );
}
