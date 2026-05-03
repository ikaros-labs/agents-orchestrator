import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import type {
  CanUseTool,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import {
  createSdkMcpServer,
  query,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import logger from "./logger.ts";
import {
  jobStderr,
  makeDockerSpawner,
  makeStderrCapturingSpawner,
} from "./spawners.ts";
import * as store from "./store.ts";
import type {
  SandboxMode,
  Session,
  SessionEffort,
  SessionStatus,
} from "./types.ts";
import { resolveEffectiveCwd } from "./worktree.ts";

const log = logger.child({ component: "sessions" });

// ── Active session AbortControllers ──────────────────────────────────────────
// One AbortController per running session. Used by stopSession() to cancel the SDK query.

const activeControllers = new Map<string, AbortController>();

// ── Directory constants ──────────────────────────────────────────────────────

const AGENT_DIR =
  process.env.AGENT_ORCHESTRATOR_DIR ?? join(homedir(), ".agent-orchestrator");
export const LOGS_DIR = join(AGENT_DIR, "logs");
export const IMAGES_DIR = join(AGENT_DIR, "files");
await mkdir(LOGS_DIR, { recursive: true });
await mkdir(IMAGES_DIR, { recursive: true });

// ── Media type helpers ───────────────────────────────────────────────────────

export const IMAGE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
export const DOCUMENT_MEDIA_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/html",
  "text/csv",
  "text/xml",
  "application/xml",
]);
export const ALLOWED_MEDIA_TYPES = new Set([
  ...IMAGE_MEDIA_TYPES,
  ...DOCUMENT_MEDIA_TYPES,
]);

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

// ── AttachFiles MCP tool ─────────────────────────────────────────────────────

const EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};

