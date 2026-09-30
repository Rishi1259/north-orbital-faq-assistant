import { z } from 'zod';

export const ChatMessageSchema = z.object({
  role: z.enum([
    'user',
    'assistant',
  ]),
  content: z
    .string()
    .trim()
    .min(1)
    .max(1000),
});

export const ChatRequestSchema = z.object({
  message: z
    .string()
    .trim()
    .min(1)
    .max(1000),

  history: z
    .array(
      ChatMessageSchema,
    )
    .max(6)
    .default([]),
});

export const CitationIdSchema =
  z.string().regex(
    /^(?:SRC-\d{3}|DOC-[A-Z0-9-]+-B\d{4}-C\d{3})$/,
  );

export const ModelAnswerSchema =
  z.object({
    canAnswer: z.boolean(),

    answer: z
      .string()
      .max(2000),

    sourceIds: z
      .array(
        CitationIdSchema,
      )
      .max(5),
  });

export type ChatMessage =
  z.infer<
    typeof ChatMessageSchema
  >;

export type ChatRequest =
  z.infer<
    typeof ChatRequestSchema
  >;

export type ModelAnswer =
  z.infer<
    typeof ModelAnswerSchema
  >;

export interface ModelInput {
  systemPrompt: string;
  messages: ChatMessage[];
}

export interface ModelProvider {
  generateAnswer(
    input: ModelInput,
  ): Promise<ModelAnswer>;
}
