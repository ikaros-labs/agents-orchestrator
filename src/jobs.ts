import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, PermissionResult, SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

// ── Active job AbortControllers ──────────────────────────────────────────────
// One AbortController per running job. Used by stopJob() to cancel the SDK query.

const activeControllers = new Map<string, AbortController>();
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, extname, join } from "node:path";
import { homedir } from "node:os";
import * as store from "./store.ts";
import type { Job, JobEffort, SandboxMode } from "./types.ts";

const execFileAsync = promisify(execFile);

// ── Directory constants ──────────────────────────────────────────────────────

const AGENT_DIR = join(homedir(), ".agent-orchestrator");
export const WORKTREES_DIR = process.env.AGENT_WORKTREES_DIR ?? join(AGENT_DIR, "worktrees");
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

import { z } from "zod";

function makeAttachFilesServer(jobId: string) {
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
            const dir = `${IMAGES_DIR}/${jobId}`;
            await mkdir(dir, { recursive: true });
            await writeFile(`${dir}/${filename}`, await readFile(filePath));
            results.push(`${basename(filePath)}: /images/${jobId}/${filename}`);
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

// ── Stderr-capturing spawner ─────────────────────────────────────────────────
// Wraps the default spawn to capture stderr from the Claude Code CLI process.
// Without this, startup failures (e.g. missing deps) produce no diagnostics.

import { spawn as nodeSpawn } from "node:child_process";

/** Stores recent stderr lines per job so we can surface them in error messages. */
const jobStderr = new Map<string, string[]>();

function makeStderrCapturingSpawner(
  jobId: string,
): (opts: SpawnOptions) => SpawnedProcess {
  return (opts: SpawnOptions): SpawnedProcess => {
    const proc = nodeSpawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      signal: opts.signal,
    });
    if (!jobStderr.has(jobId)) jobStderr.set(jobId, []);
    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        console.error(`[stderr] job=${jobId}: ${text}`);
        const lines = jobStderr.get(jobId)!;
        lines.push(text);
        // Keep only last 20 lines
        if (lines.length > 20) lines.splice(0, lines.length - 20);
      }
    });
    return proc as unknown as SpawnedProcess;
  };
}

// ── Docker spawner ──────────────────────────────────────────────────────────

const DOCKER_IMAGE = process.env.AGENT_DOCKER_IMAGE ?? "agents-orchestrator-worker:latest";

function makeDockerSpawner(
  jobId: string,
  cwd: string | null,
): (opts: SpawnOptions) => SpawnedProcess {
  return (opts: SpawnOptions): SpawnedProcess => {
    const dockerArgs = [
      "run", "--rm", "-i",
      "--name", `agent-${jobId}`,
      // Security hardening
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      // Resource limits
      "--memory", "4g",
      "--cpus", "2",
      "--pids-limit", "200",
      // Mount worktree
      ...(cwd ? ["-v", `${cwd}:${cwd}`] : []),
      // Mount session storage for resume support
      "-v", `${homedir()}/.claude:/root/.claude`,
      // Pass environment
      ...Object.entries(opts.env)
        .filter(([, v]) => v !== undefined)
        .flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      // Working directory
      ...(opts.cwd ? ["-w", opts.cwd] : []),
      // Image and command
      DOCKER_IMAGE,
      opts.command, ...opts.args,
    ];

    const proc = nodeSpawn("docker", dockerArgs, { stdio: ["pipe", "pipe", "pipe"] });

    if (!jobStderr.has(jobId)) jobStderr.set(jobId, []);
    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        console.error(`[stderr:docker] job=${jobId}: ${text}`);
        const lines = jobStderr.get(jobId)!;
        lines.push(text);
        if (lines.length > 20) lines.splice(0, lines.length - 20);
      }
    });

    // Wire abort signal to container stop
    opts.signal.addEventListener("abort", () => {
      nodeSpawn("docker", ["stop", `agent-${jobId}`], { stdio: "ignore" });
    });

    return proc as unknown as SpawnedProcess;
  };
}

