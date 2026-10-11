// Live M27 smoke: temporary tenant only, real session/CSRF and private S3 deletion.
import 'dotenv/config';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {smokeSession} from './smoke-session.mjs';
import {loadEnvironment} from '../dist/config.js';
import {S3ObjectStorage} from '../dist/storage/object-storage.js';
import {CommercialService} from '../dist/commercial/service.js';
import {CommercialDocuments} from '../dist/commercial/documents.js';
const root=process.env.COMMERCIAL_TEST_API_URL??'http://localhost:3001';
const config=loadEnvironment(),pool=new Pool({connectionString:config.DATABASE_URL}),storage=new S3ObjectStorage(config);
let session,org,bot,doc,secret;let stage='authentication';
const directory=await mkdtemp(path.join(tmpdir(),'commercial-smoke-'));
async function call(method,url,body,status=200){const r=await session.fetch(`${root}/api${url}`,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});assert.equal(r.status,status);return status===204?null:r.json();}
try{
  session=await smokeSession(pool,root);
  org=(await call('POST','/organizations',{name:'M27 smoke',slug:`m27-${randomUUID()}`},201)).organization.id;
  const base=`/organizations/${org}`;
  stage='subscription';assert.equal((await call('GET',`${base}/subscription`)).plan.code,'beta');
  bot=(await call('POST',`${base}/chatbots`,{name:'Smoke'},201)).chatbot.id;
  assert.equal((await call('POST',`${base}/chatbots`,{name:'Blocked'},429)).error.code,'QUOTA_EXCEEDED');
  await call('POST',`${base}/api-keys`,{name:'Blocked',scopes:['chat:write']},403);
  // Operator-only change, scoped solely to this script's newly created fixture.
  await pool.query("UPDATE organization_subscriptions SET plan_code='growth' WHERE organization_id=$1",[org]);
  stage='api-key';const created=await call('POST',`${base}/api-keys`,{name:'Temporary smoke',scopes:['chat:write']},201);secret=created.secret;
  const answer=await fetch(`${root}/api/v1${base}/chatbots/${bot}/chat`,{method:'POST',headers:{Authorization:`Bearer ${secret}`,'Content-Type':'application/json'},body:JSON.stringify({message:'Is there any information?'})});assert.equal(answer.status,200);
  const list=JSON.stringify(await call('GET',`${base}/api-keys`));assert.ok(!list.includes(secret));assert.ok(!list.includes('secret_hash'));
  stage='upload-delete';const form=new FormData();form.append('file',new Blob([await readFile(new URL('../../documents/samples/north-orbital-digital-access-guide.pdf',import.meta.url))]),'smoke.pdf');
  const uploaded=await session.fetch(`${root}/api${base}/chatbots/${bot}/documents`,{method:'POST',body:form});assert.equal(uploaded.status,202);doc=(await uploaded.json()).document.id;
  await call('DELETE',`${base}/chatbots/${bot}/documents/${doc}`,undefined,202);
  const deadline=Date.now()+60000;
  while((await pool.query('SELECT id FROM object_cleanup_jobs WHERE organization_id=$1',[org])).rowCount){assert.ok(Date.now()<deadline);await new Promise(r=>setTimeout(r,500));}
  let missing=false;try{await storage.get({organizationId:org,chatbotId:bot,documentId:doc,format:'pdf'},path.join(directory,'object'));}catch(e){missing=e.name==='NoSuchKey'||e.$metadata?.httpStatusCode===404;}assert.ok(missing);
  stage='export';const exported=JSON.stringify(await call('GET',`${base}/privacy/export`));for(const forbidden of ['secret_hash','password_hash','csrf_hash','token_hash',secret])assert.ok(!exported.includes(forbidden));
  const usage=await call('GET',`${base}/usage`);assert.equal(usage.usage.internalChatMessages.used,1);assert.equal(usage.usage.documents.used,0);assert.equal(usage.usage.storageBytes.used,0);
  await call('DELETE',`${base}/api-keys/${created.apiKey.id}`,undefined,204);
  const revoked=await fetch(`${root}/api/v1${base}/chatbots/${bot}/chat`,{method:'POST',headers:{Authorization:`Bearer ${secret}`,'Content-Type':'application/json'},body:JSON.stringify({message:'test'})});assert.equal(revoked.status,401);
  console.log('M27 live smoke passed: plans, quotas, bearer chat, hash-only listing/export, revocation, durable private-object deletion.');
}catch{console.error(`M27 live smoke failed at ${stage}.`);process.exitCode=1;}
finally{
  if(org){
    // Preserve durable cleanup even if the smoke fails midway; only this fixture is removed.
    if(doc)await new CommercialDocuments(new CommercialService(pool)).delete({organizationId:org,chatbotId:bot,documentId:doc},{action:'document.deleted',targetType:'document'});
    await pool.query('DELETE FROM organizations WHERE id=$1',[org]);
  }
  await session?.close();storage.close();await pool.end();await rm(directory,{recursive:true,force:true});
}
