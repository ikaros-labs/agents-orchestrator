export type JobStatus = "pending" | "running" | "completed" | "failed";

export type LogEntry =
  | { type: "text"; text: string; ts: string }
  | { type: "tool_call"; name: string; ts: string };

export interface Job {
  id: string;
  status: JobStatus;
  prompt: string;
  tools: string[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  log: LogEntry[];
  result: string | null;
  error: string | null;
}
