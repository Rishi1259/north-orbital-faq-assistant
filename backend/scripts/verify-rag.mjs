// Opt-in model-dependent smoke check. Never prints queries, answers, evidence or credentials.
// Existing accepted tenant documents are read-only; only this run's empty tenant is removed.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgresRetrievalRepository } from '../dist/rag/repository.js';
const root = process.env.RAG_TEST_API_URL ?? 'http://backend:3000';
const scope = {
  organizationId: process.env.RAG_TEST_ORGANIZATION_ID ?? 'f94827a2-4ec3-4bd0-92cc-49accd1cdf9b',
  chatbotId: process.env.RAG_TEST_CHATBOT_ID ?? 'f732a2ca-55b2-47fa-aefa-1fb497e56262',
};
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const repository = new PostgresRetrievalRepository(pool);
const base = s => `/api/organizations/${s.organizationId}/chatbots/${s.chatbotId}`;
let temporaryOrganization;
let currentCase = 'health';
async function chat(s, message, history = []) {
  const response = await fetch(`${root}${base(s)}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, history }), signal: AbortSignal.timeout(110000) });
  assert.equal(response.status, 200);
  return { body: await response.json(), requestId: response.headers.get('x-request-id') };
}
async function grounded(result, mime) {
  const { body } = result;
  assert.equal(body.fallback, false); assert.ok(body.sources.length > 0);
  assert.equal(new Set(body.sources.map(s => s.id)).size, body.sources.length);
  const rows = await repository.getByIds(scope, body.sources.map(s => s.id));
  assert.equal(rows.length, body.sources.length);
  for (const source of body.sources) {
    const row = rows.find(r => r.id === source.id); assert.ok(row);
    assert.equal(source.title, row.title);
    assert.ok(source.path.startsWith(`${base(scope).replace('/api', '')}/document-sources/`));
    const linked = await fetch(`${root}/api${source.path}`); assert.equal(linked.status, 200);
    assert.equal((await linked.json()).documentId, row.documentId);
  }
  if (mime) {
    const formats = await pool.query('SELECT mime_type FROM documents WHERE organization_id=$1 AND chatbot_id=$2 AND id=ANY($3::uuid[])',
      [scope.organizationId, scope.chatbotId, rows.map(r => r.documentId)]);
    assert.ok(formats.rows.some(r => r.mime_type === mime));
  }
  console.log(JSON.stringify({ case: currentCase, passed: true, sourceCount: body.sources.length, requestId: result.requestId }));
}
try {
  for (const endpoint of ['health', 'ready']) {
    let healthy = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { healthy = (await fetch(`${root}/api/${endpoint}`, { signal: AbortSignal.timeout(2000) })).status === 200; } catch {}
      if (healthy) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.ok(healthy);
  }
  console.log(JSON.stringify({ case: currentCase, passed: true }));
  currentCase = 'ready_pdf';
  const direct = await chat(scope, 'How long may registered participants reserve a digital lab workstation per day?');
  assert.match(direct.body.answer, /90|ninety/i); await grounded(direct, 'application/pdf');
  currentCase = 'ready_docx';
  const docx = await chat(scope, 'How long is the orientation for new volunteers?');
  assert.match(docx.body.answer, /60|sixty/i);
  await grounded(docx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  currentCase = 'semantic_paraphrase';
  const semantic = await chat(scope, 'For how much time can someone book one of the shared computers each day?');
  assert.match(semantic.body.answer, /90|ninety/i); await grounded(semantic);
  currentCase = 'unrelated';
  const unrelated = await chat(scope, 'What is the surface temperature of the star Betelgeuse?');
  assert.equal(unrelated.body.fallback, true); assert.deepEqual(unrelated.body.sources, []);
  console.log(JSON.stringify({ case: currentCase, passed: true, requestId: unrelated.requestId }));
  currentCase = 'absent_answer';
  const absent = await chat(scope, 'What is the exact serial number of the first workstation?');
  assert.equal(absent.body.fallback, true); assert.deepEqual(absent.body.sources, []);
  console.log(JSON.stringify({ case: currentCase, passed: true, requestId: absent.requestId }));
  currentCase = 'follow_up';
  const initial = await chat(scope, 'What can registered participants reserve in the digital lab?');
  assert.equal(initial.body.fallback, false);
  const follow = await chat(scope, 'How long can I use it each day?', [
    { role: 'user', content: 'What can registered participants reserve in the digital lab?' },
    { role: 'assistant', content: initial.body.answer.slice(0, 1000) },
  ]);
  assert.match(follow.body.answer, /90|ninety/i); await grounded(follow);
  currentCase = 'tenant_isolation';
  const organization = await fetch(`${root}/api/organizations`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'RAG empty smoke tenant', slug: `rag-smoke-${randomUUID()}` }) });
  assert.equal(organization.status, 201); temporaryOrganization = (await organization.json()).organization.id;
  const bot = await fetch(`${root}/api/organizations/${temporaryOrganization}/chatbots`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'RAG empty smoke bot' }) });
  assert.equal(bot.status, 201);
  const other = { organizationId: temporaryOrganization, chatbotId: (await bot.json()).chatbot.id };
  const isolated = await chat(other, 'How long is the orientation for new volunteers?');
  assert.equal(isolated.body.fallback, true); assert.deepEqual(isolated.body.sources, []);
  const wrong = await fetch(`${root}${base({ ...scope, organizationId: temporaryOrganization })}/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Orientation?' }) });
  assert.equal(wrong.status, 404);
  for (const source of direct.body.sources) {
    assert.equal((await fetch(`${root}${base(other)}/document-sources/${source.id}`)).status, 404);
  }
  console.log(JSON.stringify({ case: currentCase, passed: true, requestId: isolated.requestId }));
} catch {
  console.error(JSON.stringify({ case: currentCase, passed: false })); process.exitCode = 1;
} finally {
  if (temporaryOrganization) await pool.query('DELETE FROM organizations WHERE id=$1', [temporaryOrganization]);
  await pool.end();
}
