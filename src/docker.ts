import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, dirname } from "node:path";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

const execFileAsync = promisify(execFile);

const IMAGE_NAME = "orchestrator-sandbox";
const DOCKERFILE = resolve(import.meta.dir, "../Dockerfile.sandbox");

// Path to the SDK cli.js on the host — bind-mounted into the container.
const SDK_CLI_HOST = resolve(import.meta.dir, "../node_modules/@anthropic-ai/claude-agent-sdk/cli.js");
const SDK_CLI_CONTAINER = "/opt/claude-sdk/cli.js";

// Path to the SDK module directory (cli.js may require sibling files).
const SDK_DIR_HOST = dirname(SDK_CLI_HOST);
const SDK_DIR_CONTAINER = "/opt/claude-sdk";

let imageReady = false;

// ── Public API ──────────────────────────────────────────────────────────────

export async function isDockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["info"], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export async function ensureImage(): Promise<void> {
  if (imageReady) return;
  if (!(await isDockerAvailable())) {
    throw new Error("Docker is not available. Install Docker to use sandboxed execution.");
  }
  try {
    // Check if image already exists
    await execFileAsync("docker", ["image", "inspect", IMAGE_NAME], { timeout: 10_000 });
    imageReady = true;
  } catch {
    // Build it
    console.log(`[docker] Building sandbox image "${IMAGE_NAME}" …`);
    await execFileAsync("docker", ["build", "-t", IMAGE_NAME, "-f", DOCKERFILE, "."], {
      timeout: 300_000, // 5 min
      cwd: resolve(import.meta.dir, ".."),
    });
    imageReady = true;
    console.log(`[docker] Sandbox image ready.`);
  }
}

/**
 * Spawn the Claude Code CLI subprocess inside a Docker container.
 * Implements the SpawnedProcess interface that the SDK expects.
 */
export function spawnInDocker(
  opts: SpawnOptions,
  jobId: string,
  worktreePath: string | null,
): SpawnedProcess {
  const containerName = `orchestrator-${jobId.slice(0, 32)}`;

  // Build env flags — forward ANTHROPIC_API_KEY, GITHUB_TOKEN, and everything the SDK sends
  const envFlags: string[] = [];
  for (const [key, val] of Object.entries(opts.env)) {
    if (val !== undefined) {
      envFlags.push("-e", `${key}=${val}`);
    }
  }
  // Ensure critical host env vars are forwarded even if not in opts.env
  for (const key of ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "GH_TOKEN"]) {
    if (process.env[key] && !opts.env[key]) {
      envFlags.push("-e", `${key}=${process.env[key]}`);
    }
  }

  // Volume mounts
  const volumes: string[] = [
    // SDK module directory (read-only)
    "-v", `${SDK_DIR_HOST}:${SDK_DIR_CONTAINER}:ro`,
  ];
  if (worktreePath) {
    volumes.push("-v", `${worktreePath}:/workspace`);
  }

  // Mount git config for commits/PRs
  const gitconfigPath = `${process.env.HOME ?? "/root"}/.gitconfig`;
  volumes.push("-v", `${gitconfigPath}:/root/.gitconfig:ro`);
  // Mount gh auth
  const ghConfigDir = `${process.env.HOME ?? "/root"}/.config/gh`;
  volumes.push("-v", `${ghConfigDir}:/root/.config/gh:ro`);

  // Remap the host command to the container path
  const command = SDK_CLI_CONTAINER;
  const args = opts.args;

  const dockerArgs = [
    "run",
    "--rm",
    "-i",             // interactive stdin/stdout piping
    "--name", containerName,
    "--network", "host",
    "--memory", "4g",
    "--cpus", "2",
    "--pids-limit", "256",
    ...volumes,
    ...envFlags,
    "-w", "/workspace",
    IMAGE_NAME,
    "node", command,
    ...args,
  ];

  const child = spawn("docker", dockerArgs, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Forward stderr for debugging
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[sandbox:${jobId.slice(0, 8)}] ${chunk}`);
  });

  // Wire abort signal to docker kill
  if (opts.signal) {
    const onAbort = () => {
      spawn("docker", ["kill", containerName], { stdio: "ignore" });
    };
    if (opts.signal.aborted) {
      onAbort();
    } else {
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  // Adapt Bun/Node ChildProcess to SpawnedProcess interface
  const process_: SpawnedProcess = {
    stdin: child.stdin!,
    stdout: child.stdout!,
    get killed() { return child.killed; },
    get exitCode() { return child.exitCode; },
    kill(signal: NodeJS.Signals) { return child.kill(signal); },
    on(event: string, listener: (...args: any[]) => void) {
      child.on(event, listener);
    },
    once(event: string, listener: (...args: any[]) => void) {
      child.once(event, listener);
    },
    off(event: string, listener: (...args: any[]) => void) {
      child.off(event, listener);
    },
  };

  return process_;
}

/**
 * Force-remove a container if it still exists (cleanup after job ends).
 */
export async function cleanupContainer(jobId: string): Promise<void> {
  const containerName = `orchestrator-${jobId.slice(0, 32)}`;
  try {
    await execFileAsync("docker", ["rm", "-f", containerName], { timeout: 10_000 });
  } catch {
    // Container already gone — fine
  }
}
