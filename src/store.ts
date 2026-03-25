import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { InputFile, Job, JobMode, JobStatus, LogEntry } from "./types.ts";

const DATA_DIR = "./data/jobs";
mkdirSync(DATA_DIR, { recursive: true });

const jobs = new Map<string, Job>();

// ── Event emitter ─────────────────────────────────────────────────────────────

export type StoreEvent =
  | { type: "job_created"; job: Job }
  | { type: "job_status"; jobId: string; status: JobStatus; startedAt: string | null; finishedAt: string | null; result: string | null; error: string | null; plan: string | null; sessionId: string | null; pendingTools: Job["pendingTools"] }
  | { type: "log_entry"; jobId: string; entry: LogEntry; index: number };

const subscribers = new Set<(e: StoreEvent) => void>();

export function subscribe(fn: (e: StoreEvent) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function emit(e: StoreEvent): void {
  subscribers.forEach(fn => fn(e));
}

function emitJobStatus(job: Job): void {
  emit({
    type: "job_status",
    jobId: job.id,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    result: job.result,
    error: job.error,
    plan: job.plan,
    sessionId: job.sessionId,
    pendingTools: job.pendingTools,
  });
}

function persistJob(job: Job): void {
  writeFileSync(`${DATA_DIR}/${job.id}.json`, JSON.stringify(job, null, 2));
}

export function loadStore(): void {
  for (const file of readdirSync(DATA_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const job = JSON.parse(readFileSync(`${DATA_DIR}/${file}`, "utf8")) as Job;
      // Migrate old single-pendingTool format to array
      if (!Array.isArray(job.pendingTools)) {
        job.pendingTools = [];
      }
      // Migrate jobs created before worktree support
      if (job.useWorktree === undefined) job.useWorktree = false;
      if (job.worktreePath === undefined) job.worktreePath = null;
      jobs.set(job.id, job);
    } catch {
      // skip corrupt files
    }
  }
}

export function createJob(id: string, prompt: string, tools: string[], cwd: string | null = null, images: InputFile[] = [], mode: JobMode = "auto", useWorktree: boolean = true): Job {
  const job: Job = {
    id,
    status: "pending",
    mode,
    prompt,
    tools,
    cwd,
    useWorktree,
    worktreePath: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    log: [],
    plan: null,
    sessionId: null,
    result: null,
    error: null,
    images,
    pendingTools: [],
  };
  jobs.set(id, job);
  persistJob(job);
  emit({ type: "job_created", job });
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function setStatus(id: string, status: JobStatus): void {
  const job = jobs.get(id);
  if (!job) { console.warn(`[store] setStatus: job not found: ${id}`); return; }
  job.status = status;
  if (status === "running") job.startedAt = new Date().toISOString();
  if (status === "completed" || status === "failed") job.finishedAt = new Date().toISOString();
  persistJob(job);
  emitJobStatus(job);
}

export function appendLog(id: string, entry: LogEntry): void {
  const job = jobs.get(id);
  if (!job) { console.warn(`[store] appendLog: job not found: ${id}`); return; }
  job.log.push(entry);
  persistJob(job);
  emit({ type: "log_entry", jobId: id, entry, index: job.log.length - 1 });
}

export function setPlan(id: string, plan: string): void {
  const job = jobs.get(id);
  if (!job) { console.warn(`[store] setPlan: job not found: ${id}`); return; }
  job.plan = plan;
  persistJob(job);
  emitJobStatus(job);
}

export function setSessionId(id: string, sessionId: string): void {
  const job = jobs.get(id);
  if (!job) { console.warn(`[store] setSessionId: job not found: ${id}`); return; }
  job.sessionId = sessionId;
  persistJob(job);
}

export function setWorktreePath(id: string, worktreePath: string): void {
  const job = jobs.get(id);
  if (!job) { console.warn(`[store] setWorktreePath: job not found: ${id}`); return; }
  job.worktreePath = worktreePath;
  persistJob(job);
}

export function setResult(id: string, result: string): void {
  const job = jobs.get(id);
  if (!job) { console.warn(`[store] setResult: job not found: ${id}`); return; }
  job.result = result;
  persistJob(job);
  emitJobStatus(job);
}

export function setError(id: string, error: string): void {
  const job = jobs.get(id);
  if (!job) { console.warn(`[store] setError: job not found: ${id}`); return; }
  job.error = error;
  persistJob(job);
  emitJobStatus(job);
}

export function addPendingTool(id: string, toolUseID: string, name: string, input: Record<string, unknown>, agentID?: string): void {
  const job = jobs.get(id);
  if (!job) { console.warn(`[store] addPendingTool: job not found: ${id}`); return; }
  job.pendingTools.push({ toolUseID, name, input, agentID });
  persistJob(job);
  emitJobStatus(job);
}

export function removePendingTool(id: string, toolUseID: string): void {
  const job = jobs.get(id);
  if (!job) { console.warn(`[store] removePendingTool: job not found: ${id}`); return; }
  job.pendingTools = job.pendingTools.filter(t => t.toolUseID !== toolUseID);
  persistJob(job);
  emitJobStatus(job);
}

export function clearResult(id: string): void {
  const job = jobs.get(id);
  if (!job) { console.warn(`[store] clearResult: job not found: ${id}`); return; }
  job.result = null;
  job.error = null;
  persistJob(job);
  emitJobStatus(job);
}

function getLatestUserMessageTime(job: Job): number {
  const times = job.log
    .filter(e => e.type === "user")
    .map(e => new Date(e.ts).getTime());
  return Math.max(new Date(job.createdAt).getTime(), ...times);
}

export function listJobs(): Job[] {
  return Array.from(jobs.values()).sort(
    (a, b) => getLatestUserMessageTime(b) - getLatestUserMessageTime(a)
  );
}
