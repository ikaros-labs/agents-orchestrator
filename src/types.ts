export type SessionStatus = "pending" | "planning" | "awaiting_approval" | "awaiting_tool_approval" | "awaiting_user_question" | "running" | "completed" | "failed" | "stopped";

export type SessionMode = "auto" | "plan" | "edit";
export type SessionEffort = "low" | "medium" | "high" | "max";
export type SandboxMode = "none" | "sandbox" | "docker" | "approval";

export type ChatEntry =
  | { type: "text"; text: string; ts: string }
  | { type: "user"; text: string; ts: string }
  | { type: "tool_call"; name: string; input?: Record<string, unknown>; toolUseId?: string; output?: string; ts: string }
  | { type: "image"; mediaType: string; url: string; ts: string };

export interface InputFile {
  mediaType: string;
  filename: string;
}

export interface SessionUsage {
  totalTokens: number;
  costUSD: number;
}

export interface Session {
  id: string;
  status: SessionStatus;
  mode: SessionMode;
  model: string | null;
  effort: SessionEffort | null;
  prompt: string;
  title: string | null;
  tools: string[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  chat: ChatEntry[];
  cwd: string | null;
  useWorktree: boolean;
  worktreePath: string | null;
  claudeSessionId: string | null;
  result: string | null;
  error: string | null;
  images: InputFile[];
  pendingTools: Array<{ toolUseID: string; name: string; input: Record<string, unknown>; agentID?: string }>;
  archived: boolean;
  sandbox: SandboxMode;
  usage: SessionUsage | null;
}
