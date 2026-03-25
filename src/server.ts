import { query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import * as store from "./store.ts";
import type { InputFile, JobMode } from "./types.ts";

const LOGS_DIR = "./logs";
const IMAGES_DIR = "./data/images";
await mkdir(LOGS_DIR, { recursive: true });
await mkdir(IMAGES_DIR, { recursive: true });
store.loadStore();

const UI_HTML = await Bun.file(new URL("./public/index.html", import.meta.url)).text();

// ── canUseTool resolver map ──────────────────────────────────────────────────
// When Claude wants to use a tool during execution, canUseTool stores a
// Promise resolver here keyed by job ID. The approve/reject endpoints then
// resolve it with the user's decision, unblocking the agent.
type ToolDecision =
  | { behavior: "allow"; updatedInput: unknown }
  | { behavior: "deny"; message: string };

const pendingToolApprovals = new Map<string, { resolve: (d: ToolDecision) => void }>();

function makeCanUseTool(id: string) {
  return async (toolName: string, input: unknown): Promise<ToolDecision> => {
    store.setPendingTool(id, toolName, input as Record<string, unknown>);
    store.setStatus(id, "awaiting_tool_approval");
    return new Promise<ToolDecision>((resolve) => {
      pendingToolApprovals.set(id, { resolve });
    });
  };
}

const DEFAULT_TOOLS = ["Read", "Edit", "Glob", "Write", "Grep", "WebSearch", "WebFetch", "AskUserQuestion"];
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "localhost";

const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const DOCUMENT_MEDIA_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/html",
  "text/csv",
  "text/xml",
  "application/xml",
]);
const ALLOWED_MEDIA_TYPES = new Set([...IMAGE_MEDIA_TYPES, ...DOCUMENT_MEDIA_TYPES]);

