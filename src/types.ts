export type JobStatus = "pending" | "planning" | "awaiting_approval" | "awaiting_tool_approval" | "awaiting_user_question" | "running" | "completed" | "failed" | "stopped";

export type JobMode = "auto" | "plan" | "edit";
export type JobEffort = "low" | "medium" | "high" | "max";
export type SandboxMode = "none" | "sandbox" | "docker" | "approval";

export type LogEntry =
  | { type: "text"; text: string; ts: string }
  | { type: "user"; text: string; ts: string }
  | { type: "tool_call"; name: string; input?: Record<string, unknown>; toolUseId?: string; output?: string; ts: string }
  | { type: "image"; mediaType: string; url: string; ts: string };

export interface InputFile {
  mediaType: string;
  filename: string;
}

export interface JobUsage {
  totalTokens: number;
  costUSD: number;
}

export interface Job {
  id: string;
  status: JobStatus;
  mode: JobMode;
  model: string | null;
  effort: JobEffort | null;
  prompt: string;
  title: string | null;
  tools: string[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  log: LogEntry[];
  cwd: string | null;
  useWorktree: boolean;
  worktreePath: string | null;
  plan: string | null;
  sessionId: string | null;
  result: string | null;
  error: string | null;
  images: InputFile[];
  pendingTools: Array<{ toolUseID: string; name: string; input: Record<string, unknown>; agentID?: string }>;
  archived: boolean;
  sandbox: SandboxMode;
  usage: JobUsage | null;
}
