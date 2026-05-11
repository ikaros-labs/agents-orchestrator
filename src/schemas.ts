import { z } from "zod";
import { ALLOWED_MEDIA_TYPES } from "./sessions.ts";
import type { SandboxMode } from "./types.ts";

const SANDBOX_MODES = ["none", "sandbox", "yolo"] as const;

export const DEFAULTS = {
  model: "claude-sonnet-4-6",
  effort: "high" as const,
  mode: "auto" as const,
  sandbox: ((): SandboxMode => {
    const v = process.env.AGENT_SANDBOX;
    if (SANDBOX_MODES.includes(v as SandboxMode)) return v as SandboxMode;
    return "sandbox";
  })(),
};

export const RawImageSchema = z.object({
  mediaType: z.string().refine((mt) => ALLOWED_MEDIA_TYPES.has(mt), {
    message: `mediaType must be one of: ${[...ALLOWED_MEDIA_TYPES].join(", ")}`,
  }),
  data: z.string().min(1, "data must be a non-empty base64 string"),
});

export const CreateSessionSchema = z.object({
  prompt: z.string().trim().min(1, "prompt must be a non-empty string"),
  cwd: z.string().optional(),
  useWorktree: z.boolean().optional().default(true),
  images: z.array(RawImageSchema).default([]),
  mode: z.enum(["auto", "plan", "edit"]).optional().default(DEFAULTS.mode),
  model: z.string().optional().default(DEFAULTS.model),
  effort: z
    .enum(["low", "medium", "high", "max"])
    .optional()
    .default(DEFAULTS.effort),
  sandbox: z
    .enum(["none", "sandbox", "yolo"])
    .optional()
    .default(DEFAULTS.sandbox),
});

export const ReviseSchema = z.object({
  prompt: z.string().trim().min(1, "prompt must be a non-empty string"),
});

export const ToolActionSchema = z.object({
  toolUseID: z.string().min(1, "toolUseID is required"),
  reason: z.string().optional(),
});

export const AnswerQuestionSchema = z.object({
  answers: z.record(z.string()),
});

export const ApproveSessionSchema = z.object({
  model: z.string().optional(),
});

export const FollowUpSchema = z.object({
  prompt: z.string().trim().min(1, "prompt must be a non-empty string"),
  images: z.array(RawImageSchema).default([]),
});
