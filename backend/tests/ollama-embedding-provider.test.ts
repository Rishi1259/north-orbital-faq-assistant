import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  OllamaEmbeddingProvider,
} from '../src/embeddings/ollama-embedding-provider.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe(
  'OllamaEmbeddingProvider',
  () => {
    it('returns embeddings for all inputs', async () => {
      vi.spyOn(
        globalThis,
        'fetch',
      ).mockResolvedValue(
        new Response(
          JSON.stringify({
            embeddings: [
              [0.1, 0.2, 0.3],
              [0.4, 0.5, 0.6],
            ],
          }),
          {
            status: 200,
            headers: {
              'Content-Type':
                'application/json',
            },
          },
        ),
      );

      const provider =
        new OllamaEmbeddingProvider({
          baseUrl:
            'http://localhost:11434',
          model:
            'test-embedding-model',
        });

      const result =
        await provider.embed([
          'first text',
          'second text',
        ]);

      expect(result).toEqual([
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ]);
    });

    it('returns an empty array for no inputs', async () => {
      const fetchSpy =
        vi.spyOn(
          globalThis,
          'fetch',
        );

      const provider =
        new OllamaEmbeddingProvider();

      expect(
        await provider.embed([]),
      ).toEqual([]);

      expect(
        fetchSpy,
      ).not.toHaveBeenCalled();
    });

    it('rejects inconsistent embedding dimensions', async () => {
      vi.spyOn(
        globalThis,
        'fetch',
      ).mockResolvedValue(
        new Response(
          JSON.stringify({
            embeddings: [
              [0.1, 0.2],
              [0.3],
            ],
          }),
          {
            status: 200,
            headers: {
              'Content-Type':
                'application/json',
            },
          },
        ),
      );

      const provider =
        new OllamaEmbeddingProvider();

      await expect(
        provider.embed([
          'one',
          'two',
        ]),
      ).rejects.toThrow(
        'inconsistent dimensions',
      );
    });
  },
);
