import { query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import * as store from "./store.ts";

const DEFAULT_TOOLS = ["Read", "Edit", "Glob"];
const PORT = Number(process.env.PORT ?? 3000);

async function runJob(id: string, prompt: string, tools: string[]): Promise<void> {
  store.setStatus(id, "running");
  try {
    for await (const message of query({
      prompt,
      options: {
        allowedTools: tools,
        permissionMode: "acceptEdits",
      },
    })) {
      const ts = new Date().toISOString();
      if (message.type === "assistant" && message.message?.content) {
        for (const block of message.message.content) {
          if ("text" in block) {
            store.appendLog(id, { type: "text", text: block.text, ts });
          } else if ("name" in block) {
            store.appendLog(id, { type: "tool_call", name: block.name, ts });
          }
        }
      } else if (message.type === "result") {
        store.setResult(id, message.subtype);
      }
    }
    store.setStatus(id, "completed");
  } catch (err) {
    store.setError(id, err instanceof Error ? err.message : String(err));
    store.setStatus(id, "failed");
  }
}

function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonError(status: number, message: string): Response {
  return json(status, { error: message });
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "POST" && path === "/jobs") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return jsonError(400, "Invalid JSON body");
      }

      if (typeof body !== "object" || body === null) {
        return jsonError(400, "Body must be a JSON object");
      }
      const b = body as Record<string, unknown>;
      if (typeof b["prompt"] !== "string" || b["prompt"].trim() === "") {
        return jsonError(400, "prompt must be a non-empty string");
      }
      const prompt = b["prompt"].trim();
      let tools = DEFAULT_TOOLS;
      if ("tools" in b) {
        if (!Array.isArray(b["tools"]) || !b["tools"].every((t) => typeof t === "string")) {
          return jsonError(400, "tools must be an array of strings");
        }
        tools = b["tools"] as string[];
      }

      const id = randomUUID();
      store.createJob(id, prompt, tools);
      Promise.resolve().then(() => runJob(id, prompt, tools));

      return json(202, { id, status: "pending" });
    }

    const jobMatch = path.match(/^\/jobs\/([^/]+)$/);
    if (req.method === "GET" && jobMatch) {
      const id = jobMatch[1]!;
      const job = store.getJob(id);
      if (!job) return jsonError(404, "Job not found");
      return json(200, job);
    }

    return jsonError(404, "Not found");
  },
});

console.log(`Listening on http://localhost:${PORT}`);
