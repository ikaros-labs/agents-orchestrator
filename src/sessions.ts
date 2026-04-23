import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import * as store from "./store.ts";
import type { SessionEffort, SandboxMode } from "./types.ts";
import { jobStderr, makeStderrCapturingSpawner, makeDockerSpawner } from "./spawners.ts";
import { resolveEffectiveCwd } from "./worktree.ts";

// ── Active session AbortControllers ──────────────────────────────────────────
// One AbortController per running session. Used by stopSession() to cancel the SDK query.

const activeControllers = new Map<string, AbortController>();

// ── Directory constants ──────────────────────────────────────────────────────

const AGENT_DIR = process.env.AGENT_ORCHESTRATOR_DIR ?? join(homedir(), ".agent-orchestrator");
export const LOGS_DIR = join(AGENT_DIR, "logs");
export const IMAGES_DIR = join(AGENT_DIR, "files");
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

export const DEFAULT_TOOLS = ["Read", "Edit", "Glob", "Write", "Grep", "WebSearch", "WebFetch", "AskUserQuestion", "ExitPlanMode", "mcp__orchestrator__attach_files"];

// ── AttachFiles MCP tool ─────────────────────────────────────────────────────

const EXT_TO_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp",
  pdf: "application/pdf",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
};

function makeAttachFilesServer(sessionId: string) {
  return createSdkMcpServer({
    name: "orchestrator",
    tools: [
      tool(
        "attach_files",
        `Expose local files so the user can view or download them. Returns a public URL for each file.
Use the returned URLs in your markdown response — inline images with ![alt](url), download links with [filename](url).`,
        { paths: z.array(z.string()).describe("Absolute file paths to expose") },
        async ({ paths }) => {
          const results: string[] = [];
          for (const filePath of paths) {
            const ext = extname(filePath).slice(1).toLowerCase();
            const filename = `${crypto.randomUUID()}.${ext || "bin"}`;
            const dir = `${IMAGES_DIR}/${sessionId}`;
            await mkdir(dir, { recursive: true });
            await writeFile(`${dir}/${filename}`, await readFile(filePath));
            results.push(`${basename(filePath)}: /images/${sessionId}/${filename}`);
          }
          return { content: [{ type: "text" as const, text: results.join("\n") }] };
        }
      ),
    ],
  });
}

