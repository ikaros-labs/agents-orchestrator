import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { homedir } from "node:os";
import * as store from "./store.ts";

const execFileAsync = promisify(execFile);

// ── Directory constants ──────────────────────────────────────────────────────

export const WORKTREES_DIR = process.env.AGENT_WORKTREES_DIR ?? join(homedir(), ".agent-worktrees");
export const LOGS_DIR = "./logs";
export const IMAGES_DIR = "./data/images";
await mkdir(LOGS_DIR, { recursive: true });
await mkdir(IMAGES_DIR, { recursive: true });

// ── Media type helpers ───────────────────────────────────────────────────────

export const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const DOCUMENT_MEDIA_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/html",
  "text/csv",
  "text/xml",
  "application/xml",
]);
export const ALLOWED_MEDIA_TYPES = new Set([...IMAGE_MEDIA_TYPES, ...DOCUMENT_MEDIA_TYPES]);

export const MEDIA_TYPE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/html": "html",
  "text/csv": "csv",
  "text/xml": "xml",
  "application/xml": "xml",
};

export const DEFAULT_TOOLS = ["Read", "Edit", "Glob", "Write", "Grep", "WebSearch", "WebFetch", "AskUserQuestion", "ExitPlanMode"];

const WORKTREE_SYSTEM_PROMPT_APPEND = `
You are running inside a git worktree that has already been set up for you.
- Do NOT create a new branch or a new worktree.
- All bash commands and other tools must be run inside this worktree directory, not in the original parent repository.
- After finishing your task, if you modified any files, you MUST create a GitHub pull request using the GitHub CLI (\`gh pr create\`).
`;

// ── Types ────────────────────────────────────────────────────────────────────

export interface RawImage { mediaType: string; data: string }

function worktreeSystemPrompt(inWorktree: boolean) {
  if (!inWorktree) return {};
  return {
    systemPrompt: {
      type: "preset" as const,
      preset: "claude_code" as const,
      append: WORKTREE_SYSTEM_PROMPT_APPEND,
    },
  };
}

// ── Tool approval map ────────────────────────────────────────────────────────
// When Claude wants to use a tool during execution, canUseTool stores a
// Promise resolver here keyed by job ID, then by toolUseID. This supports
// parallel tool calls (e.g. from subagents) where multiple approvals can be
// in-flight simultaneously. The approve/reject endpoints resolve each by
// toolUseID, unblocking the specific agent call that was waiting.

const pendingToolApprovals = new Map<string, Map<string, { resolve: (d: PermissionResult) => void }>>();

/** Returns true if a pending resolver exists for this job + toolUseID. */
export function hasPendingApproval(id: string, toolUseID: string): boolean {
  return pendingToolApprovals.get(id)?.has(toolUseID) ?? false;
}

/**
 * Resolves (and removes) a pending tool approval. Returns false if no resolver
 * was found, true on success.
 */
