import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { runner } from 'node-pg-migrate';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import { PostgresRetrievalRepository } from '../../src/rag/repository.js';
import { ProductionRetriever } from '../../src/rag/retriever.js';
import { createApp } from '../../src/app.js';
import { ChatbotService } from '../../src/chatbots/chatbot-service.js';
import { ChatbotRepository } from '../../src/chatbots/chatbot-repository.js';
import { OrganizationRepository } from '../../src/organizations/organization-repository.js';
import { config, identity, vector } from '../rag-fixtures.js';
import type { TenantScope } from '../../src/rag/types.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for database integration tests.');
const schema = `rag_test_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema},public` });
let client: PoolClient;
let repository: PostgresRetrievalRepository;
let scope: TenantScope;
let other: TenantScope;
let wrongBot: TenantScope;
let ready: string;
let document: string;
const logger = pino({ level: 'silent' });

async function tenant(organizationId?: string): Promise<TenantScope> {
  const org = organizationId ?? (await client.query("INSERT INTO organizations(name,slug) VALUES('RAG fixture',$1) RETURNING id", [randomUUID()])).rows[0].id;
  const bot = (await client.query("INSERT INTO chatbots(organization_id,name) VALUES($1,'RAG fixture') RETURNING id", [org])).rows[0].id;
  return { organizationId: org, chatbotId: bot };
}
async function add(s: TenantScope, status: string, content: string, axis: number | null = 0, model = identity.model) {
  const doc = (await client.query(`INSERT INTO documents(organization_id,chatbot_id,title,original_filename,mime_type,status,storage_key)
    VALUES($1,$2,'Fixture PDF','fixture.pdf','application/pdf',$3,'NEVER-EXPOSE-THIS') RETURNING id`, [s.organizationId, s.chatbotId, status])).rows[0].id;
  const id = (await client.query(`INSERT INTO document_chunks(organization_id,chatbot_id,document_id,chunk_index,content,page_number)
    VALUES($1,$2,$3,0,$4,2) RETURNING id`, [s.organizationId, s.chatbotId, doc, content])).rows[0].id;
  if (axis !== null) await client.query(`INSERT INTO document_embeddings(organization_id,chatbot_id,document_id,chunk_id,provider,model,dimensions,embedding)
    VALUES($1,$2,$3,$4,$5,$6,1024,$7::vector)`, [s.organizationId, s.chatbotId, doc, id, identity.provider, model, JSON.stringify(vector(axis))]);
  return { id, doc };
}
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await runner({ databaseUrl: process.env.DATABASE_URL!, dir: fileURLToPath(new URL('../../migrations', import.meta.url)),
    direction: 'up', migrationsTable: 'pgmigrations', migrationsSchema: schema, schema: [schema, 'public'],
    logger: { info() {}, warn() {}, error() {}, debug() {} } });
  client = await pool.connect(); repository = new PostgresRetrievalRepository(client);
}, 30000);
afterAll(async () => {
  client?.release(); await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();
});
beforeEach(async () => {
  await client.query('BEGIN');
  scope = await tenant(); other = await tenant(); wrongBot = await tenant(scope.organizationId);
  const row = await add(scope, 'ready', 'Princess Donut the Queen Anne Chonk is the cat companion. Equipment may not be taken home.');
  ready = row.id; document = row.doc;
  for (const status of ['pending', 'processing', 'failed']) await add(scope, status, 'Princess Donut forbidden lifecycle evidence');
  await add(other, 'ready', 'Other tenant secret uniquequasar');
  await add(wrongBot, 'ready', 'Other chatbot secret uniquequasar');
});
afterEach(async () => { await client.query('ROLLBACK'); });

