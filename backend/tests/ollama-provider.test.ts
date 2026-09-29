import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { ModelProviderError } from '../src/ai/errors.js';
import { OllamaProvider } from '../src/ai/ollama-provider.js';

const provider = new OllamaProvider({
  baseUrl: 'http://127.0.0.1:11434',
  model: 'qwen3.5:9b',
  timeoutMs: 1000,
});

const input = {
  systemPrompt: 'Answer only from supplied knowledge.',
  messages: [
    {
      role: 'user' as const,
      content: 'What workshops do you offer?',
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OllamaProvider', () => {
  it('parses a valid structured Ollama response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          message: {
            content: JSON.stringify({
              canAnswer: true,
              answer: 'The workshops are free.',
              sourceIds: ['SRC-003'],
            }),
          },
        }),
      })),
    );

    await expect(
      provider.generateAnswer(input),
    ).resolves.toEqual({
      canAnswer: true,
      answer: 'The workshops are free.',
      sourceIds: ['SRC-003'],
    });
  });

  it('rejects malformed model JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          message: {
            content: 'not valid JSON',
          },
        }),
      })),
    );

    await expect(
      provider.generateAnswer(input),
    ).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('reports Ollama connection failure as unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError(
          'fetch failed',
        );
      }),
    );

    try {
      await provider.generateAnswer(input);
      throw new Error(
        'Expected provider to fail.',
      );
    } catch (error) {
      expect(error).toBeInstanceOf(
        ModelProviderError,
      );

      expect(error).toMatchObject({
        code: 'unavailable',
      });
    }
  });
});
