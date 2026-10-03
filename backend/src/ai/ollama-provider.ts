import { z } from 'zod';

import { ModelProviderError } from './errors.js';
import {
  ModelAnswerSchema,
  type ModelInput,
  type ModelProvider,
} from './types.js';

const OllamaResponseSchema = z.object({
  message: z.object({
    content: z.string(),
  }),
});

const OUTPUT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    canAnswer: {
      type: 'boolean',
    },
    answer: {
      type: 'string',
    },
    sourceIds: {
      type: 'array',
      items: {
        type: 'string',
        pattern: '^(?:S[1-9][0-9]{0,2}|SRC-[0-9]{3}|DOC-[A-Z0-9-]+-B[0-9]{4}-C[0-9]{3})$',
      },
      maxItems: 8,
    },
  },
  required: ['canAnswer', 'answer', 'sourceIds'],
  additionalProperties: false,
} as const;

export interface OllamaProviderOptions {
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

export class OllamaProvider implements ModelProvider {
  constructor(private readonly options: OllamaProviderOptions) {}

  async generateAnswer(input: ModelInput) {
    const result = ModelAnswerSchema.safeParse(await this.generateStructured(input, OUTPUT_JSON_SCHEMA));
    if (!result.success) throw new ModelProviderError('invalid_response', 'Ollama returned an unexpected answer structure.');
    return result.data;
  }

  async generateStructured(input: ModelInput, schema: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs,
    );

    try {
      const response = await fetch(
        `${this.options.baseUrl.replace(/\/$/, '')}/api/chat`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          signal: input.signal ? AbortSignal.any([controller.signal, input.signal]) : controller.signal,
          body: JSON.stringify({
            model: this.options.model,
            stream: false,
            think: false,
            format: schema,
            options: {
              temperature: 0,
            },
            messages: [
              {
                role: 'system',
                content: input.systemPrompt,
              },
              ...input.messages,
            ],
          }),
        },
      );

      if (!response.ok) {
        throw new ModelProviderError(
          'unavailable',
          `Ollama returned HTTP ${response.status}.`,
        );
      }

      const rawResponse: unknown = await response.json();

      const ollamaResponse =
        OllamaResponseSchema.parse(rawResponse);

      let parsedContent: unknown;

      try {
        parsedContent = JSON.parse(
          ollamaResponse.message.content,
        );
      } catch (error) {
        throw new ModelProviderError(
          'invalid_response',
          'Ollama returned invalid JSON.',
          { cause: error },
        );
      }

      return parsedContent;
    } catch (error) {
      if (error instanceof ModelProviderError) {
        throw error;
      }

      if (controller.signal.aborted) {
        throw new ModelProviderError(
          'timeout',
          `Ollama did not respond within ${this.options.timeoutMs} ms.`,
          { cause: error },
        );
      }

      if (error instanceof z.ZodError) {
        throw new ModelProviderError(
          'invalid_response',
          'Ollama returned a response with an unexpected structure.',
          { cause: error },
        );
      }

      throw new ModelProviderError(
        'unavailable',
        'Could not connect to Ollama.',
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