// ── Sandbox-aware query options builder ──────────────────────────────────────
//
// Non-approval modes use acceptEdits + allowedTools to auto-approve all tools.
// We avoid bypassPermissions because it requires --dangerously-skip-permissions
// which the CLI refuses when running as root.

/** All built-in tools the SDK/CLI exposes. Listing them in allowedTools auto-approves each one. */
const ALL_SDK_TOOLS = [
  "Bash", "Read", "Edit", "Write", "Glob", "Grep",
  "WebSearch", "WebFetch", "Agent", "NotebookEdit",
  "AskUserQuestion", "ExitPlanMode",
];

function buildQueryOptions(
  id: string,
  sandbox: SandboxMode,
  tools: string[],
  cwd: string | null,
  inWorktree: boolean,
  opts: { sessionId?: string; model?: string | null; effort?: JobEffort | null; abortController: AbortController },
): Record<string, any> {
  const allTools = [...new Set([...tools, ...ALL_SDK_TOOLS, "mcp__orchestrator__attach_files"])];
  const base = {
    allowedTools: allTools,
    settingSources: ["user", "project", "local"] as const,
    mcpServers: { orchestrator: makeAttachFilesServer(id) },
    abortController: opts.abortController,
    spawnClaudeCodeProcess: makeStderrCapturingSpawner(id),
    ...(opts.sessionId ? { resume: opts.sessionId } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
    ...worktreeSystemPrompt(inWorktree),
    ...(cwd ? { cwd } : {}),
  };

  if (sandbox === "approval") {
    return { ...base, permissionMode: "acceptEdits" as const, canUseTool: makeCanUseTool(id) };
  }

  // All non-approval modes auto-approve everything via acceptEdits + allowedTools
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
        network: { allowedDomains: ["api.anthropic.com", "github.com", "*.githubusercontent.com"] },
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

/**
 * Stops a running job: aborts its SDK query, rejects any pending tool approvals,
 * and marks the job as failed. Safe to call from any active status.
 */
export function stopJob(id: string): boolean {
  const jobApprovals = pendingToolApprovals.get(id);
  const controller = activeControllers.get(id);
  if (!controller && !jobApprovals?.size) return false;

  if (jobApprovals) {
    jobApprovals.clear();
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
    // Execution is triggered separately via executeJob() once the user approves the plan.
    if (toolName === "ExitPlanMode") {
      return { behavior: "deny", message: "Stop the execution. Awaiting plan approval from user." };
    }

    // Auto-approve attach_files — it only copies files for display, no confirmation needed.
    if (toolName === "mcp__orchestrator__attach_files") {
      return { behavior: "allow", updatedInput: input };
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


function handleJobError(id: string, err: unknown): void {
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
  // Maps tool_use_id → log entry index so we can patch with output later
  const toolCallIndices = new Map<string, number>();
  for await (const message of stream) {
    const ts = new Date().toISOString();
    await appendFile(`${LOGS_DIR}/${id}.ndjson`, JSON.stringify({ ts, ...message }) + "\n");
    if (message.type === "assistant" && message.message?.content) {
      for (const block of message.message.content) {
        if ("text" in block) {
          store.appendLog(id, { type: "text", text: block.text, ts });
          if (opts.collectPlanText) planTexts.push(block.text);
        } else if ("name" in block) {
          const toolUseId: string | undefined = (block as any).id;
          store.appendLog(id, { type: "tool_call", name: block.name, input: (block as any).input, toolUseId, ts });
          if (toolUseId) {
            const job = store.getJob(id);
            if (job) toolCallIndices.set(toolUseId, job.log.length - 1);
          }
        } else if ((block as any).type === "image") {
          const b = block as any;
          if (b.source?.type === "base64") {
            const url = await saveImage(id, imageCounter++, b.source.media_type, b.source.data);
            store.appendLog(id, { type: "image", mediaType: b.source.media_type, url, ts });
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
            store.patchLog(id, index, { output });
          }
        }
      }
    } else if (message.type === "system" && message.subtype === "init") {
      const sessionId = message.session_id ?? message.sessionId;
      if (sessionId) store.setSessionId(id, sessionId);
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
 * Removes the git worktree for a job.
 * Errors are logged but not thrown — archiving must always succeed.
 */
export async function removeWorktree(job: Job): Promise<void> {
  if (!job.worktreePath) return;
  const { id, worktreePath } = job;
  try {
    await execFileAsync("git", ["worktree", "remove", "--force", worktreePath]);
    console.log(`[worktree] removed for job ${id}: ${worktreePath}`);
  } catch (err) {
    console.warn(`[worktree] failed to remove worktree for job ${id}: ${err}`);
  }
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
  const controller = new AbortController();
  activeControllers.set(id, controller);
  const planJobOpts = store.getJob(id);
  try {
    // Planning phase always uses "plan" mode regardless of sandbox setting
    const stream = query({
      prompt: promptArg as any,
      options: {
        allowedTools: [...tools, "mcp__orchestrator__attach_files"],
        permissionMode: "plan",
        canUseTool: makeCanUseTool(id),
        settingSources: ["user", "project", "local"],
        mcpServers: { orchestrator: makeAttachFilesServer(id) },
        abortController: controller,
        ...(planJobOpts?.model ? { model: planJobOpts.model } : {}),
        ...(planJobOpts?.effort ? { effort: planJobOpts.effort } : {}),
        ...worktreeSystemPrompt(useWorktree),
        ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
      },
    });
    const planTexts = await runQueryStream(id, stream, rawImages.length, { collectPlanText: true });
    if (controller.signal.aborted) return;
    const exitEntry = store.getJob(id)?.log.slice().reverse().find(e => e.type === 'tool_call' && (e as any).name === 'ExitPlanMode');
    store.setPlan(id, (exitEntry as any)?.input?.plan || planTexts.join("\n"));
    store.setStatus(id, "awaiting_approval");
  } catch (err) {
    if (controller.signal.aborted) return;
    handleJobError(id, err);
  } finally {
    activeControllers.delete(id);
    jobStderr.delete(id);
  }
}

export async function revisePlanJob(id: string, feedback: string, sessionId: string, tools: string[], cwd: string | null): Promise<void> {
  console.log(`[revisePlanJob] id=${id}`);
  store.setStatus(id, "planning");
  store.appendLog(id, { type: "user", text: feedback, ts: new Date().toISOString() });
  const revisePlanJobRef = store.getJob(id);
  const inWorktree = !!revisePlanJobRef?.worktreePath;
  const controller = new AbortController();
  activeControllers.set(id, controller);
  try {
    // Planning phase always uses "plan" mode regardless of sandbox setting
    const stream = query({
      prompt: feedback,
      options: {
        allowedTools: [...tools, "mcp__orchestrator__attach_files"],
        permissionMode: "plan",
        canUseTool: makeCanUseTool(id),
        settingSources: ["user", "project", "local"],
        mcpServers: { orchestrator: makeAttachFilesServer(id) },
        resume: sessionId,
        abortController: controller,
        ...(revisePlanJobRef?.model ? { model: revisePlanJobRef.model } : {}),
        ...(revisePlanJobRef?.effort ? { effort: revisePlanJobRef.effort } : {}),
        ...worktreeSystemPrompt(inWorktree),
        ...(cwd ? { cwd } : {}),
      },
    });
    const planTexts = await runQueryStream(id, stream, 0, { collectPlanText: true });
    if (controller.signal.aborted) return;
    const exitEntry = store.getJob(id)?.log.slice().reverse().find(e => e.type === 'tool_call' && (e as any).name === 'ExitPlanMode');
    store.setPlan(id, (exitEntry as any)?.input?.plan || planTexts.join("\n"));
    store.setStatus(id, "awaiting_approval");
  } catch (err) {
    if (controller.signal.aborted) return;
    handleJobError(id, err);
  } finally {
    activeControllers.delete(id);
    jobStderr.delete(id);
  }
}

export async function directExecuteJob(id: string, prompt: string, tools: string[], cwd: string | null, rawImages: RawImage[], useWorktree: boolean = false): Promise<void> {
  console.log(`[directExecuteJob] id=${id}`);
  store.setStatus(id, "running");
  const effectiveCwd = await resolveEffectiveCwd(id, cwd, useWorktree);
  const directExecJob = store.getJob(id);
  const sandbox = directExecJob?.sandbox ?? "none";
  const inWorktree = !!directExecJob?.worktreePath;
  const promptArg = rawImages.length > 0 ? makePrompt(prompt, rawImages, id) : prompt;
  const controller = new AbortController();
  activeControllers.set(id, controller);
  try {
    const stream = query({
      prompt: promptArg as any,
      options: buildQueryOptions(id, sandbox, tools, effectiveCwd, inWorktree, {
        model: directExecJob?.model, effort: directExecJob?.effort, abortController: controller,
      }),
    });
    await runQueryStream(id, stream, rawImages.length, { captureResult: true });
    if (controller.signal.aborted) return;
    store.setStatus(id, "completed");
  } catch (err) {
    if (controller.signal.aborted) return;
    handleJobError(id, err);
  } finally {
    activeControllers.delete(id);
    jobStderr.delete(id);
  }
}

export async function executeJob(id: string, sessionId: string, tools: string[], cwd: string | null): Promise<void> {
  console.log(`[executeJob] id=${id}`);
  store.setStatus(id, "running");
  const execJobRef = store.getJob(id);
  const sandbox = execJobRef?.sandbox ?? "none";
  const inWorktree = !!execJobRef?.worktreePath;
  const controller = new AbortController();
  activeControllers.set(id, controller);
  try {
    const stream = query({
      prompt: "The plan has been approved. Proceed with execution now.",
      options: buildQueryOptions(id, sandbox, tools, cwd, inWorktree, {
        sessionId, model: execJobRef?.model, effort: execJobRef?.effort, abortController: controller,
      }),
    });
    await runQueryStream(id, stream, 0, { captureResult: true });
    if (controller.signal.aborted) return;
    store.setStatus(id, "completed");
  } catch (err) {
    if (controller.signal.aborted) return;
    handleJobError(id, err);
  } finally {
    activeControllers.delete(id);
    jobStderr.delete(id);
  }
}

export async function followUpJob(id: string, prompt: string, sessionId: string | null, tools: string[], cwd: string | null, rawImages: RawImage[]): Promise<void> {
  console.log(`[followUpJob] id=${id}`);
  store.setStatus(id, "running");
  store.clearResult(id);
  store.appendLog(id, { type: "user", text: prompt, ts: new Date().toISOString() });
  const followupJobId = `${id}-followup-${Date.now()}`;
  if (rawImages.length > 0) {
    const urls = await Promise.all(rawImages.map((img, i) => saveImage(followupJobId, i, img.mediaType, img.data)));
    for (let i = 0; i < rawImages.length; i++) {
      store.appendLog(id, { type: "image", mediaType: rawImages[i].mediaType, url: urls[i], ts: new Date().toISOString() });
    }
  }
  const promptArg = rawImages.length > 0
    ? makePrompt(prompt, rawImages, followupJobId)
    : prompt;
  const followUpJobRef = store.getJob(id);
  const sandbox = followUpJobRef?.sandbox ?? "none";
  const inWorktree = !!followUpJobRef?.worktreePath;
  const controller = new AbortController();
  activeControllers.set(id, controller);
  try {
    const stream = query({
      prompt: promptArg as any,
      options: buildQueryOptions(id, sandbox, tools, cwd, inWorktree, {
        sessionId: sessionId ?? undefined, model: followUpJobRef?.model, effort: followUpJobRef?.effort, abortController: controller,
      }),
    });
    await runQueryStream(id, stream, 0, { captureResult: true });
    if (controller.signal.aborted) return;
    store.setStatus(id, "completed");
  } catch (err) {
    if (controller.signal.aborted) return;
    handleJobError(id, err);
  } finally {
    activeControllers.delete(id);
    jobStderr.delete(id);
  }
}