const MEDIA_TYPE_EXT: Record<string, string> = {
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

/** Save base64 image data to disk and return the server-relative URL. */
async function saveImage(jobId: string, index: number, mediaType: string, base64Data: string): Promise<string> {
  const ext = MEDIA_TYPE_EXT[mediaType] ?? "bin";
  const dir = `${IMAGES_DIR}/${jobId}`;
  await mkdir(dir, { recursive: true });
  const filename = `${index}.${ext}`;
  await writeFile(`${dir}/${filename}`, Buffer.from(base64Data, "base64"));
  return `/images/${jobId}/${filename}`;
}

interface RawImage { mediaType: string; data: string }

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

async function planJob(id: string, prompt: string, tools: string[], cwd: string | null, rawImages: RawImage[]): Promise<void> {
  store.setStatus(id, "planning");
  const planTexts: string[] = [];
  let imageCounter = rawImages.length; // output images start after input image indices
  try {
    const promptArg = rawImages.length > 0
      ? makePrompt(prompt, rawImages, id)
      : prompt;
    for await (const message of query({
      prompt: promptArg as any,
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
          } else if ((block as any).type === "image") {
            const b = block as any;
            if (b.source?.type === "base64") {
              const url = await saveImage(id, imageCounter++, b.source.media_type, b.source.data);
              store.appendLog(id, { type: "image", mediaType: b.source.media_type, url, ts });
            }
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

async function revisePlanJob(id: string, feedback: string, sessionId: string, tools: string[], cwd: string | null): Promise<void> {
  store.setStatus(id, "planning");
  store.appendLog(id, { type: "user", text: feedback, ts: new Date().toISOString() });
  const planTexts: string[] = [];
  let imageCounter = 0;
  try {
    for await (const message of query({
      prompt: feedback,
      options: {
        allowedTools: tools,
        permissionMode: "plan",
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
            planTexts.push(block.text);
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
        const newSessionId = (message as any).session_id ?? (message as any).sessionId;
        if (newSessionId) store.setSessionId(id, newSessionId);
      }
    }
    store.setPlan(id, planTexts.join("\n"));
    store.setStatus(id, "awaiting_approval");
  } catch (err) {
    store.setError(id, err instanceof Error ? err.message : String(err));
    store.setStatus(id, "failed");
  }
}

async function directExecuteJob(id: string, prompt: string, tools: string[], cwd: string | null, rawImages: RawImage[]): Promise<void> {
  store.setStatus(id, "running");
  let imageCounter = rawImages.length;
  try {
    const promptArg = rawImages.length > 0
      ? makePrompt(prompt, rawImages, id)
      : prompt;
    for await (const message of query({
      prompt: promptArg as any,
      options: {
        permissionMode: "acceptEdits",
        canUseTool: makeCanUseTool(id),
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
          } else if ((block as any).type === "image") {
            const b = block as any;
            if (b.source?.type === "base64") {
              const url = await saveImage(id, imageCounter++, b.source.media_type, b.source.data);
              store.appendLog(id, { type: "image", mediaType: b.source.media_type, url, ts });
            }
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

async function executeJob(id: string, sessionId: string, tools: string[], cwd: string | null): Promise<void> {
  store.setStatus(id, "running");
  let imageCounter = 0;
  try {
    for await (const message of query({
      prompt: "The plan has been approved. Please proceed with execution.",
      options: {
        permissionMode: "acceptEdits",
        canUseTool: makeCanUseTool(id),
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
          } else if ((block as any).type === "image") {
            const b = block as any;
            if (b.source?.type === "base64") {
              const url = await saveImage(id, imageCounter++, b.source.media_type, b.source.data);
              store.appendLog(id, { type: "image", mediaType: b.source.media_type, url, ts });
            }
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

async function followUpJob(id: string, prompt: string, sessionId: string, tools: string[], cwd: string | null, rawImages: RawImage[]): Promise<void> {
  store.setStatus(id, "running");
  store.clearResult(id);
  store.appendLog(id, { type: "user", text: prompt, ts: new Date().toISOString() });
  let imageCounter = 0;
  try {
    const promptArg = rawImages.length > 0
      ? makePrompt(prompt, rawImages, `${id}-followup-${Date.now()}`)
      : prompt;
    for await (const message of query({
      prompt: promptArg as any,
      options: {
        permissionMode: "acceptEdits",
        canUseTool: makeCanUseTool(id),
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
          } else if ((block as any).type === "image") {
            const b = block as any;
            if (b.source?.type === "base64") {
              const url = await saveImage(id, imageCounter++, b.source.media_type, b.source.data);
              store.appendLog(id, { type: "image", mediaType: b.source.media_type, url, ts });
            }
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

/** Validate a raw images array from a request body. Returns an error string or null. */
function validateImages(raw: unknown): string | null {
  if (!Array.isArray(raw)) return "images must be an array";
  for (let i = 0; i < raw.length; i++) {
    const img = raw[i];
    if (typeof img !== "object" || img === null) return `images[${i}] must be an object`;
    const { mediaType, data } = img as Record<string, unknown>;
    if (typeof mediaType !== "string" || !ALLOWED_MEDIA_TYPES.has(mediaType)) {
      return `images[${i}].mediaType must be one of: ${[...ALLOWED_MEDIA_TYPES].join(", ")}`;
    }
    if (typeof data !== "string" || data.trim() === "") {
      return `images[${i}].data must be a non-empty base64 string`;
    }
  }
  return null;
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

    // Serve saved images
    const imageMatch = path.match(/^\/images\/([^/]+)\/([^/]+)$/);
    if (req.method === "GET" && imageMatch) {
      const [, jobId, filename] = imageMatch;
      // Sanitize: no path traversal
      if (!/^[\w.-]+$/.test(jobId!) || !/^[\w.-]+$/.test(filename!)) {
        return jsonError(400, "Invalid image path");
      }
      const filePath = `${IMAGES_DIR}/${jobId}/${filename}`;
      const file = Bun.file(filePath);
      if (!(await file.exists())) return jsonError(404, "Image not found");
      const ext = filename!.split(".").pop()?.toLowerCase();
      const EXT_CONTENT_TYPE: Record<string, string> = {
        jpg: "image/jpeg", jpeg: "image/jpeg",
        png: "image/png", gif: "image/gif", webp: "image/webp",
        pdf: "application/pdf",
        txt: "text/plain", html: "text/html", csv: "text/csv", xml: "text/xml",
      };
      const contentType = EXT_CONTENT_TYPE[ext ?? ""] ?? "application/octet-stream";
      return new Response(file, { headers: { "Content-Type": contentType } });
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

      let rawImages: RawImage[] = [];
      if ("images" in b) {
        const err = validateImages(b["images"]);
        if (err) return jsonError(400, err);
        rawImages = b["images"] as RawImage[];
      }

      let mode: JobMode = "auto";
      if ("mode" in b) {
        if (b["mode"] !== "auto" && b["mode"] !== "plan" && b["mode"] !== "edit") {
          return jsonError(400, 'mode must be one of: "auto", "plan", "edit"');
        }
        mode = b["mode"] as JobMode;
      }

      const id = `${new Date().toISOString().replace(/[-:.]/g, "")}-${randomUUID()}`;

      // Build InputFile refs (filenames will be <index>.<ext>)
      const inputImageRefs: InputFile[] = rawImages.map((img, i) => ({
        mediaType: img.mediaType,
        filename: `${i}.${MEDIA_TYPE_EXT[img.mediaType] ?? "bin"}`,
      }));

      store.createJob(id, prompt, tools, cwd, inputImageRefs, mode);
      if (mode === "edit") {
        Promise.resolve().then(() => directExecuteJob(id, prompt, tools, cwd, rawImages));
      } else {
        // "auto" and "plan" both use the planning flow for now
        Promise.resolve().then(() => planJob(id, prompt, tools, cwd, rawImages));
      }

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

    const reviseMatch = path.match(/^\/jobs\/([^/]+)\/revise$/);
    if (req.method === "POST" && reviseMatch) {
      const id = reviseMatch[1]!;
      const job = store.getJob(id);
      if (!job) return jsonError(404, "Job not found");
      if (job.status !== "awaiting_approval") return jsonError(409, "Job is not awaiting approval");
      if (!job.sessionId) return jsonError(500, "No session ID available for revision");
      let body: unknown;
      try { body = await req.json(); } catch { return jsonError(400, "Invalid JSON body"); }
      const b = body as Record<string, unknown>;
      if (typeof b["prompt"] !== "string" || b["prompt"].trim() === "") {
        return jsonError(400, "prompt must be a non-empty string");
      }
      Promise.resolve().then(() => revisePlanJob(id, (b["prompt"] as string).trim(), job.sessionId!, job.tools, job.cwd));
      return json(202, { id, status: "planning" });
    }

    const approveToolMatch = path.match(/^\/jobs\/([^/]+)\/approve-tool$/);
    if (req.method === "POST" && approveToolMatch) {
      const id = approveToolMatch[1]!;
      const job = store.getJob(id);
      if (!job) return jsonError(404, "Job not found");
      if (job.status !== "awaiting_tool_approval") return jsonError(409, "Job is not awaiting tool approval");
      const pending = pendingToolApprovals.get(id);
      if (!pending) return jsonError(500, "No pending tool approval resolver found");
      const approvedInput = job.pendingTool?.input ?? {};
      store.clearPendingTool(id);
      store.setStatus(id, "running");
      pendingToolApprovals.delete(id);
      pending.resolve({ behavior: "allow", updatedInput: approvedInput });
      return json(202, { id, status: "running" });
    }

    const rejectToolMatch = path.match(/^\/jobs\/([^/]+)\/reject-tool$/);
    if (req.method === "POST" && rejectToolMatch) {
      const id = rejectToolMatch[1]!;
      const job = store.getJob(id);
      if (!job) return jsonError(404, "Job not found");
      if (job.status !== "awaiting_tool_approval") return jsonError(409, "Job is not awaiting tool approval");
      const pending = pendingToolApprovals.get(id);
      if (!pending) return jsonError(500, "No pending tool approval resolver found");
      store.clearPendingTool(id);
      store.setStatus(id, "running");
      pendingToolApprovals.delete(id);
      pending.resolve({ behavior: "deny", message: "User denied this tool call" });
      return json(200, { id, status: "running" });
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

      let rawImages: RawImage[] = [];
      if ("images" in b) {
        const err = validateImages(b["images"]);
        if (err) return jsonError(400, err);
        rawImages = b["images"] as RawImage[];
      }

      Promise.resolve().then(() => followUpJob(id, (b["prompt"] as string).trim(), job.sessionId!, job.tools, job.cwd, rawImages));
      return json(202, { id, status: "running" });
    }

    return jsonError(404, "Not found");
  },
});

console.log(`Listening on http://${HOST}:${PORT}`);
