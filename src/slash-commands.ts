import type { SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import logger from "./logger.ts";

const log = logger.child({ component: "slash-commands" });

let commands: SlashCommand[] = [];
let discovering = false;

export function getSlashCommands(): SlashCommand[] {
  return commands;
}

async function discoverCommands(): Promise<void> {
  if (discovering) return;
  discovering = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const q = query({
      prompt: "x",
      options: {
        tools: { type: "preset", preset: "claude_code" },
        abortController: controller,
      },
    });
    const result = await q.supportedCommands();
    q.close();
    commands = result;
    log.info({ count: result.length }, "slash commands discovered");
  } catch (err) {
    if (!controller.signal.aborted) {
      log.warn({ err }, "failed to discover slash commands");
    }
  } finally {
    clearTimeout(timeout);
    discovering = false;
  }
}

export function startCommandDiscovery(): void {
  discoverCommands().catch(() => {});
  setInterval(() => discoverCommands().catch(() => {}), 5 * 60 * 1000);
}
