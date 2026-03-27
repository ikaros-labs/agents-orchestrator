import { z } from "zod";
import { ALLOWED_MEDIA_TYPES } from "./jobs.ts";

export const RawImageSchema = z.object({
  mediaType: z.string().refine(mt => ALLOWED_MEDIA_TYPES.has(mt), {
    message: `mediaType must be one of: ${[...ALLOWED_MEDIA_TYPES].join(", ")}`,
  }),
  data: z.string().min(1, "data must be a non-empty base64 string"),
});

export const CreateJobSchema = z.object({
  prompt: z.string().trim().min(1, "prompt must be a non-empty string"),
  tools: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  useWorktree: z.boolean().optional().default(true),
  images: z.array(RawImageSchema).default([]),
  mode: z.enum(["auto", "plan", "edit", "sandbox"]).optional().default("auto"),
  model: z.string().optional().default("claude-sonnet-4-6"),
  effort: z.enum(["low", "medium", "high", "max"]).optional().default("high"),
});

export const ReviseSchema = z.object({
  prompt: z.string().trim().min(1, "prompt must be a non-empty string"),
});

export const ToolActionSchema = z.object({
  toolUseID: z.string().min(1, "toolUseID is required"),
});

export const AnswerQuestionSchema = z.object({
  answers: z.record(z.string()),
});

export const FollowUpSchema = z.object({
  prompt: z.string().trim().min(1, "prompt must be a non-empty string"),
  images: z.array(RawImageSchema).default([]),
});
