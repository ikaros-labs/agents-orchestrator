import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Job, JobStatus, LogEntry } from "./types.ts";

const DATA_DIR = "./data/jobs";
mkdirSync(DATA_DIR, { recursive: true });

const jobs = new Map<string, Job>();

function persistJob(job: Job): void {
  writeFileSync(`${DATA_DIR}/${job.id}.json`, JSON.stringify(job, null, 2));
}

export function loadStore(): void {
  for (const file of readdirSync(DATA_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const job = JSON.parse(readFileSync(`${DATA_DIR}/${file}`, "utf8")) as Job;
      jobs.set(job.id, job);
    } catch {
      // skip corrupt files
    }
  }
}

export function createJob(id: string, prompt: string, tools: string[], cwd: string | null = null): Job {
  const job: Job = {
    id,
    status: "pending",
    prompt,
    tools,
    cwd,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    log: [],
    plan: null,
    sessionId: null,
    result: null,
    error: null,
  };
  jobs.set(id, job);
  persistJob(job);
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function setStatus(id: string, status: JobStatus): void {
  const job = jobs.get(id);
  if (!job) return;
  job.status = status;
  if (status === "running") job.startedAt = new Date().toISOString();
  if (status === "completed" || status === "failed") job.finishedAt = new Date().toISOString();
  persistJob(job);
}

export function appendLog(id: string, entry: LogEntry): void {
  const job = jobs.get(id);
  if (!job) return;
  job.log.push(entry);
  persistJob(job);
}

export function setPlan(id: string, plan: string): void {
  const job = jobs.get(id);
  if (!job) return;
  job.plan = plan;
  persistJob(job);
}

export function setSessionId(id: string, sessionId: string): void {
  const job = jobs.get(id);
  if (!job) return;
  job.sessionId = sessionId;
  persistJob(job);
}

export function setResult(id: string, result: string): void {
  const job = jobs.get(id);
  if (!job) return;
  job.result = result;
  persistJob(job);
}

export function setError(id: string, error: string): void {
  const job = jobs.get(id);
  if (!job) return;
  job.error = error;
  persistJob(job);
}

export function clearResult(id: string): void {
  const job = jobs.get(id);
  if (!job) return;
  job.result = null;
  job.error = null;
  persistJob(job);
}

export function listJobs(): Job[] {
  return Array.from(jobs.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}
