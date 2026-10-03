import { PostgresRetrievalRepository } from './rag/repository.js';
import { OllamaEmbeddingProvider } from './embeddings/ollama-embedding-provider.js';
import { DocumentService } from './ingestion/document-service.js';
import { IngestionRepository } from './ingestion/repository.js';
import { S3ObjectStorage } from './storage/object-storage.js';
import 'dotenv/config';

import {
  createApp,
} from './app.js';

import {
  loadEnvironment,
} from './config.js';

import {
  checkDatabase,
  closeDatabase,
  createDatabasePool,
} from './database/database.js';

import {
  logger,
} from './logging/logger.js';

import {
  ChatbotRepository,
} from './chatbots/chatbot-repository.js';

import {
  ChatbotService,
} from './chatbots/chatbot-service.js';

import {
  OrganizationRepository,
} from './organizations/organization-repository.js';

import {
  OrganizationService,
} from './organizations/organization-service.js';

const environment =
  loadEnvironment();

const database =
  createDatabasePool({
    connectionString:
      environment.DATABASE_URL,

    max:
      environment
        .DATABASE_POOL_MAX,

    connectionTimeoutMillis:
      environment
        .DATABASE_CONNECTION_TIMEOUT_MS,
  });

  const organizationRepository =
  new OrganizationRepository(
    database,
  );

const chatbotRepository =
  new ChatbotRepository(
    database,
  );

const organizationService =
  new OrganizationService(
    organizationRepository,
  );

const chatbotService =
  new ChatbotService(
    organizationRepository,
    chatbotRepository,
  );
const storage = new S3ObjectStorage(environment);
const documentService = new DocumentService(chatbotService, new IngestionRepository(database),
  storage, environment.UPLOAD_MAX_BYTES, environment.INGESTION_MAX_ATTEMPTS);
const app =
  createApp({
    retrievalRepository: new PostgresRetrievalRepository(database),
    ragConfig: environment,
    embeddingProvider: new OllamaEmbeddingProvider({ baseUrl: environment.OLLAMA_BASE_URL,
      model: environment.OLLAMA_EMBEDDING_MODEL, timeoutMs: environment.EMBEDDING_TIMEOUT_MS }),
    embeddingIdentity: { provider: 'ollama', model: environment.OLLAMA_EMBEDDING_MODEL, dimensions: 1024 },
    readinessCheck:
      async () => {
        await checkDatabase(
          database,
        );
      },

    organizationService,
    chatbotService,
    documentService,
    uploadMaxBytes: environment.UPLOAD_MAX_BYTES,
  });

const server =
  app.listen(
    environment.PORT,
    () => {
      logger.info(
  {
    port:
      environment.PORT,
  },
  'FAQ assistant API started.',
);
    },
  );

let shuttingDown = false;

async function shutdown(
  signal: string,
) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  logger.info(
  {
    signal,
  },
  'Shutdown signal received.',
);

  server.close(
    async (error) => {
      if (error) {
        logger.error(
  {
    err: error,
  },
  'HTTP server shutdown failed.',
);
      }

      try {
        storage.close();
        await closeDatabase(
          database,
        );
      } catch (databaseError) {
        logger.error(
  {
    err: error,
  },
  'HTTP server shutdown failed.',
);
      }

      process.exit(
        error ? 1 : 0,
      );
    },
  );
}

process.once(
  'SIGTERM',
  () => {
    void shutdown(
      'SIGTERM',
    );
  },
);

process.once(
  'SIGINT',
  () => {
    void shutdown(
      'SIGINT',
    );
  },
);