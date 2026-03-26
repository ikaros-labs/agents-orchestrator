import { randomUUID } from "node:crypto";
import { z } from "zod";
import * as store from "./store.ts";
import * as jobs from "./jobs.ts";
import { CreateJobSchema, ReviseSchema, ToolActionSchema, AnswerQuestionSchema, FollowUpSchema } from "./schemas.ts";
import type { JobMode } from "./types.ts";

const sseEncoder = new TextEncoder();

store.loadStore();

const UI_HTML = await Bun.file(new URL("./public/index.html", import.meta.url)).text();

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "localhost";

// ── Response helpers ─────────────────────────────────────────────────────────

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

/**
 * Parses and validates a request body against a Zod schema.
 * Returns `{ data }` on success or an error Response on failure.
 */
async function parseBody<S extends z.ZodTypeAny>(req: Request, schema: S): Promise<{ data: z.output<S> } | Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonError(400, "Invalid JSON body");
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    return jsonError(400, result.error.issues[0]?.message ?? "Invalid request body");
  }
  return { data: result.data };
}

// ── EXT → Content-Type map (for image serving) ───────────────────────────────

const EXT_CONTENT_TYPE: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg",
  png: "image/png", gif: "image/gif", webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain", html: "text/html", csv: "text/csv", xml: "text/xml",
};

