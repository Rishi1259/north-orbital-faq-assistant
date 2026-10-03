import { createProductionChatService } from './rag/chat-service.js';
import { ProductionRetriever } from './rag/retriever.js';
import { ModelQueryRewriter, type QueryRewriter } from './rag/query-rewriter.js';
import { loadRagConfig, type RagConfig } from './rag/config.js';
import type { RetrievalRepository, EmbeddingIdentity } from './rag/types.js';
import { z } from 'zod';
import type { DocumentService } from './ingestion/document-service.js';
import { createDocumentRouter } from './ingestion/document-router.js';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { ZodError } from 'zod';

import {
  ModelProviderError,
} from './ai/errors.js';

import {
  OllamaEmbeddingProvider,
} from './embeddings/ollama-embedding-provider.js';

import type {
  EmbeddingProvider,
} from './embeddings/types.js';


import {
  createModelProvider,
} from './ai/provider-factory.js';

import {
  ChatRequestSchema,
  type ModelProvider,
} from './ai/types.js';

import type {
  DocumentChunk,
  SemanticDocumentIndex,
} from './documents/types.js';

import {
  loadKnowledge,
} from './knowledge/loader.js';

import {
  requestLogger,
} from './logging/logger.js';

import {
  logger,
} from './logging/logger.js';

import type {
  ChatbotService,
} from './chatbots/chatbot-service.js';

import type {
  OrganizationService,
} from './organizations/organization-service.js';

import {
  createTenantRouter,
} from './tenancy/tenant-router.js';

import {
  ChatbotNotFoundError,
} from './chatbots/errors.js';

export interface AppOptions {
  retrievalRepository?: RetrievalRepository;
  ragConfig?: RagConfig;
  queryRewriter?: QueryRewriter;
  embeddingIdentity?: EmbeddingIdentity;
  documentService?: DocumentService;
  uploadMaxBytes?: number;
  provider?: ModelProvider;
  documentChunks?: DocumentChunk[];
  semanticIndex?: SemanticDocumentIndex | null;
  embeddingProvider?: EmbeddingProvider;

  readinessCheck?:
    () => Promise<void>;

  organizationService?:
    OrganizationService;

  chatbotService?:
    ChatbotService;
}

