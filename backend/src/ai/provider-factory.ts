import type { ModelProvider } from './types.js';
import { OllamaProvider } from './ollama-provider.js';

function readPositiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Expected a positive integer but received "${value}".`,
    );
  }

  return parsed;
}

export function createModelProvider(): ModelProvider {
  const provider =
    process.env.MODEL_PROVIDER?.trim().toLowerCase() ??
    'ollama';

  if (provider !== 'ollama') {
    throw new Error(
      `Unsupported MODEL_PROVIDER "${provider}".`,
    );
  }

  return new OllamaProvider({
    baseUrl:
      process.env.OLLAMA_BASE_URL ??
      'http://127.0.0.1:11434',

    model:
      process.env.OLLAMA_MODEL ??
      'qwen3.5:9b',

    timeoutMs: readPositiveInteger(
      process.env.MODEL_TIMEOUT_MS,
      30000,
    ),
  });
}
