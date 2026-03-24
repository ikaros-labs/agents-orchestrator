import type { Job, JobStatus, LogEntry } from "./types.ts";

const jobs = new Map<string, Job>();

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
    result: null,
    error: null,
  };
  jobs.set(id, job);
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
}

export function appendLog(id: string, entry: LogEntry): void {
  jobs.get(id)?.log.push(entry);
}

export function setResult(id: string, result: string): void {
  const job = jobs.get(id);
  if (!job) return;
  job.result = result;
}

export function setError(id: string, error: string): void {
  const job = jobs.get(id);
  if (!job) return;
  job.error = error;
}

export function listJobs(): Job[] {
  return Array.from(jobs.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}
