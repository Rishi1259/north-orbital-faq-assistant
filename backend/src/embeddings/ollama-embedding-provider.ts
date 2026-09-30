import { z } from 'zod';

import type {
  EmbeddingProvider,
} from './types.js';

const OllamaEmbedResponseSchema =
  z.object({
    embeddings: z.array(
      z.array(z.number()),
    ),
  });

export interface OllamaEmbeddingProviderOptions {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}

export class OllamaEmbeddingProvider
  implements EmbeddingProvider
{
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(
    options: OllamaEmbeddingProviderOptions = {},
  ) {
    this.baseUrl =
      options.baseUrl ??
      process.env.OLLAMA_BASE_URL ??
      'http://127.0.0.1:11434';

    this.model =
      options.model ??
      process.env.OLLAMA_EMBEDDING_MODEL ??
      'qwen3-embedding:0.6b';

    this.timeoutMs =
      options.timeoutMs ??
      Number(
        process.env.EMBEDDING_TIMEOUT_MS ??
        30000,
      );
  }

  async embed(
    inputs: string[],
  ): Promise<number[][]> {
    if (inputs.length === 0) {
      return [];
    }

    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () =>
          controller.abort(),
        this.timeoutMs,
      );

    try {
      const response =
        await fetch(
          `${this.baseUrl.replace(/\/$/, '')}/api/embed`,
          {
            method: 'POST',

            headers: {
              'Content-Type':
                'application/json',
            },

            body: JSON.stringify({
              model: this.model,
              input: inputs,
            }),

            signal:
              controller.signal,
          },
        );

      if (!response.ok) {
        throw new Error(
          `Ollama embedding request failed with HTTP ${response.status}.`,
        );
      }

      const parsed =
        OllamaEmbedResponseSchema.parse(
          await response.json(),
        );

      if (
        parsed.embeddings.length !==
        inputs.length
      ) {
        throw new Error(
          `Expected ${inputs.length} embeddings but received ${parsed.embeddings.length}.`,
        );
      }

      const dimensions =
        parsed.embeddings[0]?.length ??
        0;

      if (dimensions === 0) {
        throw new Error(
          'Ollama returned an empty embedding.',
        );
      }

      if (
        parsed.embeddings.some(
          (embedding) =>
            embedding.length !==
            dimensions,
        )
      ) {
        throw new Error(
          'Ollama returned embeddings with inconsistent dimensions.',
        );
      }

      return parsed.embeddings;
    } finally {
      clearTimeout(timeout);
    }
  }
}