export function resolveToolApproval(id: string, toolUseID: string, result: PermissionResult): boolean {
  const jobApprovals = pendingToolApprovals.get(id);
  const pending = jobApprovals?.get(toolUseID);
  if (!pending) return false;
  jobApprovals!.delete(toolUseID);
  if (jobApprovals!.size === 0) pendingToolApprovals.delete(id);
  pending.resolve(result);
  return true;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function makeCanUseTool(id: string): CanUseTool {
  return async (toolName: string, input: Record<string, unknown>, options): Promise<PermissionResult> => {
    const { toolUseID, agentID } = options;

    // Deny ExitPlanMode so the planning query ends cleanly here.
    // Execution is triggered separately via executeJob() once the user approves the plan.
    if (toolName === "ExitPlanMode") {
      return { behavior: "deny", message: "Stop the execution. Awaiting plan approval from user." };
    }

    store.addPendingTool(id, toolUseID, toolName, input, agentID);
    console.log(`[canUseTool] id=${id} tool=${toolName} toolUseID=${toolUseID} → awaiting approval`);

    const job = store.getJob(id);
    if (job && job.status !== "awaiting_tool_approval" && job.status !== "awaiting_user_question") {
      store.setStatus(id, toolName === "AskUserQuestion" ? "awaiting_user_question" : "awaiting_tool_approval");
    }

    if (!pendingToolApprovals.has(id)) {
      pendingToolApprovals.set(id, new Map());
    }
    return new Promise<PermissionResult>((resolve) => {
      pendingToolApprovals.get(id)!.set(toolUseID, { resolve });
    });
  };
}

/** Handles the SDK's inconsistent session_id vs sessionId casing. */
function extractSessionId(message: any): string | undefined {
  return message.session_id ?? message.sessionId;
}

function handleJobError(id: string, err: unknown): void {
  store.setError(id, err instanceof Error ? err.message : String(err));
  store.setStatus(id, "failed");
}

/** Save base64 image data to disk and return the server-relative URL. */
async function saveImage(jobId: string, index: number, mediaType: string, base64Data: string): Promise<string> {
  const ext = MEDIA_TYPE_EXT[mediaType] ?? "bin";
  const dir = `${IMAGES_DIR}/${jobId}`;
  await mkdir(dir, { recursive: true });
  const filename = `${index}.${ext}`;
  await writeFile(`${dir}/${filename}`, Buffer.from(base64Data, "base64"));
  return `/images/${jobId}/${filename}`;
}

/**
 * Drives the `for await` loop over a query stream, handling NDJSON logging,
 * content block processing, and sessionId capture in one place.
 * - `collectPlanText`: if true, text blocks are accumulated and returned (used by plan/revise jobs)
 * - `captureResult`: if true, store.setResult is called on result messages (used by execute jobs)
 */
async function runQueryStream(
  id: string,
  stream: AsyncIterable<any>,
  imageCounter: number,
  opts: { collectPlanText?: boolean; captureResult?: boolean } = {}
): Promise<string[]> {
  const planTexts: string[] = [];
  for await (const message of stream) {
    const ts = new Date().toISOString();
    await appendFile(`${LOGS_DIR}/${id}.ndjson`, JSON.stringify({ ts, ...message }) + "\n");
    if (message.type === "assistant" && message.message?.content) {
      for (const block of message.message.content) {
        if ("text" in block) {
          store.appendLog(id, { type: "text", text: block.text, ts });
          if (opts.collectPlanText) planTexts.push(block.text);
        } else if ("name" in block) {
          store.appendLog(id, { type: "tool_call", name: block.name, input: (block as any).input, ts });
        } else if ((block as any).type === "image") {
          const b = block as any;
          if (b.source?.type === "base64") {
            const url = await saveImage(id, imageCounter++, b.source.media_type, b.source.data);
            store.appendLog(id, { type: "image", mediaType: b.source.media_type, url, ts });
          }
        }
      }
    } else if (message.type === "result") {
      const sessionId = extractSessionId(message);
      if (sessionId) store.setSessionId(id, sessionId);
      if (opts.captureResult) store.setResult(id, message.subtype);
    }
  }
  return planTexts;
}

/** Build a multimodal prompt iterable when files are provided; otherwise fall back to a plain string. */
async function* makePrompt(prompt: string, rawImages: RawImage[], jobId: string): AsyncIterable<any> {
  // Save files to disk and build content blocks (image or document depending on type)
  const contentBlocks = await Promise.all(
    rawImages.map(async (img, i) => {
      await saveImage(jobId, i, img.mediaType, img.data);
      if (IMAGE_MEDIA_TYPES.has(img.mediaType)) {
        return {
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: img.mediaType as any,
            data: img.data,
          },
        };
      } else {
        return {
          type: "document" as const,
          source: {
            type: "base64" as const,
            media_type: img.mediaType as any,
            data: img.data,
          },
        };
      }
    })
  );
  yield {
    type: "user" as const,
    message: {
      role: "user" as const,
      content: [
        ...contentBlocks,
        { type: "text" as const, text: prompt },
      ],
    },
    parent_tool_use_id: null,
  };
}

// ── Worktree helpers ─────────────────────────────────────────────────────────

/**
 * Creates a git worktree for a job at `WORKTREES_DIR/<jobId>` and returns the
 * absolute path to the new worktree. The base directory defaults to
 * `~/.agent-worktrees` and can be overridden via the `AGENT_WORKTREES_DIR`
 * environment variable. Throws if `cwd` is not inside a git repository or if
 * `git worktree add` fails.
 */
async function createWorktree(cwd: string, jobId: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
  const gitRoot = stdout.trim();
  const worktreesParent = WORKTREES_DIR;
  await mkdir(worktreesParent, { recursive: true });
  const worktreePath = join(worktreesParent, jobId);
  const branchName = `agent/${jobId}`;
  await execFileAsync("git", ["-C", gitRoot, "worktree", "add", "-b", branchName, worktreePath]);
  return worktreePath;
}

/**
 * Resolves the effective cwd for an agent run.
 * - If `useWorktree` is false or `cwd` is null, returns `cwd` unchanged.
 * - Otherwise attempts to create a git worktree; on success stores the path on
 *   the job and returns it. On failure logs a warning and falls back to `cwd`.
 */
async function resolveEffectiveCwd(id: string, cwd: string | null, useWorktree: boolean): Promise<string | null> {
  if (!useWorktree || !cwd) return cwd;
  try {
    const worktreePath = await createWorktree(cwd, id);
    store.setWorktreePath(id, worktreePath);
    console.log(`[worktree] created for job ${id}: ${worktreePath}`);
    return worktreePath;
  } catch (err) {
    console.warn(`[worktree] failed to create worktree for job ${id} (falling back to cwd): ${err}`);
    return cwd;
  }
}

