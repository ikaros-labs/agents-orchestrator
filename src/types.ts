export type JobStatus = "pending" | "planning" | "awaiting_approval" | "running" | "completed" | "failed";

export type LogEntry =
  | { type: "text"; text: string; ts: string }
  | { type: "user"; text: string; ts: string }
  | { type: "tool_call"; name: string; input?: Record<string, unknown>; ts: string }
  | { type: "image"; mediaType: string; url: string; ts: string };

export interface InputFile {
  mediaType: string;
  filename: string;
}

export interface Job {
  id: string;
  status: JobStatus;
  prompt: string;
  tools: string[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  log: LogEntry[];
  cwd: string | null;
  plan: string | null;
  sessionId: string | null;
  result: string | null;
  error: string | null;
  images: InputFile[];
}