// ── Server ───────────────────────────────────────────────────────────────────

Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 0, // disable idle timeout so SSE connections are never closed by inactivity

  routes: {
    // ── Static assets ──────────────────────────────────────────────────────

    "/": () => new Response(UI_HTML, { headers: { "Content-Type": "text/html" } }),

    "/style.css": () =>
      new Response(Bun.file(new URL("./public/style.css", import.meta.url)), {
        headers: { "Content-Type": "text/css" },
      }),

    "/app.js": () =>
      new Response(Bun.file(new URL("./public/app.js", import.meta.url)), {
        headers: { "Content-Type": "text/javascript" },
      }),

    // ── Saved images / documents ───────────────────────────────────────────

    "/images/:jobId/:filename": async (req) => {
      const { jobId, filename } = req.params;
      // Sanitize: no path traversal
      if (!/^[\w.-]+$/.test(jobId) || !/^[\w.-]+$/.test(filename)) {
        return jsonError(400, "Invalid image path");
      }
      const file = Bun.file(`${jobs.IMAGES_DIR}/${jobId}/${filename}`);
      if (!(await file.exists())) return jsonError(404, "Image not found");
      const ext = filename.split(".").pop()?.toLowerCase() ?? "";
      return new Response(file, {
        headers: { "Content-Type": EXT_CONTENT_TYPE[ext] ?? "application/octet-stream" },
      });
    },

    // ── SSE event stream ───────────────────────────────────────────────────

    "/events": () => {
      let unsubscribe: (() => void) | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;

      const stream = new ReadableStream({
        start(controller) {
          // Bootstrap the client with the full current job list
          const snapshot = store.listJobs();
          controller.enqueue(sseEncoder.encode(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`));

          // Forward every store mutation as a typed SSE event
          unsubscribe = store.subscribe((event) => {
            try {
              controller.enqueue(sseEncoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
            } catch {
              // Stream already closed — subscriber will be cleaned up in cancel()
            }
          });

          // Keep the connection alive through proxies / load balancers.
          // 8s is safely below common proxy idle timeouts (nginx default: 60s, but
          // some intermediaries use 10s) and well below our own idleTimeout: 0 setting.
          heartbeat = setInterval(() => {
            try {
              controller.enqueue(sseEncoder.encode(":\n\n"));
            } catch {
              if (heartbeat) clearInterval(heartbeat);
            }
          }, 8_000);
        },
        cancel() {
          if (unsubscribe) unsubscribe();
          if (heartbeat) clearInterval(heartbeat);
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no", // disable nginx buffering if present
        },
      });
    },

    // ── Jobs ───────────────────────────────────────────────────────────────

    "/jobs": async (req) => {
      if (req.method === "GET") {
        return Response.json(store.listJobs());
      }

      if (req.method === "POST") {
        const parsed = await parseBody(req, CreateJobSchema);
        if (parsed instanceof Response) return parsed;
        const { prompt, tools: rawTools, cwd = null, useWorktree, images: rawImages, mode } = parsed.data;

        const tools = rawTools ?? jobs.DEFAULT_TOOLS;
        const id = `${new Date().toISOString().replace(/[-:.]/g, "")}-${randomUUID()}`;

        // Build InputFile refs (filenames will be <index>.<ext>)
        const inputImageRefs = rawImages.map((img, i) => ({
          mediaType: img.mediaType,
          filename: `${i}.${jobs.MEDIA_TYPE_EXT[img.mediaType] ?? "bin"}`,
        }));

        store.createJob(id, prompt, tools, cwd, inputImageRefs, mode as JobMode, useWorktree);
        if (mode === "edit") {
          Promise.resolve().then(() => jobs.directExecuteJob(id, prompt, tools, cwd, rawImages, useWorktree));
        } else {
          // "auto" and "plan" both use the planning flow
          Promise.resolve().then(() => jobs.planJob(id, prompt, tools, cwd, rawImages, useWorktree));
        }

        return Response.json({ id, status: "pending" }, { status: 202 });
      }

      return new Response("Method Not Allowed", { status: 405 });
    },

    // ── Single job ─────────────────────────────────────────────────────────

    "/jobs/:id": (req) => {
      const { id } = req.params;
      const job = store.getJob(id);
      if (!job) return jsonError(404, "Job not found");
      return Response.json(job);
    },

    // ── Plan approval lifecycle ────────────────────────────────────────────

    "/jobs/:id/approve": (req) => {
      const { id } = req.params;
      const job = store.getJob(id);
      if (!job) return jsonError(404, "Job not found");
      if (job.status !== "awaiting_approval") return jsonError(409, "Job is not awaiting approval");
      if (!job.sessionId) return jsonError(500, "No session ID from planning phase");
      Promise.resolve().then(() => jobs.executeJob(id, job.sessionId!, job.tools, job.worktreePath ?? job.cwd));
      return Response.json({ id, status: "running" }, { status: 202 });
    },

    "/jobs/:id/reject": (req) => {
      const { id } = req.params;
      const job = store.getJob(id);
      if (!job) return jsonError(404, "Job not found");
      if (job.status !== "awaiting_approval") return jsonError(409, "Job is not awaiting approval");
      store.setError(id, "Rejected by user");
      store.setStatus(id, "failed");
      return Response.json({ id, status: "failed" });
    },

    "/jobs/:id/revise": async (req) => {
      const { id } = req.params;
      const job = store.getJob(id);
      if (!job) return jsonError(404, "Job not found");
      if (job.status !== "awaiting_approval") return jsonError(409, "Job is not awaiting approval");
      if (!job.sessionId) return jsonError(500, "No session ID available for revision");
      const parsed = await parseBody(req, ReviseSchema);
      if (parsed instanceof Response) return parsed;
      Promise.resolve().then(() => jobs.revisePlanJob(id, parsed.data.prompt, job.sessionId!, job.tools, job.worktreePath ?? job.cwd));
      return Response.json({ id, status: "planning" }, { status: 202 });
    },

    // ── Tool approval ──────────────────────────────────────────────────────

    "/jobs/:id/approve-tool": async (req) => {
      const { id } = req.params;
      const job = store.getJob(id);
      if (!job) return jsonError(404, "Job not found");
      if (job.status !== "awaiting_tool_approval") return jsonError(409, "Job is not awaiting tool approval");
      const parsed = await parseBody(req, ToolActionSchema);
      if (parsed instanceof Response) return parsed;
      const { toolUseID } = parsed.data;
      if (!jobs.hasPendingApproval(id, toolUseID)) return jsonError(404, "No pending tool approval found for that toolUseID");
      const pendingTool = job.pendingTools.find(t => t.toolUseID === toolUseID);
      const approvedInput = pendingTool?.input ?? {};
      console.log(`[approve-tool] id=${id} tool=${pendingTool?.name} toolUseID=${toolUseID} → granted`);
      store.removePendingTool(id, toolUseID);
      if (job.pendingTools.length === 0) store.setStatus(id, "running");
      jobs.resolveToolApproval(id, toolUseID, { behavior: "allow", updatedInput: approvedInput });
      return Response.json({ id, status: job.pendingTools.length === 0 ? "running" : "awaiting_tool_approval" }, { status: 202 });
    },

    "/jobs/:id/reject-tool": async (req) => {
      const { id } = req.params;
      const job = store.getJob(id);
      if (!job) return jsonError(404, "Job not found");
      if (job.status !== "awaiting_tool_approval") return jsonError(409, "Job is not awaiting tool approval");
      const parsed = await parseBody(req, ToolActionSchema);
      if (parsed instanceof Response) return parsed;
      const { toolUseID } = parsed.data;
      if (!jobs.hasPendingApproval(id, toolUseID)) return jsonError(404, "No pending tool approval found for that toolUseID");
      const pendingTool = job.pendingTools.find(t => t.toolUseID === toolUseID);
      console.log(`[reject-tool] id=${id} tool=${pendingTool?.name} toolUseID=${toolUseID} → denied`);
      store.removePendingTool(id, toolUseID);
      if (job.pendingTools.length === 0) store.setStatus(id, "running");
      jobs.resolveToolApproval(id, toolUseID, { behavior: "deny", message: "User denied this tool call" });
      return Response.json({ id, status: job.pendingTools.length === 0 ? "running" : "awaiting_tool_approval" });
    },

    // ── AskUserQuestion ────────────────────────────────────────────────────

    "/jobs/:id/answer-question": async (req) => {
      const { id } = req.params;
      const job = store.getJob(id);
      if (!job) return jsonError(404, "Job not found");
      if (job.status !== "awaiting_user_question") return jsonError(409, "Job is not awaiting a user question");
      const askToolEntry = job.pendingTools.find(t => t.name === "AskUserQuestion");
      if (!askToolEntry) return jsonError(500, "No AskUserQuestion tool found in pending tools");
      if (!jobs.hasPendingApproval(id, askToolEntry.toolUseID)) return jsonError(500, "No pending question resolver found");
      const parsed = await parseBody(req, AnswerQuestionSchema);
      if (parsed instanceof Response) return parsed;
      const { answers } = parsed.data;
      const questions = ((askToolEntry.input as any)?.questions) ?? [];
      // Log answers to the job feed so they're visible in the conversation
      const ts = new Date().toISOString();
      const answerText = (questions as any[]).map((q: any) => {
        const ans = answers[q.question] ?? "(no answer)";
        return `${q.question}\n→ ${ans}`;
      }).join("\n\n");
      if (answerText) store.appendLog(id, { type: "user", text: answerText, ts });
      store.removePendingTool(id, askToolEntry.toolUseID);
      // Return to "planning" if we haven't produced a plan yet, otherwise "running"
      store.setStatus(id, job.plan === null ? "planning" : "running");
      jobs.resolveToolApproval(id, askToolEntry.toolUseID, { behavior: "allow", updatedInput: { questions, answers } });
      return Response.json({ id, status: "running" }, { status: 202 });
    },

    // ── Stop ───────────────────────────────────────────────────────────────

    "/jobs/:id/stop": (req) => {
      const { id } = req.params;
      const job = store.getJob(id);
      if (!job) return jsonError(404, "Job not found");
      const stoppable = new Set(["pending", "planning", "running", "awaiting_tool_approval", "awaiting_user_question"]);
      if (!stoppable.has(job.status)) return jsonError(409, "Job cannot be stopped in its current state");
      jobs.stopJob(id);
      return Response.json({ id, status: "stopped" });
    },

    // ── Follow-up ──────────────────────────────────────────────────────────

    "/jobs/:id/followup": async (req) => {
      const { id } = req.params;
      const job = store.getJob(id);
      if (!job) return jsonError(404, "Job not found");
      if (job.status !== "completed" && job.status !== "failed" && job.status !== "stopped") return jsonError(409, "Job is not completed");
      if (!job.sessionId) return jsonError(500, "No session ID available for follow-up");
      const parsed = await parseBody(req, FollowUpSchema);
      if (parsed instanceof Response) return parsed;
      const { prompt, images: rawImages } = parsed.data;
      Promise.resolve().then(() => jobs.followUpJob(id, prompt, job.sessionId!, job.tools, job.worktreePath ?? job.cwd, rawImages));
      return Response.json({ id, status: "running" }, { status: 202 });
    },
  },

  fetch() {
    return jsonError(404, "Not found");
  },
});

console.log(`Listening on http://${HOST}:${PORT}`);
