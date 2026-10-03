import 'dotenv/config';

import {
  randomUUID,
} from 'node:crypto';

import {
  Pool,
  type PoolClient,
} from 'pg';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';

import {
  ChatbotRepository,
} from '../../src/chatbots/chatbot-repository.js';

import {
  OrganizationRepository,
} from '../../src/organizations/organization-repository.js';

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
  'organization and chatbot repositories',
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
      'creates and retrieves tenant-scoped chatbots',
      async () => {
        const database = {
          query:
            client.query.bind(
              client,
            ),
        } as Pool;

        const organizations =
          new OrganizationRepository(
            database,
          );

        const chatbots =
          new ChatbotRepository(
            database,
          );

        const suffix =
          randomUUID();

        const organizationA =
          await organizations.create({
            name:
              'Organization A',

            slug:
              `organization-a-${suffix}`,
          });

        const organizationB =
          await organizations.create({
            name:
              'Organization B',

            slug:
              `organization-b-${suffix}`,
          });

        const chatbot =
          await chatbots.create({
            organizationId:
              organizationA.id,

            name:
              'Support Bot',
          });

        const found =
          await chatbots.findById(
            organizationA.id,
            chatbot.id,
          );

        expect(
          found?.id,
        ).toBe(
          chatbot.id,
        );

        const crossTenant =
          await chatbots.findById(
            organizationB.id,
            chatbot.id,
          );

        expect(
          crossTenant,
        ).toBeNull();

        const listA =
          await chatbots
            .listByOrganization(
              organizationA.id,
            );

        expect(
          listA,
        ).toHaveLength(1);

        const listB =
          await chatbots
            .listByOrganization(
              organizationB.id,
            );

        expect(
          listB,
        ).toHaveLength(0);
      },
    );
  },
);