function makeAttachFilesServer(sessionId: string) {
  return createSdkMcpServer({
    name: "orchestrator",
    tools: [
      tool(
        "attach_files",
        `Expose local files so the user can view or download them. Returns a public URL for each file.
Use the returned URLs in your markdown response — inline images with ![alt](url), download links with [filename](url).`,
        {
          paths: z.array(z.string()).describe("Absolute file paths to expose"),
        },
        async ({ paths }) => {
          const results: string[] = [];
          for (const filePath of paths) {
            const ext = extname(filePath).slice(1).toLowerCase();
            const filename = `${crypto.randomUUID()}.${ext || "bin"}`;
            const dir = `${IMAGES_DIR}/${sessionId}`;
            await mkdir(dir, { recursive: true });
            await writeFile(`${dir}/${filename}`, await readFile(filePath));
            results.push(
              `${basename(filePath)}: /images/${sessionId}/${filename}`,
            );
          }
          return {
            content: [{ type: "text" as const, text: results.join("\n") }],
          };
        },
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

export interface RawImage {
  mediaType: string;
  data: string;
}

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
  mode: "plan" | "edit",
  sandbox: SandboxMode,
  cwd: string | null,
  inWorktree: boolean,
  opts: {
    claudeSessionId?: string;
    model?: string | null;
    effort?: SessionEffort | null;
    abortController: AbortController;
  },
): Record<string, any> {
  const base = {
    tools: { type: "preset" as const, preset: "claude_code" as const },
    permissionMode: mode === "plan" ? "plan" : ("acceptEdits" as const),
    settingSources: ["user", "project", "local"] as const,
    mcpServers: { orchestrator: makeAttachFilesServer(id) },
    abortController: opts.abortController,
    canUseTool: makeCanUseTool(id, sandbox),
    spawnClaudeCodeProcess: makeStderrCapturingSpawner(id),
    ...(opts.claudeSessionId ? { resume: opts.claudeSessionId } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
    ...worktreeSystemPrompt(inWorktree),
    ...(cwd ? { cwd } : {}),
  };

  if (mode === "plan") {
    return base;
  }

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
      },
    };
  }

  if (sandbox === "docker") {
    return {
      ...autoApprove,
      spawnClaudeCodeProcess: makeDockerSpawner(id, cwd),
    };
  }

  if (sandbox === "yolo") {
    return {
      ...autoApprove,
      permissionMode: "bypassPermissions" as const,
      allowDangerouslySkipPermissions: true,
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

const pendingToolApprovals = new Map<
  string,
  Map<string, { resolve: (d: PermissionResult) => void }>
>();

/** Returns true if a pending resolver exists for this session + toolUseID. */
export function hasPendingApproval(id: string, toolUseID: string): boolean {
  return pendingToolApprovals.get(id)?.has(toolUseID) ?? false;
}

/**
 * Resolves (and removes) a pending tool approval. Returns false if no resolver
 * was found, true on success.
 */
export function resolveToolApproval(
  id: string,
  toolUseID: string,
  result: PermissionResult,
): boolean {
  log.info({ id, toolUseID, result }, "tool approval resolved");
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

function makeCanUseTool(id: string, sandbox: SandboxMode): CanUseTool {
  return async (
    toolName: string,
    input: Record<string, unknown>,
    options,
  ): Promise<PermissionResult> => {
    const { toolUseID, agentID } = options;

    // Deny ExitPlanMode so the planning query ends cleanly here.
    // Execution is triggered separately via executeSession() once the user approves the plan.
    if (toolName === "ExitPlanMode") {
      return {
        behavior: "deny",
        message: "Stop the execution. Awaiting plan approval from user.",
      };
    }

    // Auto-approve attach_files — it only copies files for display, no confirmation needed.
    if (toolName === "mcp__orchestrator__attach_files") {
      return { behavior: "allow", updatedInput: input };
    }

    // In yolo mode auto-approve all tools; AskUserQuestion still needs user input to answer.
    if (sandbox === "yolo" && toolName !== "AskUserQuestion") {
      return { behavior: "allow", updatedInput: input };
    }

    // In sandbox mode all tools run inside the sandbox, so auto-approve everything —
    // except tools that require explicit user interaction regardless of sandbox state.
    const needsManualApproval =
      toolName === "AskUserQuestion" ||
      (toolName === "Bash" && input.dangerouslyDisableSandbox === true);
    if (sandbox === "sandbox" && !needsManualApproval) {
      return { behavior: "allow", updatedInput: input };
    }

    store.addPendingTool(id, toolUseID, toolName, input, agentID);
    log.info({ id, tool: toolName, toolUseID }, "tool awaiting approval");

    const session = store.getSession(id);
    if (
      session &&
      session.status !== "awaiting_tool_approval" &&
      session.status !== "awaiting_user_question"
    ) {
      store.setStatus(
        id,
        toolName === "AskUserQuestion"
          ? "awaiting_user_question"
          : "awaiting_tool_approval",
      );
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
async function saveImage(
  sessionId: string,
  index: number,
  mediaType: string,
  base64Data: string,
): Promise<string> {
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
  opts: { captureResult?: boolean } = {},
): Promise<void> {
  // Maps tool_use_id → chat entry index so we can patch with output later
  const toolCallIndices = new Map<string, number>();
  for await (const message of stream) {
    const ts = new Date().toISOString();
    await appendFile(
      `${LOGS_DIR}/${id}.ndjson`,
      JSON.stringify({ ts, ...message }) + "\n",
    );
    if (message.type === "assistant" && message.message?.content) {
      const parentToolUseId: string | undefined =
        message.parent_tool_use_id || undefined;
      for (const block of message.message.content) {
        if ("text" in block) {
          store.appendChat(id, {
            type: "text",
            text: block.text,
            ts,
            parentToolUseId,
          });
        } else if ("name" in block) {
          const toolUseId: string | undefined = (block as any).id;
          store.appendChat(id, {
            type: "tool_call",
            name: block.name,
            input: (block as any).input,
            toolUseId,
            ts,
            parentToolUseId,
          });
          if (toolUseId) {
            const session = store.getSession(id);
            if (session)
              toolCallIndices.set(toolUseId, session.chat.length - 1);
          }
        } else if ((block as any).type === "image") {
          const b = block as any;
          if (b.source?.type === "base64") {
            const url = await saveImage(
              id,
              imageCounter++,
              b.source.media_type,
              b.source.data,
            );
            store.appendChat(id, {
              type: "image",
              mediaType: b.source.media_type,
              url,
              ts,
              parentToolUseId,
            });
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
            const output =
              typeof raw === "string"
                ? raw
                : Array.isArray(raw)
                  ? raw.map((c: any) => c.text ?? "").join("")
                  : "";
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
        const iterations: any[] = u.iterations ?? [];
        const lastIter = iterations[iterations.length - 1];
        const mainContextTokens = lastIter
          ? (lastIter.input_tokens ?? 0) +
            (lastIter.cache_read_input_tokens ?? 0) +
            (lastIter.cache_creation_input_tokens ?? 0)
          : 0;

        const rawModelUsage = message.modelUsage ?? {};
        const modelUsage: Record<string, any> = {};
        let mainContextWindow = 200_000;
        for (const [model, mu] of Object.entries(rawModelUsage) as [string, any][]) {
          modelUsage[model] = {
            inputTokens: mu.inputTokens ?? 0,
            outputTokens: mu.outputTokens ?? 0,
            cacheReadInputTokens: mu.cacheReadInputTokens ?? 0,
            cacheCreationInputTokens: mu.cacheCreationInputTokens ?? 0,
            costUSD: mu.costUSD ?? 0,
            contextWindow: mu.contextWindow ?? 200_000,
            maxOutputTokens: mu.maxOutputTokens ?? 16_384,
          };
          if (mu.contextWindow) mainContextWindow = mu.contextWindow;
        }

        store.addUsage(id, {
          totalInputTokens:
            (u.input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0),
          totalOutputTokens: u.output_tokens ?? 0,
          costUSD: message.total_cost_usd ?? 0,
          numTurns: message.num_turns ?? 0,
          mainContextTokens,
          mainContextWindow,
          modelUsage,
        });
      }
    }
  }
}

/** Build a multimodal prompt iterable when files are provided; otherwise fall back to a plain string. */
async function* makePrompt(
  prompt: string,
  rawImages: RawImage[],
  sessionId: string,
): AsyncIterable<any> {
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
    }),
  );
  yield {
    type: "user" as const,
    message: {
      role: "user" as const,
      content: [...contentBlocks, { type: "text" as const, text: prompt }],
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

// ── Session runner core ──────────────────────────────────────────────────────

interface RunSessionCoreOptions {
  mode: "plan" | "edit";
  prompt: unknown;
  imageCount: number;
  captureResult: boolean;
  finalStatus: SessionStatus;
}

async function runSessionCore(
  session: Session,
  opts: RunSessionCoreOptions,
): Promise<void> {
  const effectiveCwd = session.worktreePath ?? session.cwd;
  const inWorktree = !!session.worktreePath;
  await runWithController(session.id, async (controller) => {
    const stream = query({
      prompt: opts.prompt as any,
      options: buildQueryOptions(
        session.id,
        opts.mode,
        session.sandbox ?? "none",
        effectiveCwd,
        inWorktree,
        {
          claudeSessionId: session.claudeSessionId ?? undefined,
          model: session.model,
          effort: session.effort,
          abortController: controller,
        },
      ),
    });
    await runQueryStream(session.id, stream, opts.imageCount, {
      captureResult: opts.captureResult,
    });
    if (controller.signal.aborted) return;
    store.setStatus(session.id, opts.finalStatus);
  });
}

export async function executeSession(
  session: Session,
  userInput: { prompt: string; rawImages: RawImage[] },
): Promise<void> {
  log.info({ id: session.id }, "execute session");
  store.setStatus(
    session.id,
    session.mode === "auto" || session.mode === "plan" ? "planning" : "running",
  );
  await resolveEffectiveCwd(session.id, session.cwd, session.useWorktree);
  const promptArg =
    userInput.rawImages.length > 0
      ? makePrompt(userInput.prompt, userInput.rawImages, session.id)
      : userInput.prompt;

  if (session.mode === "auto" || session.mode === "plan") {
    await runSessionCore(session, {
      mode: "plan",
      prompt: promptArg,
      imageCount: userInput.rawImages.length,
      captureResult: false,
      finalStatus: "awaiting_approval",
    });
    return;
  }

  await runSessionCore(session, {
    mode: "edit",
    prompt: promptArg,
    imageCount: userInput.rawImages.length,
    captureResult: true,
    finalStatus: "completed",
  });
}

export async function executeApprovedSession(session: Session): Promise<void> {
  store.setMode(session.id, "edit");
  await followUpSession(session, {
    prompt: "The plan has been approved. Proceed with execution now.",
    rawImages: [],
  });
}

export async function followUpSession(
  session: Session,
  userInput: { prompt: string; rawImages: RawImage[] },
): Promise<void> {
  log.info({ id: session.id }, "follow up session");
  const isEdit = session.mode === "edit";
  store.setStatus(session.id, isEdit ? "running" : "planning");
  if (isEdit) store.clearResult(session.id);
  store.appendChat(session.id, {
    type: "user",
    text: userInput.prompt,
    ts: new Date().toISOString(),
  });
  const followupId = `${session.id}-followup-${Date.now()}`;
  if (userInput.rawImages.length > 0) {
    const urls = await Promise.all(
      userInput.rawImages.map((img, i) =>
        saveImage(followupId, i, img.mediaType, img.data),
      ),
    );
    for (let i = 0; i < userInput.rawImages.length; i++) {
      store.appendChat(session.id, {
        type: "image",
        mediaType: userInput.rawImages[i].mediaType,
        url: urls[i],
        ts: new Date().toISOString(),
      });
    }
  }
  const promptArg =
    userInput.rawImages.length > 0
      ? makePrompt(userInput.prompt, userInput.rawImages, followupId)
      : userInput.prompt;

  await runSessionCore(session, {
    mode: isEdit ? "edit" : "plan",
    prompt: promptArg,
    imageCount: 0,
    captureResult: isEdit,
    finalStatus: isEdit ? "completed" : "awaiting_approval",
  });
}
