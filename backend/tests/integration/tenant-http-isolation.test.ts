import { PostgresRetrievalRepository } from '../../src/rag/repository.js';
import 'dotenv/config';

import {
  randomUUID,
} from 'node:crypto';

import {
  Pool,
  type PoolClient,
} from 'pg';

import request from 'supertest';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  createApp,
} from '../authenticated-app.js';

import {
  ChatbotRepository,
} from '../../src/chatbots/chatbot-repository.js';

import {
  ChatbotService,
} from '../../src/chatbots/chatbot-service.js';

import {
  OrganizationRepository,
} from '../../src/organizations/organization-repository.js';

import {
  OrganizationService,
} from '../../src/organizations/organization-service.js';

const databaseUrl =
  process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL is required.',
  );
}

const pool =
  new Pool({
    connectionString:
      databaseUrl,
  });

let client: PoolClient;

describe(
  'tenant HTTP isolation',
  () => {
    beforeAll(
      async () => {
        client =
          await pool.connect();

        await client.query(
          'BEGIN',
        );
      },
    );

    afterAll(
      async () => {
        await client.query(
          'ROLLBACK',
        );

        client.release();

        await pool.end();
      },
    );

    it(
      'allows the owning organization and rejects another organization',
      async () => {
        const database = {
          query:
            client.query.bind(
              client,
            ),
        } as Pool;

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

        const suffix =
          randomUUID();

        const organizationA =
          await organizationRepository.create({
            name:
              'Tenant HTTP A',

            slug:
              `tenant-http-a-${suffix}`,
          });

        const organizationB =
          await organizationRepository.create({
            name:
              'Tenant HTTP B',

            slug:
              `tenant-http-b-${suffix}`,
          });

        const chatbot =
          await chatbotRepository.create({
            organizationId:
              organizationA.id,

            name:
              'Tenant A Bot',
          });

        const provider = {
          generateAnswer:
            vi.fn(
              async () => {
                throw new Error(
                  'Model should not be called for this test.',
                );
              },
            ),
        };

        const app =
          createApp({
            retrievalRepository: new PostgresRetrievalRepository(database),
            embeddingProvider: { embed: async () => [] },
            provider:
              provider as never,

            organizationService,
            chatbotService,

            documentChunks: [],
            semanticIndex: null,
          });

        const ownerResponse =
          await request(app)
            .post(
              `/api/organizations/${organizationA.id}/chatbots/${chatbot.id}/chat`,
            )
            .send({
              message:
                'Do you repair bicycles?',

              history: [],
            });

        expect(
          ownerResponse.status,
        ).toBe(200);

        expect(
          ownerResponse.body.fallback,
        ).toBe(true);

        expect(
          provider.generateAnswer,
        ).not.toHaveBeenCalled();

        const crossTenantResponse =
          await request(app)
            .post(
              `/api/organizations/${organizationB.id}/chatbots/${chatbot.id}/chat`,
            )
            .send({
              message:
                'Do you repair bicycles?',

              history: [],
            });

        expect(
          crossTenantResponse.status,
        ).toBe(404);

        expect(
          crossTenantResponse.body.error.code,
        ).toBe(
          'CHATBOT_NOT_FOUND',
        );

        expect(
          provider.generateAnswer,
        ).not.toHaveBeenCalled();
      },
    );
  },
);