describe('PostgreSQL production retrieval', () => {
  it('retrieves exact lexical facts and ranks ties deterministically', async () => {
    const duplicate = await add(scope, 'ready', 'Princess Donut the Queen Anne Chonk is the cat companion. Equipment may not be taken home.');
    const first = await repository.lexical(scope, 'Princess Donut', 30);
    expect(new Set(first.map(c => c.id))).toEqual(new Set([ready, duplicate.id]));
    expect(first.map(c => c.lexicalRank)).toEqual([1, 2]);
    expect(await repository.lexical(scope, 'Princess Donut', 30)).toEqual(first);
    expect(first.map(c => c.documentId)).toEqual(first.map(c => c.documentId).sort());
    expect(await repository.lexical(scope, 'Who is the cat companion?', 30)).toHaveLength(2);
  });
  it.each(['', '!!!', 'the and is', '"; DROP TABLE documents; -- unrelatedquasar'])('handles empty/punctuation/stop-word-like input safely: %s', async query => {
    expect(await repository.lexical(scope, query, 30)).toEqual([]);
  });
  it('enforces both scope values and ready-only at the repository layer for all read methods', async () => {
    expect((await repository.lexical(scope, 'Princess Donut', 30)).map(c => c.id)).toEqual([ready]);
    for (const s of [other, wrongBot, { ...other, chatbotId: scope.chatbotId }]) {
      expect(await repository.lexical(s, 'Princess Donut', 30)).toEqual([]);
      expect((await repository.semantic(s, vector(), identity, 30)).map(c => c.id)).not.toContain(ready);
      expect(await repository.getByIds(s, [ready])).toEqual([]);
    }
    expect((await repository.semantic(scope, vector(), identity, 30)).map(c => c.id)).toEqual([ready]);
    expect((await repository.getByIds(scope, [ready]))[0]).toMatchObject({ id: ready, page: 2, title: 'Fixture PDF', ...scope });
    expect(JSON.stringify(await repository.getByIds(scope, [ready]))).not.toContain('NEVER-EXPOSE');
  });
  it('orders nearest neighbors in PostgreSQL and excludes wrong-model/no-vector chunks', async () => {
    const farther = await add(scope, 'ready', 'Distant subject', 1);
    const noVector = await add(scope, 'ready', 'No vector subject', null);
    const wrongModel = await add(scope, 'ready', 'Wrong model subject', 0, 'different-model');
    const results = await repository.semantic(scope, vector(), identity, 30);
    expect(results.map(c => c.id)).toEqual([ready, farther.id]);
    expect(results[0].semanticDistance).toBeCloseTo(0);
    expect(results[1].semanticDistance).toBeCloseTo(1);
    expect(results.map(c => c.id)).not.toContain(noVector.id);
    expect(results.map(c => c.id)).not.toContain(wrongModel.id);
    expect(await repository.semantic(scope, vector(), { ...identity, provider: 'different-provider' }, 30)).toEqual([]);
    expect(await repository.semantic(scope, vector(), identity, 1)).toHaveLength(1);
  });
  it('reflects status transitions and cascaded chunk/document deletion', async () => {
    for (const status of ['pending', 'processing', 'failed', 'ready']) {
      await client.query('UPDATE documents SET status=$1 WHERE id=$2', [status, document]);
      for (const rows of [await repository.lexical(scope, 'Princess Donut', 30),
        await repository.semantic(scope, vector(), identity, 30), await repository.getByIds(scope, [ready])]) {
        expect(rows.map(c => c.id).includes(ready)).toBe(status === 'ready');
      }
    }
    await client.query('DELETE FROM document_chunks WHERE id=$1', [ready]);
    expect(await repository.lexical(scope, 'Princess Donut', 30)).toEqual([]);
    expect(await repository.semantic(scope, vector(), identity, 30)).toEqual([]);
    const row = await add(scope, 'ready', 'Disposable fixture');
    await client.query('DELETE FROM documents WHERE id=$1', [row.doc]);
    expect(await repository.getByIds(scope, [row.id])).toEqual([]);
    expect((await client.query('SELECT count(*)::int AS count FROM document_embeddings WHERE document_id=$1', [row.doc])).rows[0].count).toBe(0);
  });
  it('combines real lexical/vector searches and includes semantic-only paraphrase evidence', async () => {
    const special = await add(scope, 'ready', 'Astronauts require orbital navigation certification.', 2);
    const retriever = new ProductionRetriever({ repository, embeddings: { embed: async () => [vector(2)] },
      identity, config, rewriter: { rewrite: async () => null }, logger });
    expect(await repository.lexical(scope, 'spaceflight credentials', 30)).toEqual([]);
    const evidence = await retriever.retrieve(scope, 'spaceflight credentials', []);
    expect(evidence[0].chunk.id).toBe(special.id);
    expect(evidence.every(e => e.chunk.organizationId === scope.organizationId && e.chunk.chatbotId === scope.chatbotId)).toBe(true);
  });
  it('has GIN, tenant, and cosine HNSW indexes', async () => {
    const indexes = (await client.query('SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=$1', [schema])).rows;
    expect(indexes.some(i => i.indexdef.includes('USING gin (search_vector)'))).toBe(true);
    expect(indexes.some(i => i.indexdef.includes('vector_cosine_ops'))).toBe(true);
    expect(indexes.some(i => i.indexname === 'document_chunks_scope')).toBe(true);
  });
});

