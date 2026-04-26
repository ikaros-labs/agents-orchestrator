import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import * as store from "./store.ts";
import type { Session } from "./types.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("worktree");

const execFileAsync = promisify(execFile);

const AGENT_DIR = join(homedir(), ".agent-orchestrator");
export const WORKTREES_DIR = process.env.AGENT_WORKTREES_DIR ?? join(AGENT_DIR, "worktrees");

/**
 * Creates a git worktree for a job at `WORKTREES_DIR/<jobId>` and returns the
 * absolute path to the new worktree. The base directory defaults to
 * `~/.agent-orchestrator/worktrees` and can be overridden via the
 * `AGENT_WORKTREES_DIR` environment variable. Throws if `cwd` is not inside a
 * git repository or if `git worktree add` fails.
 */
async function createWorktree(cwd: string, jobId: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
  const gitRoot = stdout.trim();
  await mkdir(WORKTREES_DIR, { recursive: true });
  const worktreePath = join(WORKTREES_DIR, jobId);
  const branchName = `agent/${jobId}`;
  await execFileAsync("git", ["-C", gitRoot, "worktree", "add", "-b", branchName, worktreePath]);
  return worktreePath;
}

/**
 * Removes the git worktree for a job.
 * Errors are logged but not thrown — archiving must always succeed.
 */
export async function removeWorktree(job: Session): Promise<void> {
  if (!job.worktreePath) return;
  const { id, worktreePath } = job;
  try {
    await execFileAsync("git", ["worktree", "remove", "--force", worktreePath]);
    log.info({ id, worktreePath }, "worktree removed");
  } catch (err) {
    log.warn({ id, err }, "failed to remove worktree");
  }
}

/**
 * Resolves the effective cwd for an agent run.
 * - If `useWorktree` is false or `cwd` is null, returns `cwd` unchanged.
 * - Otherwise attempts to create a git worktree; on success stores the path on
 *   the job and returns it. On failure logs a warning and falls back to `cwd`.
 */
export async function resolveEffectiveCwd(id: string, cwd: string | null, useWorktree: boolean): Promise<string | null> {
  if (!useWorktree || !cwd) return cwd;
  try {
    const worktreePath = await createWorktree(cwd, id);
    store.setWorktreePath(id, worktreePath);
    log.info({ id, worktreePath }, "worktree created");
    return worktreePath;
  } catch (err) {
    log.warn({ id, err }, "failed to create worktree, falling back to cwd");
    return cwd;
  }
}