// ── Job runners (exported) ───────────────────────────────────────────────────

export async function planJob(id: string, prompt: string, tools: string[], cwd: string | null, rawImages: RawImage[], useWorktree: boolean = false): Promise<void> {
  console.log(`[planJob] id=${id}`);
  store.setStatus(id, "planning");
  const effectiveCwd = await resolveEffectiveCwd(id, cwd, useWorktree);
  const promptArg = rawImages.length > 0 ? makePrompt(prompt, rawImages, id) : prompt;
  try {
    const stream = query({
      prompt: promptArg as any,
      options: { allowedTools: tools, permissionMode: "plan", canUseTool: makeCanUseTool(id), ...worktreeSystemPrompt(useWorktree), ...(effectiveCwd ? { cwd: effectiveCwd } : {}) },
    });
    const planTexts = await runQueryStream(id, stream, rawImages.length, { collectPlanText: true });
    store.setPlan(id, planTexts.join("\n"));
    store.setStatus(id, "awaiting_approval");
  } catch (err) {
    handleJobError(id, err);
  }
}

export async function revisePlanJob(id: string, feedback: string, sessionId: string, tools: string[], cwd: string | null): Promise<void> {
  console.log(`[revisePlanJob] id=${id}`);
  store.setStatus(id, "planning");
  store.appendLog(id, { type: "user", text: feedback, ts: new Date().toISOString() });
  const inWorktree = !!store.getJob(id)?.worktreePath;
  try {
    const stream = query({
      prompt: feedback,
      options: { allowedTools: tools, permissionMode: "plan", canUseTool: makeCanUseTool(id), resume: sessionId, ...worktreeSystemPrompt(inWorktree), ...(cwd ? { cwd } : {}) },
    });
    const planTexts = await runQueryStream(id, stream, 0, { collectPlanText: true });
    store.setPlan(id, planTexts.join("\n"));
    store.setStatus(id, "awaiting_approval");
  } catch (err) {
    handleJobError(id, err);
  }
}

export async function directExecuteJob(id: string, prompt: string, tools: string[], cwd: string | null, rawImages: RawImage[], useWorktree: boolean = false): Promise<void> {
  console.log(`[directExecuteJob] id=${id}`);
  store.setStatus(id, "running");
  const effectiveCwd = await resolveEffectiveCwd(id, cwd, useWorktree);
  const inWorktree = !!store.getJob(id)?.worktreePath;
  const promptArg = rawImages.length > 0 ? makePrompt(prompt, rawImages, id) : prompt;
  try {
    const stream = query({
      prompt: promptArg as any,
      options: { permissionMode: "acceptEdits", canUseTool: makeCanUseTool(id), ...worktreeSystemPrompt(inWorktree), ...(effectiveCwd ? { cwd: effectiveCwd } : {}) },
    });
    await runQueryStream(id, stream, rawImages.length, { captureResult: true });
    store.setStatus(id, "completed");
  } catch (err) {
    handleJobError(id, err);
  }
}

export async function executeJob(id: string, sessionId: string, tools: string[], cwd: string | null): Promise<void> {
  console.log(`[executeJob] id=${id}`);
  store.setStatus(id, "running");
  const inWorktree = !!store.getJob(id)?.worktreePath;
  try {
    const stream = query({
      prompt: "The plan has been approved. Proceed with execution now.",
      options: { permissionMode: "acceptEdits", canUseTool: makeCanUseTool(id), resume: sessionId, ...worktreeSystemPrompt(inWorktree), ...(cwd ? { cwd } : {}) },
    });
    await runQueryStream(id, stream, 0, { captureResult: true });
    store.setStatus(id, "completed");
  } catch (err) {
    handleJobError(id, err);
  }
}

export async function followUpJob(id: string, prompt: string, sessionId: string, tools: string[], cwd: string | null, rawImages: RawImage[]): Promise<void> {
  console.log(`[followUpJob] id=${id}`);
  store.setStatus(id, "running");
  store.clearResult(id);
  store.appendLog(id, { type: "user", text: prompt, ts: new Date().toISOString() });
  const promptArg = rawImages.length > 0
    ? makePrompt(prompt, rawImages, `${id}-followup-${Date.now()}`)
    : prompt;
  const inWorktree = !!store.getJob(id)?.worktreePath;
  try {
    const stream = query({
      prompt: promptArg as any,
      options: { permissionMode: "acceptEdits", canUseTool: makeCanUseTool(id), resume: sessionId, ...worktreeSystemPrompt(inWorktree), ...(cwd ? { cwd } : {}) },
    });
    await runQueryStream(id, stream, 0, { captureResult: true });
    store.setStatus(id, "completed");
  } catch (err) {
    handleJobError(id, err);
  }
}
