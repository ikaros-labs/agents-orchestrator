import { spawn as nodeSpawn } from "node:child_process";
import type {
  SpawnedProcess,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import logger from "./logger.ts";

const log = logger.child({ component: "spawners" });

// ── Stderr capture ────────────────────────────────────────────────────────────
// Wraps the default spawn to capture stderr from the Claude Code CLI process.
// Without this, startup failures (e.g. missing deps) produce no diagnostics.

/** Stores recent stderr lines per job so we can surface them in error messages. */
export const jobStderr = new Map<string, string[]>();

function attachStderrCapture(
  jobId: string,
  proc: ReturnType<typeof nodeSpawn>,
  label = "stderr",
): void {
  if (!jobStderr.has(jobId)) jobStderr.set(jobId, []);
  proc.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) {
      log.error({ label, jobId }, text);
      const lines = jobStderr.get(jobId)!;
      lines.push(text);
      // Keep only last 20 lines
      if (lines.length > 20) lines.splice(0, lines.length - 20);
    }
  });
}

export function makeStderrCapturingSpawner(
  jobId: string,
): (opts: SpawnOptions) => SpawnedProcess {
  return (opts: SpawnOptions): SpawnedProcess => {
    const proc = nodeSpawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      signal: opts.signal,
    });
    attachStderrCapture(jobId, proc);
    return proc as unknown as SpawnedProcess;
  };
}
