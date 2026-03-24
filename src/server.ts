import { query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import * as store from "./store.ts";

const LOGS_DIR = "./logs";
await mkdir(LOGS_DIR, { recursive: true });
store.loadStore();

const UI_HTML = await Bun.file(new URL("./public/index.html", import.meta.url)).text();

const DEFAULT_TOOLS = ["Read", "Edit", "Glob", "Write", "Grep", "WebSearch", "WebFetch", "AskUserQuestion"];
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "localhost";

async function planJob(id: string, prompt: string, tools: string[], cwd: string | null): Promise<void> {
  store.setStatus(id, "planning");
  const planTexts: string[] = [];
  try {
    for await (const message of query({
      prompt,
      options: {
        allowedTools: tools,
        permissionMode: "plan",
        ...(cwd ? { cwd } : {}),
      },
    })) {
      const ts = new Date().toISOString();
      await appendFile(`${LOGS_DIR}/${id}.ndjson`, JSON.stringify({ ts, ...message }) + "\n");
      if (message.type === "assistant" && message.message?.content) {
        for (const block of message.message.content) {
          if ("text" in block) {
            store.appendLog(id, { type: "text", text: block.text, ts });
            planTexts.push(block.text);
          } else if ("name" in block) {
            store.appendLog(id, { type: "tool_call", name: block.name, input: (block as any).input, ts });
          }
        }
      } else if (message.type === "result") {
        const sessionId = (message as any).session_id ?? (message as any).sessionId;
        if (sessionId) store.setSessionId(id, sessionId);
      }
    }
    store.setPlan(id, planTexts.join("\n"));
    store.setStatus(id, "awaiting_approval");
  } catch (err) {
    store.setError(id, err instanceof Error ? err.message : String(err));
    store.setStatus(id, "failed");
  }
}

async function executeJob(id: string, sessionId: string, tools: string[], cwd: string | null): Promise<void> {
  store.setStatus(id, "running");
  try {
    for await (const message of query({
      prompt: "The plan has been approved. Please proceed with execution.",
      options: {
        allowedTools: tools,
        permissionMode: "acceptEdits",
        resume: sessionId,
        ...(cwd ? { cwd } : {}),
      },
    })) {
      const ts = new Date().toISOString();
      await appendFile(`${LOGS_DIR}/${id}.ndjson`, JSON.stringify({ ts, ...message }) + "\n");
      if (message.type === "assistant" && message.message?.content) {
        for (const block of message.message.content) {
          if ("text" in block) {
            store.appendLog(id, { type: "text", text: block.text, ts });
          } else if ("name" in block) {
            store.appendLog(id, { type: "tool_call", name: block.name, input: (block as any).input, ts });
          }
        }
      } else if (message.type === "result") {
        const sessionId = (message as any).session_id ?? (message as any).sessionId;
        if (sessionId) store.setSessionId(id, sessionId);
        store.setResult(id, message.subtype);
      }
    }
    store.setStatus(id, "completed");
  } catch (err) {
    store.setError(id, err instanceof Error ? err.message : String(err));
    store.setStatus(id, "failed");
  }
}

async function followUpJob(id: string, prompt: string, sessionId: string, tools: string[], cwd: string | null): Promise<void> {
  store.setStatus(id, "running");
  store.clearResult(id);
  try {
    for await (const message of query({
      prompt,
      options: {
        allowedTools: tools,
        permissionMode: "acceptEdits",
        resume: sessionId,
        ...(cwd ? { cwd } : {}),
      },
    })) {
      const ts = new Date().toISOString();
      await appendFile(`${LOGS_DIR}/${id}.ndjson`, JSON.stringify({ ts, ...message }) + "\n");
      if (message.type === "assistant" && message.message?.content) {
        for (const block of message.message.content) {
          if ("text" in block) {
            store.appendLog(id, { type: "text", text: block.text, ts });
          } else if ("name" in block) {
            store.appendLog(id, { type: "tool_call", name: block.name, input: (block as any).input, ts });
          }
        }
      } else if (message.type === "result") {
        const newSessionId = (message as any).session_id ?? (message as any).sessionId;
        if (newSessionId) store.setSessionId(id, newSessionId);
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
  hostname: HOST,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "GET" && path === "/") {
      return new Response(UI_HTML, { headers: { "Content-Type": "text/html" } });
    }

    if (req.method === "GET" && path === "/style.css") {
      return new Response(Bun.file(new URL("./public/style.css", import.meta.url)), {
        headers: { "Content-Type": "text/css" },
      });
    }

    if (req.method === "GET" && path === "/app.js") {
      return new Response(Bun.file(new URL("./public/app.js", import.meta.url)), {
        headers: { "Content-Type": "text/javascript" },
      });
    }

    if (req.method === "GET" && path === "/jobs") {
      return json(200, store.listJobs());
    }

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

      let cwd: string | null = null;
      if ("cwd" in b) {
        if (typeof b["cwd"] !== "string") {
          return jsonError(400, "cwd must be a string");
        }
        cwd = b["cwd"];
      }

      const id = `${new Date().toISOString().replace(/[-:.]/g, "")}-${randomUUID()}`;
      store.createJob(id, prompt, tools, cwd);
      Promise.resolve().then(() => planJob(id, prompt, tools, cwd));

      return json(202, { id, status: "pending" });
    }

    const jobMatch = path.match(/^\/jobs\/([^/]+)$/);
    if (req.method === "GET" && jobMatch) {
      const id = jobMatch[1]!;
      const job = store.getJob(id);
      if (!job) return jsonError(404, "Job not found");
      return json(200, job);
    }

    const approveMatch = path.match(/^\/jobs\/([^/]+)\/approve$/);
    if (req.method === "POST" && approveMatch) {
      const id = approveMatch[1]!;
      const job = store.getJob(id);
      if (!job) return jsonError(404, "Job not found");
      if (job.status !== "awaiting_approval") return jsonError(409, "Job is not awaiting approval");
      if (!job.sessionId) return jsonError(500, "No session ID from planning phase");
      Promise.resolve().then(() => executeJob(id, job.sessionId!, job.tools, job.cwd));
      return json(202, { id, status: "running" });
    }

    const rejectMatch = path.match(/^\/jobs\/([^/]+)\/reject$/);
    if (req.method === "POST" && rejectMatch) {
      const id = rejectMatch[1]!;
      const job = store.getJob(id);
      if (!job) return jsonError(404, "Job not found");
      if (job.status !== "awaiting_approval") return jsonError(409, "Job is not awaiting approval");
      store.setError(id, "Rejected by user");
      store.setStatus(id, "failed");
      return json(200, { id, status: "failed" });
    }

    const followupMatch = path.match(/^\/jobs\/([^/]+)\/followup$/);
    if (req.method === "POST" && followupMatch) {
      const id = followupMatch[1]!;
      const job = store.getJob(id);
      if (!job) return jsonError(404, "Job not found");
      if (job.status !== "completed" && job.status !== "failed") return jsonError(409, "Job is not completed");
      if (!job.sessionId) return jsonError(500, "No session ID available for follow-up");
      let body: unknown;
      try { body = await req.json(); } catch { return jsonError(400, "Invalid JSON body"); }
      const b = body as Record<string, unknown>;
      if (typeof b["prompt"] !== "string" || b["prompt"].trim() === "") {
        return jsonError(400, "prompt must be a non-empty string");
      }
      Promise.resolve().then(() => followUpJob(id, (b["prompt"] as string).trim(), job.sessionId!, job.tools, job.cwd));
      return json(202, { id, status: "running" });
    }

    return jsonError(404, "Not found");
  },
});

console.log(`Listening on http://${HOST}:${PORT}`);