const WORKTREE_SYSTEM_PROMPT_APPEND = `
You are running inside a git worktree that has already been set up for you.
- Do NOT create a new branch or a new worktree.
- All bash commands and other tools must be run inside this worktree directory, not in the original parent repository.
- After finishing your task, if you modified any files, you MUST create a GitHub pull request using the GitHub CLI (\`gh pr create\`) — don't forget to push your changes beforehand.
- To show files (images, videos, or other media) to the user, use the \`mcp__orchestrator__attach_files\` tool.
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

// ── Sandbox-aware query options builder ──────────────────────────────────────
//
// We use the claude_code preset for tool availability and let the SDK's
// permission system handle approvals (including sandbox denyRead enforcement).
// allowedTools blanket-bypasses the permission system so we avoid it.

function buildQueryOptions(
  id: string,
  sandbox: SandboxMode,
  cwd: string | null,
  inWorktree: boolean,
  opts: { claudeSessionId?: string; model?: string | null; effort?: SessionEffort | null; abortController: AbortController },
): Record<string, any> {
  const base = {
    tools: { type: "preset" as const, preset: "claude_code" as const },
    settingSources: ["user", "project", "local"] as const,
    mcpServers: { orchestrator: makeAttachFilesServer(id) },
    abortController: opts.abortController,
    spawnClaudeCodeProcess: makeStderrCapturingSpawner(id),
    ...(opts.claudeSessionId ? { resume: opts.claudeSessionId } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
    ...worktreeSystemPrompt(inWorktree),
    ...(cwd ? { cwd } : {}),
  };

  if (sandbox === "approval") {
    return { ...base, permissionMode: "acceptEdits" as const, canUseTool: makeCanUseTool(id) };
  }

  // Non-approval modes use acceptEdits; the SDK permission system handles approvals.
  const autoApprove = {
    ...base,
    permissionMode: "acceptEdits" as const,
  };

  if (sandbox === "sandbox") {
    return {
      ...autoApprove,
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: true,
        filesystem: {
          denyRead: ["/root/.ssh", "~/.ssh"],
        },
      },
    };
  }

  if (sandbox === "docker") {
    return {
      ...autoApprove,
      spawnClaudeCodeProcess: makeDockerSpawner(id, cwd),
    };
  }

  // "none" — auto-approve with no extra isolation
  return autoApprove;
}

// ── Tool approval map ────────────────────────────────────────────────────────
// When Claude wants to use a tool during execution, canUseTool stores a
// Promise resolver here keyed by session ID, then by toolUseID. This supports
// parallel tool calls (e.g. from subagents) where multiple approvals can be
// in-flight simultaneously. The approve/reject endpoints resolve each by
// toolUseID, unblocking the specific agent call that was waiting.

const pendingToolApprovals = new Map<string, Map<string, { resolve: (d: PermissionResult) => void }>>();

/** Returns true if a pending resolver exists for this session + toolUseID. */
export function hasPendingApproval(id: string, toolUseID: string): boolean {
  return pendingToolApprovals.get(id)?.has(toolUseID) ?? false;
}

/**
 * Resolves (and removes) a pending tool approval. Returns false if no resolver
 * was found, true on success.
 */
export function resolveToolApproval(id: string, toolUseID: string, result: PermissionResult): boolean {
  console.log(`[resolveToolApproval] id=${id} toolUseID=${toolUseID} result=${JSON.stringify(result)}`);
  const sessionApprovals = pendingToolApprovals.get(id);
  const pending = sessionApprovals?.get(toolUseID);
  if (!pending) return false;
  sessionApprovals!.delete(toolUseID);
  if (sessionApprovals!.size === 0) pendingToolApprovals.delete(id);
  pending.resolve(result);
  return true;
}

/**
 * Stops a running session: aborts its SDK query, rejects any pending tool approvals,
 * and marks the session as stopped. Safe to call from any active status.
 */
export function stopSession(id: string): boolean {
  const sessionApprovals = pendingToolApprovals.get(id);
  const controller = activeControllers.get(id);
  if (!controller && !sessionApprovals?.size) return false;

  if (sessionApprovals) {
    sessionApprovals.clear();
    pendingToolApprovals.delete(id);
  }

  if (controller) {
    controller.abort();
    activeControllers.delete(id);
    jobStderr.delete(id);
  }

  store.setStatus(id, "stopped");
  return true;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function makeCanUseTool(id: string): CanUseTool {
  return async (toolName: string, input: Record<string, unknown>, options): Promise<PermissionResult> => {
    const { toolUseID, agentID } = options;

    // Deny ExitPlanMode so the planning query ends cleanly here.
    // Execution is triggered separately via executeSession() once the user approves the plan.
    if (toolName === "ExitPlanMode") {
      return { behavior: "deny", message: "Stop the execution. Awaiting plan approval from user." };
    }

    // Auto-approve attach_files — it only copies files for display, no confirmation needed.
    if (toolName === "mcp__orchestrator__attach_files") {
      return { behavior: "allow", updatedInput: input };
    }

    store.addPendingTool(id, toolUseID, toolName, input, agentID);
    console.log(`[canUseTool] id=${id} tool=${toolName} toolUseID=${toolUseID} → awaiting approval`);

    const session = store.getSession(id);
    if (session && session.status !== "awaiting_tool_approval" && session.status !== "awaiting_user_question") {
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

function handleSessionError(id: string, err: unknown): void {
  let message = err instanceof Error ? err.message : String(err);
  // Append captured stderr if available — often contains the real reason for crashes
  const stderr = jobStderr.get(id);
  if (stderr?.length) {
    message += "\n\nProcess stderr:\n" + stderr.join("\n");
  }
  jobStderr.delete(id);
  store.setError(id, message);
  store.setStatus(id, "failed");
}

/** Save base64 image data to disk and return the server-relative URL. */
async function saveImage(sessionId: string, index: number, mediaType: string, base64Data: string): Promise<string> {
  const ext = MEDIA_TYPE_EXT[mediaType] ?? "bin";
  const dir = `${IMAGES_DIR}/${sessionId}`;
  await mkdir(dir, { recursive: true });
  const filename = `${index}.${ext}`;
  await writeFile(`${dir}/${filename}`, Buffer.from(base64Data, "base64"));
  return `/images/${sessionId}/${filename}`;
}

/**
 * Drives the `for await` loop over a query stream, handling NDJSON logging,
 * content block processing, and claudeSessionId capture in one place.
 * - `captureResult`: if true, store.setResult is called on result messages (used by execute sessions)
 */
async function runQueryStream(
  id: string,
  stream: AsyncIterable<any>,
  imageCounter: number,
  opts: { captureResult?: boolean } = {}
): Promise<void> {
  // Maps tool_use_id → chat entry index so we can patch with output later
  const toolCallIndices = new Map<string, number>();
  for await (const message of stream) {
    const ts = new Date().toISOString();
    await appendFile(`${LOGS_DIR}/${id}.ndjson`, JSON.stringify({ ts, ...message }) + "\n");
    if (message.type === "assistant" && message.message?.content) {
      for (const block of message.message.content) {
        if ("text" in block) {
          store.appendChat(id, { type: "text", text: block.text, ts });
        } else if ("name" in block) {
          const toolUseId: string | undefined = (block as any).id;
          store.appendChat(id, { type: "tool_call", name: block.name, input: (block as any).input, toolUseId, ts });
          if (toolUseId) {
            const session = store.getSession(id);
            if (session) toolCallIndices.set(toolUseId, session.chat.length - 1);
          }
        } else if ((block as any).type === "image") {
          const b = block as any;
          if (b.source?.type === "base64") {
            const url = await saveImage(id, imageCounter++, b.source.media_type, b.source.data);
            store.appendChat(id, { type: "image", mediaType: b.source.media_type, url, ts });
          }
        }
      }
    } else if (message.type === "user" && message.message?.content) {
      for (const block of message.message.content) {
        if ((block as any).type === "tool_result") {
          const toolUseId: string = (block as any).tool_use_id;
          const index = toolCallIndices.get(toolUseId);
          if (index !== undefined) {
            const raw = (block as any).content;
            const output = typeof raw === "string" ? raw
              : Array.isArray(raw) ? raw.map((c: any) => c.text ?? "").join("") : "";
            store.patchChat(id, index, { output });
          }
        }
      }
    } else if (message.type === "system" && message.subtype === "init") {
      const claudeSessionId = message.session_id ?? message.sessionId;
      if (claudeSessionId) store.setClaudeSessionId(id, claudeSessionId);
    } else if (message.type === "result") {
      if (opts.captureResult) store.setResult(id, message.subtype);
      const u = message.usage;
      if (u) {
        store.addUsage(id, {
          totalTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          costUSD: message.total_cost_usd ?? 0,
        });
      }
    }
  }
}

/** Build a multimodal prompt iterable when files are provided; otherwise fall back to a plain string. */
async function* makePrompt(prompt: string, rawImages: RawImage[], sessionId: string): AsyncIterable<any> {
  // Save files to disk and build content blocks (image or document depending on type)
  const contentBlocks = await Promise.all(
    rawImages.map(async (img, i) => {
      await saveImage(sessionId, i, img.mediaType, img.data);
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

// ── Session runner lifecycle ──────────────────────────────────────────────────

/**
 * Shared wrapper for all session runners. Creates an AbortController, registers it,
 * and handles abort detection, error handling, and cleanup in one place.
 */
async function runWithController(
  id: string,
  fn: (controller: AbortController) => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  activeControllers.set(id, controller);
  try {
    await fn(controller);
    if (controller.signal.aborted) return;
  } catch (err) {
    if (controller.signal.aborted) return;
    handleSessionError(id, err);
  } finally {
    activeControllers.delete(id);
    jobStderr.delete(id);
  }
}

// ── Session runners (exported) ───────────────────────────────────────────────

export async function planSession(id: string, prompt: string, cwd: string | null, rawImages: RawImage[], useWorktree: boolean = false): Promise<void> {
  console.log(`[planSession] id=${id}`);
  store.setStatus(id, "planning");
  const effectiveCwd = await resolveEffectiveCwd(id, cwd, useWorktree);
  const promptArg = rawImages.length > 0 ? makePrompt(prompt, rawImages, id) : prompt;
  const session = store.getSession(id);
  await runWithController(id, async (controller) => {
    // Planning phase always uses "plan" mode regardless of sandbox setting
    const stream = query({
      prompt: promptArg as any,
      options: {
        tools: { type: "preset" as const, preset: "claude_code" as const },
        permissionMode: "plan",
        canUseTool: makeCanUseTool(id),
        settingSources: ["user", "project", "local"],
        mcpServers: { orchestrator: makeAttachFilesServer(id) },
        abortController: controller,
        ...(session?.model ? { model: session.model } : {}),
        ...(session?.effort ? { effort: session.effort } : {}),
        ...worktreeSystemPrompt(useWorktree),
        ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
      },
    });
    await runQueryStream(id, stream, rawImages.length, {});
    if (controller.signal.aborted) return;
    store.setStatus(id, "awaiting_approval");
  });
}

export async function revisePlanSession(id: string, feedback: string, claudeSessionId: string, cwd: string | null): Promise<void> {
  console.log(`[revisePlanSession] id=${id}`);
  store.setStatus(id, "planning");
  store.appendChat(id, { type: "user", text: feedback, ts: new Date().toISOString() });
  const session = store.getSession(id);
  const inWorktree = !!session?.worktreePath;
  await runWithController(id, async (controller) => {
    // Planning phase always uses "plan" mode regardless of sandbox setting
    const stream = query({
      prompt: feedback,
      options: {
        tools: { type: "preset" as const, preset: "claude_code" as const },
        permissionMode: "plan",
        canUseTool: makeCanUseTool(id),
        settingSources: ["user", "project", "local"],
        mcpServers: { orchestrator: makeAttachFilesServer(id) },
        resume: claudeSessionId,
        abortController: controller,
        ...(session?.model ? { model: session.model } : {}),
        ...(session?.effort ? { effort: session.effort } : {}),
        ...worktreeSystemPrompt(inWorktree),
        ...(cwd ? { cwd } : {}),
      },
    });
    await runQueryStream(id, stream, 0, {});
    if (controller.signal.aborted) return;
    store.setStatus(id, "awaiting_approval");
  });
}

export async function directExecuteSession(id: string, prompt: string, cwd: string | null, rawImages: RawImage[], useWorktree: boolean = false): Promise<void> {
  console.log(`[directExecuteSession] id=${id}`);
  store.setStatus(id, "running");
  const effectiveCwd = await resolveEffectiveCwd(id, cwd, useWorktree);
  const session = store.getSession(id);
  const sandbox = session?.sandbox ?? "none";
  const inWorktree = !!session?.worktreePath;
  const promptArg = rawImages.length > 0 ? makePrompt(prompt, rawImages, id) : prompt;
  await runWithController(id, async (controller) => {
    const stream = query({
      prompt: promptArg as any,
      options: buildQueryOptions(id, sandbox, effectiveCwd, inWorktree, {
        model: session?.model, effort: session?.effort, abortController: controller,
      }),
    });
    await runQueryStream(id, stream, rawImages.length, { captureResult: true });
    if (controller.signal.aborted) return;
    store.setStatus(id, "completed");
  });
}

export async function executeSession(id: string, claudeSessionId: string, cwd: string | null): Promise<void> {
  console.log(`[executeSession] id=${id}`);
  store.setStatus(id, "running");
  const session = store.getSession(id);
  const sandbox = session?.sandbox ?? "none";
  const inWorktree = !!session?.worktreePath;
  await runWithController(id, async (controller) => {
    const stream = query({
      prompt: "The plan has been approved. Proceed with execution now.",
      options: buildQueryOptions(id, sandbox, cwd, inWorktree, {
        claudeSessionId, model: session?.model, effort: session?.effort, abortController: controller,
      }),
    });
    await runQueryStream(id, stream, 0, { captureResult: true });
    if (controller.signal.aborted) return;
    store.setStatus(id, "completed");
  });
}

export async function followUpSession(id: string, prompt: string, claudeSessionId: string | null, cwd: string | null, rawImages: RawImage[]): Promise<void> {
  console.log(`[followUpSession] id=${id}`);
  store.setStatus(id, "running");
  store.clearResult(id);
  store.appendChat(id, { type: "user", text: prompt, ts: new Date().toISOString() });
  const followupId = `${id}-followup-${Date.now()}`;
  if (rawImages.length > 0) {
    const urls = await Promise.all(rawImages.map((img, i) => saveImage(followupId, i, img.mediaType, img.data)));
    for (let i = 0; i < rawImages.length; i++) {
      store.appendChat(id, { type: "image", mediaType: rawImages[i].mediaType, url: urls[i], ts: new Date().toISOString() });
    }
  }
  const promptArg = rawImages.length > 0
    ? makePrompt(prompt, rawImages, followupId)
    : prompt;
  const session = store.getSession(id);
  const sandbox = session?.sandbox ?? "none";
  const inWorktree = !!session?.worktreePath;
  await runWithController(id, async (controller) => {
    const stream = query({
      prompt: promptArg as any,
      options: buildQueryOptions(id, sandbox, cwd, inWorktree, {
        claudeSessionId: claudeSessionId ?? undefined, model: session?.model, effort: session?.effort, abortController: controller,
      }),
    });
    await runQueryStream(id, stream, 0, { captureResult: true });
    if (controller.signal.aborted) return;
    store.setStatus(id, "completed");
  });
}
