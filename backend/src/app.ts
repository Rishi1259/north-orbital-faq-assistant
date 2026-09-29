import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { ZodError } from 'zod';

import { ModelProviderError } from './ai/errors.js';
import { createModelProvider } from './ai/provider-factory.js';
import {
  ChatRequestSchema,
  type ModelProvider,
} from './ai/types.js';
import { createChatService } from './chat-service.js';
import { loadKnowledge } from './knowledge/loader.js';

export interface AppOptions {
  provider?: ModelProvider;
}

export function createApp(
  options: AppOptions = {},
) {
  const app = express();

  const provider =
    options.provider ?? createModelProvider();

  const chatService = createChatService(provider);
  const knowledge = loadKnowledge();

  app.use(helmet());

  app.use(
    cors({
      origin: 'http://localhost:4200',
    }),
  );

  app.use(
    express.json({
      limit: '16kb',
    }),
  );

  app.get('/api/health', (_request, response) => {
    response.json({
      status: 'ok',
      service: 'north-orbital-faq-assistant',
    });
  });

  app.get(
    '/api/sources/:sourceId',
    (request, response) => {
      const source = knowledge.sources.find(
        (item) =>
          item.id === request.params.sourceId,
      );

      if (!source) {
        response.status(404).json({
          error: {
            code: 'SOURCE_NOT_FOUND',
            message: 'Source not found.',
          },
        });
        return;
      }

      response.json(source);
    },
  );

  const configuredRateLimit = Number(
    process.env.CHAT_RATE_LIMIT_MAX ?? 30,
  );

  const chatRateLimit =
    Number.isInteger(configuredRateLimit) &&
    configuredRateLimit > 0
      ? configuredRateLimit
      : 30;

  const chatRateLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    limit: chatRateLimit,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: {
        code: 'RATE_LIMITED',
        message:
          'Too many chat requests. Please try again shortly.',
      },
    },
  });

  app.post(
    '/api/chat',
    chatRateLimiter,
    async (request, response) => {
      try {
        const chatRequest =
          ChatRequestSchema.parse(request.body);

        const result =
          await chatService.chat(chatRequest);

        response.json(result);
      } catch (error) {
        if (error instanceof ZodError) {
          response.status(400).json({
            error: {
              code: 'INVALID_REQUEST',
              message:
                'The chat request is invalid.',
              details: error.issues.map((issue) => ({
                path: issue.path.join('.'),
                message: issue.message,
              })),
            },
          });
          return;
        }

        if (error instanceof ModelProviderError) {
          if (error.code === 'timeout') {
            response.status(504).json({
              error: {
                code: 'MODEL_TIMEOUT',
                message:
                  'The AI model took too long to respond. Please try again.',
              },
            });
            return;
          }

          if (error.code === 'invalid_response') {
            response.status(502).json({
              error: {
                code: 'MODEL_INVALID_RESPONSE',
                message:
                  'The AI model returned an invalid response. Please try again.',
              },
            });
            return;
          }

          response.status(503).json({
            error: {
              code: 'MODEL_UNAVAILABLE',
              message:
                'The local AI model is unavailable. Make sure Ollama is running and try again.',
            },
          });
          return;
        }

        console.error(error);

        response.status(500).json({
          error: {
            code: 'INTERNAL_ERROR',
            message:
              'An unexpected server error occurred.',
          },
        });
      }
    },
  );

  return app;
}