export function createApp(
  options: AppOptions = {},
) {
  const app = express();

  app.use(
  requestLogger,
);

  const provider =
    options.provider ??
    createModelProvider();

  // Legacy source lookup is only available for explicitly injected offline fixtures.
  // Production startup never reads generated customer-document indexes.
  const documentChunks = options.documentChunks ?? [];
  const repository = options.retrievalRepository;
  const chatService = repository ? createProductionChatService(provider,
    new ProductionRetriever({ repository,
      embeddings: options.embeddingProvider ?? new OllamaEmbeddingProvider(),
      identity: options.embeddingIdentity ?? { provider: 'ollama',
        model: process.env.OLLAMA_EMBEDDING_MODEL ?? 'qwen3-embedding:0.6b', dimensions: 1024 },
      config: options.ragConfig ?? loadRagConfig(),
      rewriter: options.queryRewriter ?? new ModelQueryRewriter(provider), logger,
    }), repository) : undefined;

  const knowledge =
    loadKnowledge();

  app.use(
    helmet(),
  );

  app.use(
    cors({
      origin:
        'http://localhost:4200',
    }),
  );

  app.use(
    express.json({
      limit: '16kb',
    }),
  );

  app.get(
    '/api/health',
    (_request, response) => {
      response.json({
        status: 'ok',

        service:
          'north-orbital-faq-assistant',

        documentChunks:
          documentChunks.length,
      });
    },
  );

  app.get(
    '/api/sources/:sourceId',
    (request, response) => {
      const source =
        knowledge.sources.find(
          (item) =>
            item.id ===
            request.params.sourceId,
        );

      if (!source) {
        response
          .status(404)
          .json({
            error: {
              code:
                'SOURCE_NOT_FOUND',

              message:
                'Source not found.',
            },
          });

        return;
      }

      response.json(source);
    },
  );

  app.get('/api/organizations/:organizationId/chatbots/:chatbotId/document-sources/:chunkId', async (request, response) => {
    const parsed = z.object({ organizationId: z.uuid(), chatbotId: z.uuid(), chunkId: z.uuid() }).safeParse(request.params);
    if (!parsed.success || !repository || !options.chatbotService) {
      response.status(404).json({ error: { code: 'DOCUMENT_SOURCE_NOT_FOUND', message: 'Document source not found.' } }); return;
    }
    try {
      const { organizationId, chatbotId, chunkId } = parsed.data;
      await options.chatbotService.getById(organizationId, chatbotId);
      const [chunk] = await repository.getByIds({ organizationId, chatbotId }, [chunkId]);
      if (!chunk) { response.status(404).json({ error: { code: 'DOCUMENT_SOURCE_NOT_FOUND', message: 'Document source not found.' } }); return; }
      response.json({ id: chunk.id, documentId: chunk.documentId, title: chunk.title,
        page: chunk.page, section: chunk.section, excerpt: chunk.text });
    } catch (error) {
      if (error instanceof ChatbotNotFoundError) {
        response.status(404).json({ error: { code: 'CHATBOT_NOT_FOUND', message: 'Chatbot not found.' } }); return;
      }
      logger.error({ requestId: request.id, failure: 'source_lookup' }, 'Source lookup failed.');
      response.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected server error occurred.' } });
    }
  });

  app.get(
    '/api/document-sources/:chunkId',
    (request, response) => {
      const chunk =
        documentChunks.find(
          (item) =>
            item.id ===
            request.params.chunkId,
        );

      if (!chunk) {
        response
          .status(404)
          .json({
            error: {
              code:
                'DOCUMENT_SOURCE_NOT_FOUND',

              message:
                'Document source not found.',
            },
          });

        return;
      }

      response.json({
        id: chunk.id,
        documentId:
          chunk.documentId,
        title:
          chunk.documentTitle,
        format:
          chunk.format,
        page:
          chunk.page ?? null,
        section:
          chunk.section ?? null,
        excerpt:
          chunk.text,
      });
    },
  );

  app.get(
  '/api/ready',
  async (
    _request,
    response,
  ) => {
    try {
      if (
        options.readinessCheck
      ) {
        await options
          .readinessCheck();
      }

      response.json({
        status: 'ready',

        service:
          'north-orbital-faq-assistant',
      });
    } catch (error) {
      logger.error(
  {
    err: error,
  },
  'Readiness check failed.',
);

      response
        .status(503)
        .json({
          status:
            'not_ready',

          service:
            'north-orbital-faq-assistant',
        });
    }
  },
);

if (
    options.organizationService &&
    options.chatbotService
  ) {
    app.use(
      '/api',
      createTenantRouter({
        organizationService:
          options.organizationService,

        chatbotService:
          options.chatbotService,
      }),
    );
  }

  if (options.documentService) {
    app.use('/api', createDocumentRouter(options.documentService, options.uploadMaxBytes ?? 20971520));
  }

  const configuredRateLimit =
    Number(
      process.env
        .CHAT_RATE_LIMIT_MAX ??
        30,
    );

  const chatRateLimit =
    Number.isInteger(
      configuredRateLimit,
    ) &&
    configuredRateLimit > 0
      ? configuredRateLimit
      : 30;

  const chatRateLimiter =
    rateLimit({
      windowMs:
        5 * 60 * 1000,

      limit:
        chatRateLimit,

      standardHeaders: true,

      legacyHeaders: false,

      message: {
        error: {
          code:
            'RATE_LIMITED',

          message:
            'Too many chat requests. Please try again shortly.',
        },
      },
    });

    app.post(
  '/api/organizations/:organizationId/chatbots/:chatbotId/chat',
  chatRateLimiter,
  async (
    request,
    response,
  ) => {
    try {
      if (!options.chatbotService) {
        throw new Error(
          'Chatbot service is not configured.',
        );
      }

      await options.chatbotService.getById(
        request.params.organizationId,
        request.params.chatbotId,
      );

      const chatRequest =
        ChatRequestSchema.parse(
          request.body,
        );

      if (!chatService) throw new Error('Production retrieval is not configured.');
      const result =
        await chatService!.chat(
          { organizationId: String(request.params.organizationId), chatbotId: String(request.params.chatbotId) },
          chatRequest, String(request.id),
        );

      response.json(result);
    } catch (error) {
      if (
        error instanceof
        ChatbotNotFoundError
      ) {
        response.status(404).json({
          error: {
            code:
              'CHATBOT_NOT_FOUND',

            message:
              'Chatbot not found.',
          },
        });

        return;
      }

      if (
        error instanceof
        ZodError
      ) {
        response.status(400).json({
          error: {
            code:
              'INVALID_REQUEST',

            message:
              'The chat request is invalid.',

            details:
              error.issues.map(
                (issue) => ({
                  path:
                    issue.path.join('.'),

                  message:
                    issue.message,
                }),
              ),
          },
        });

        return;
      }

      if (
        error instanceof
        ModelProviderError
      ) {
        if (
          error.code ===
          'timeout'
        ) {
          response.status(504).json({
            error: {
              code:
                'MODEL_TIMEOUT',

              message:
                'The AI model took too long to respond. Please try again.',
            },
          });

          return;
        }

        if (
          error.code ===
          'invalid_response'
        ) {
          response.status(502).json({
            error: {
              code:
                'MODEL_INVALID_RESPONSE',

              message:
                'The AI model returned an invalid response. Please try again.',
            },
          });

          return;
        }

        response.status(503).json({
          error: {
            code:
              'MODEL_UNAVAILABLE',

            message:
              'The AI model is unavailable. Please try again.',
          },
        });

        return;
      }

      logger.error(
        { requestId: request.id, failure: 'tenant_chat' },
        'Tenant chat request failed',
      );

      response.status(500).json({
        error: {
          code:
            'INTERNAL_ERROR',

          message:
            'An unexpected server error occurred.',
        },
      });
    }
  },
);

  return app;
}
