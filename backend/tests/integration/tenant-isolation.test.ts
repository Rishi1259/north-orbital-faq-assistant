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

const databaseUrl =
  process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL is required for database integration tests.',
  );
}

const pool = new Pool({
  connectionString:
    databaseUrl,
});

let client: PoolClient;

describe(
  'database tenant ownership isolation',
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
      'rejects cross-organization document, chunk, and embedding ownership',
      async () => {
        const suffix =
          randomUUID();

        const organizationA =
          await client.query<{
            id: string;
          }>(
            `
              INSERT INTO organizations (
                name,
                slug
              )
              VALUES ($1, $2)
              RETURNING id
            `,
            [
              'Organization A',
              `organization-a-${suffix}`,
            ],
          );

        const organizationB =
          await client.query<{
            id: string;
          }>(
            `
              INSERT INTO organizations (
                name,
                slug
              )
              VALUES ($1, $2)
              RETURNING id
            `,
            [
              'Organization B',
              `organization-b-${suffix}`,
            ],
          );

        const organizationAId =
          organizationA.rows[0].id;

        const organizationBId =
          organizationB.rows[0].id;

        const chatbotA =
          await client.query<{
            id: string;
          }>(
            `
              INSERT INTO chatbots (
                organization_id,
                name
              )
              VALUES ($1, $2)
              RETURNING id
            `,
            [
              organizationAId,
              'Chatbot A',
            ],
          );

        const chatbotB =
          await client.query<{
            id: string;
          }>(
            `
              INSERT INTO chatbots (
                organization_id,
                name
              )
              VALUES ($1, $2)
              RETURNING id
            `,
            [
              organizationBId,
              'Chatbot B',
            ],
          );

        const chatbotAId =
          chatbotA.rows[0].id;

        const chatbotBId =
          chatbotB.rows[0].id;

        const document =
          await client.query<{
            id: string;
          }>(
            `
              INSERT INTO documents (
                organization_id,
                chatbot_id,
                title,
                original_filename,
                mime_type,
                status
              )
              VALUES (
                $1,
                $2,
                $3,
                $4,
                $5,
                'ready'
              )
              RETURNING id
            `,
            [
              organizationAId,
              chatbotAId,
              'Tenant A Document',
              'tenant-a.pdf',
              'application/pdf',
            ],
          );

        const documentId =
          document.rows[0].id;

        await client.query(
          'SAVEPOINT invalid_document',
        );

        await expect(
          client.query(
            `
              INSERT INTO documents (
                organization_id,
                chatbot_id,
                title,
                original_filename,
                mime_type
              )
              VALUES (
                $1,
                $2,
                $3,
                $4,
                $5
              )
            `,
            [
              organizationAId,
              chatbotBId,
              'Invalid Document',
              'invalid.pdf',
              'application/pdf',
            ],
          ),
        ).rejects.toMatchObject({
          code: '23503',
        });

        await client.query(
          'ROLLBACK TO SAVEPOINT invalid_document',
        );

        const chunk =
          await client.query<{
            id: string;
          }>(
            `
              INSERT INTO document_chunks (
                organization_id,
                chatbot_id,
                document_id,
                chunk_index,
                block_id,
                content,
                page_number
              )
              VALUES (
                $1,
                $2,
                $3,
                0,
                $4,
                $5,
                1
              )
              RETURNING id
            `,
            [
              organizationAId,
              chatbotAId,
              documentId,
              'BLOCK-001',
              'Example tenant A content.',
            ],
          );

        const chunkId =
          chunk.rows[0].id;

        await client.query(
          'SAVEPOINT invalid_chunk',
        );

        await expect(
          client.query(
            `
              INSERT INTO document_chunks (
                organization_id,
                chatbot_id,
                document_id,
                chunk_index,
                content
              )
              VALUES (
                $1,
                $2,
                $3,
                1,
                $4
              )
            `,
            [
              organizationBId,
              chatbotBId,
              documentId,
              'Cross-tenant chunk.',
            ],
          ),
        ).rejects.toMatchObject({
          code: '23503',
        });

        await client.query(
          'ROLLBACK TO SAVEPOINT invalid_chunk',
        );

        const vector =
          [
            1,
            ...Array(1023).fill(
              0,
            ),
          ];

        const vectorValue =
          `[${vector.join(',')}]`;

        await client.query(
          `
            INSERT INTO document_embeddings (
              organization_id,
              chatbot_id,
              document_id,
              chunk_id,
              provider,
              model,
              dimensions,
              embedding
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              'test',
              'test-embedding-model',
              1024,
              $5::vector
            )
          `,
          [
            organizationAId,
            chatbotAId,
            documentId,
            chunkId,
            vectorValue,
          ],
        );

        await client.query(
          'SAVEPOINT invalid_embedding',
        );

        await expect(
          client.query(
            `
              INSERT INTO document_embeddings (
                organization_id,
                chatbot_id,
                document_id,
                chunk_id,
                provider,
                model,
                dimensions,
                embedding
              )
              VALUES (
                $1,
                $2,
                $3,
                $4,
                'test',
                'invalid-cross-tenant-model',
                1024,
                $5::vector
              )
            `,
            [
              organizationBId,
              chatbotBId,
              documentId,
              chunkId,
              vectorValue,
            ],
          ),
        ).rejects.toMatchObject({
          code: '23503',
        });

        await client.query(
          'ROLLBACK TO SAVEPOINT invalid_embedding',
        );
      },
    );
  },
);