function app(options: Partial<Parameters<typeof createApp>[0]> = {}) {
  const database = { query: client.query.bind(client) } as Pool;
  return createApp({ retrievalRepository: repository,
    chatbotService: new ChatbotService(new OrganizationRepository(database), new ChatbotRepository(database)),
    embeddingProvider: { embed: async () => { throw new Error('Offline embedding provider'); } },
    provider: { generateAnswer: async () => ({ canAnswer: true, answer: 'Princess Donut the Queen Anne Chonk.', sourceIds: ['S1'] }) },
    ...options });
}
const base = (s: TenantScope) => `/api/organizations/${s.organizationId}/chatbots/${s.chatbotId}`;

describe('tenant HTTP chat using the real PostgreSQL repository', () => {
  it('answers from ingested-schema chunks with validated scoped citation links and lexical fallback', async () => {
    const server = app();
    const response = await request(server).post(`${base(scope)}/chat`).send({ message: 'Who is the cat companion?' }).expect(200);
    expect(response.body.fallback).toBe(false);
    expect(response.body.sources).toEqual([expect.objectContaining({ id: ready, title: 'Fixture PDF', location: 'Page 2' })]);
    const source = await request(server).get(`/api${response.body.sources[0].path}`).expect(200);
    expect(source.body.documentId).toBe(document); expect(source.text).not.toContain('NEVER-EXPOSE');
    await request(server).get(`${base(other)}/document-sources/${ready}`).expect(404);
    await request(server).get(`${base(wrongBot)}/document-sources/${ready}`).expect(404);
    await request(server).get(`/api/document-sources/${ready}`).expect(404);
  });
  it('returns fallback for another tenant, wrong chatbot and no evidence; preserves chatbot 404', async () => {
    const server = app();
    for (const s of [other, wrongBot]) {
      const response = await request(server).post(`${base(s)}/chat`).send({ message: 'Princess Donut' }).expect(200);
      expect(response.body).toMatchObject({ fallback: true, sources: [] }); expect(response.text).not.toContain(ready);
    }
    await request(server).post(`${base({ ...other, chatbotId: scope.chatbotId })}/chat`).send({ message: 'Princess Donut' }).expect(404);
    const response = await request(server).post(`${base(scope)}/chat`).send({ message: 'Unrelatedquasar' }).expect(200);
    expect(response.body).toMatchObject({ fallback: true, sources: [] });
  });
  it('answers follow-ups only after rewriting and never expands tenant scope', async () => {
    const queryRewriter = { rewrite: vi.fn(async () => 'Princess Donut full name') };
    const server = app({ queryRewriter });
    expect(await repository.lexical(scope, 'What is her full name?', 30)).toEqual([]);
    const history = [{ role: 'user', content: 'Who is the cat companion?' }, { role: 'assistant', content: 'Princess Donut.' }];
    const response = await request(server).post(`${base(scope)}/chat`).send({ message: 'What is her full name?', history }).expect(200);
    expect(response.body.sources[0].id).toBe(ready);
    const foreign = await request(server).post(`${base(other)}/chat`).send({ message: 'What is her full name?', history }).expect(200);
    expect(foreign.body).toMatchObject({ fallback: true, sources: [] });
  });
  it('rejects hallucinated citations and handles negative facts without discarding supporting evidence', async () => {
    const fabricated = app({ provider: { generateAnswer: async () => ({ canAnswer: true, answer: 'Invented', sourceIds: ['S99'] }) } });
    const rejected = await request(fabricated).post(`${base(scope)}/chat`).send({ message: 'Princess Donut' }).expect(200);
    expect(rejected.body).toMatchObject({ fallback: true, sources: [] });
    const negative = app({ provider: { generateAnswer: async () => ({ canAnswer: true, answer: 'No, equipment may not be taken home.', sourceIds: ['S1', 'S1'] }) } });
    const response = await request(negative).post(`${base(scope)}/chat`).send({ message: 'Can equipment be taken home?' }).expect(200);
    expect(response.body.fallback).toBe(false); expect(response.body.sources).toHaveLength(1);
  });
  it('does not cite a chunk omitted from final context or made non-ready during generation', async () => {
    const server = app({ ragConfig: { ...config, RAG_TOP_K: 1 }, provider: { generateAnswer: async () => {
      await client.query("UPDATE documents SET status='failed' WHERE id=$1", [document]);
      return { canAnswer: true, answer: 'Old answer', sourceIds: ['S1', 'S2'] };
    } } });
    const response = await request(server).post(`${base(scope)}/chat`).send({ message: 'Princess Donut' }).expect(200);
    expect(response.body).toMatchObject({ fallback: true, sources: [] });
    await request(server).get(`${base(scope)}/document-sources/${ready}`).expect(404);
  });
});
