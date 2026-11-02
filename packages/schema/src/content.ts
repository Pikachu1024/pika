import { z } from "zod";

export const TextContentSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const ImageContentSchema = z.object({
  type: z.literal("image"),
  mediaType: z.string().min(1),
  data: z.string().min(1),
  alt: z.string().optional(),
});

export const ErrorContentSchema = z.object({
  type: z.literal("error"),
  message: z.string().min(1),
  code: z.string().min(1).optional(),
});

export const ContentPartSchema = z.discriminatedUnion("type", [
  TextContentSchema,
  ImageContentSchema,
  ErrorContentSchema,
]);

export type TextContent = z.infer<typeof TextContentSchema>;
export type ImageContent = z.infer<typeof ImageContentSchema>;
export type ErrorContent = z.infer<typeof ErrorContentSchema>;
export type ContentPart = z.infer<typeof ContentPartSchema>;
