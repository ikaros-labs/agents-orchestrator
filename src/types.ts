export type JobStatus = "pending" | "planning" | "awaiting_approval" | "awaiting_tool_approval" | "awaiting_user_question" | "running" | "completed" | "failed" | "stopped";

/** Runtime constants mirroring JobStatus — use these instead of bare string literals. */
export const JOB_STATUS = {
  PENDING: "pending",
  PLANNING: "planning",
  AWAITING_APPROVAL: "awaiting_approval",
  AWAITING_TOOL_APPROVAL: "awaiting_tool_approval",
  AWAITING_USER_QUESTION: "awaiting_user_question",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  STOPPED: "stopped",
} as const satisfies Record<string, JobStatus>;

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
