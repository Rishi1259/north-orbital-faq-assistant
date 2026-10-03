// Opt-in live smoke. Enables only the explicitly supplied chatbot. No content or credentials are printed.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { parse } from 'dotenv';
const { values } = parseArgs({ options: { organization: {type:'string'}, chatbot: {type:'string'} } });
assert.match(values.organization ?? '', /^[0-9a-f-]{36}$/); assert.match(values.chatbot ?? '', /^[0-9a-f-]{36}$/);
const base = process.env.PUBLIC_TEST_API_URL ?? 'http://localhost:3001';
const origin = 'http://localhost:4200';
const privateFile = new URL('../../.env.smoke.local',import.meta.url);
try { await writeFile(privateFile, `SMOKE_EMAIL=local-owner-${randomBytes(6).toString('hex')}@example.test\nSMOKE_PASSWORD=${randomBytes(32).toString('base64url')}\n`, { flag:'wx',mode:0o600 }); }
catch(error) { if(error.code !== 'EEXIST') throw error; }
const credentials = parse(await readFile(privateFile));
const local = parse(await readFile(new URL('../../.env.security.local',import.meta.url)));
let cookie, csrf;
async function api(path, {method='GET', body, admin=false, requestOrigin=origin, expected=200} = {}) {
  const response = await fetch(`${base}${path}`, { method, headers: {
    ...(requestOrigin ? { Origin:requestOrigin } : {}), ...(body ? {'Content-Type':'application/json'} : {}),
    ...(admin ? {Cookie:cookie,'X-CSRF-Token':csrf} : {}),
  }, body:body ? JSON.stringify(body) : undefined, signal:AbortSignal.timeout(120000) });
  assert.equal(response.status,expected,`Unexpected status for ${method} ${path}`);
  return { response, body:response.status===204 ? null : await response.json() };
}
try {
  const child = spawn(process.execPath,['dist/security/create-owner.js','--email',credentials.SMOKE_EMAIL,'--organization',values.organization], {stdio:['pipe','pipe','pipe']});
  child.stdout.resume(); child.stderr.resume(); child.stdin.end(credentials.SMOKE_PASSWORD);
  await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error('Bootstrap failed')));});
  const login = await api('/api/auth/login',{method:'POST',body:{email:credentials.SMOKE_EMAIL,password:credentials.SMOKE_PASSWORD}});
  cookie = login.response.headers.get('set-cookie').split(';')[0]; csrf = login.body.csrfToken;
  const internal = `/api/organizations/${values.organization}/chatbots/${values.chatbot}`;
  const oldOrigins = await api(`${internal}/allowed-origins`,{admin:true});
  await api(`${internal}/allowed-origins`,{method:'PUT',admin:true,body:{origins:[...new Set([...oldOrigins.body.origins,origin])]}});
  const enabled = await api(`${internal}/public-access`,{method:'PUT',admin:true,body:{enabled:true}});
  const publicId = enabled.body.publicId, publicBase = `/api/public/chatbots/${publicId}`;
  const config = await api(`${publicBase}/config`);
  assert.equal(config.response.headers.get('access-control-allow-origin'),origin);
  for (const id of [values.organization,values.chatbot]) assert.ok(!JSON.stringify(config.body).includes(id));
  await api(`${publicBase}/config`,{requestOrigin:'https://evil.example',expected:403});
  await api(`${publicBase}/config`,{requestOrigin:null,expected:403});
  await api('/api/public/chatbots/pub_fake/config',{expected:404});
  await api(`${publicBase}/chat`,{method:'POST',requestOrigin:'https://evil.example',body:{message:'test'},expected:403});
  const result = await api(`${publicBase}/chat`,{method:'POST',body:{message:'When can volunteers cancel their shift?',history:[]}});
  assert.equal(result.body.fallback,false); assert.match(result.body.answer,/12\s+hours/i); assert.ok(result.body.sources.length);
  for(const source of result.body.sources) {
    assert.ok(source.path.startsWith(`${publicBase}/document-sources/`));
    assert.ok(!source.path.includes(values.organization) && !source.path.includes(values.chatbot));
    const detail = await api(source.path); assert.ok(detail.body.excerpt); assert.equal(detail.body.storageKey,undefined);
  }
  await api(`${publicBase}/document-sources/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,{expected:404});
  for(const [method,path] of [['POST','/api/organizations'],['POST',`${internal}/documents`],['POST',`${internal}/public-id/rotate`],['PUT',`${internal}/allowed-origins`]]) await api(path,{method,expected:401});
  const bundle = await fetch(`${base}/widget/v1.js`); assert.equal(bundle.status,200); assert.match(bundle.headers.get('content-type'),/javascript/);
  const code = await bundle.text(); assert.ok(code.length>1000); assert.ok(!code.includes(publicId));
  await api('/api/health'); await api('/api/ready');
  await api('/internal/metrics',{expected:404});
  const metrics = await fetch(`${base}/internal/metrics`,{headers:{Authorization:`Bearer ${local.METRICS_TOKEN}`}}); assert.equal(metrics.status,200);
  const metricsText = await metrics.text(); for(const id of [values.organization,values.chatbot,publicId,login.body.user.id]) assert.ok(!metricsText.includes(id));
  let blocked=false;
  for(let i=0;i<31;i++) {
    const response=await fetch(`${base}${publicBase}/chat`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({message:''})});
    if(response.status===429){assert.ok(Number(response.headers.get('retry-after'))>0);blocked=true;break;} assert.equal(response.status,400);
  }
  assert.ok(blocked);
  console.log('Live public smoke passed: bootstrap, login, config, origins, real RAG answer, citations, private routes, widget, metrics, rate limiting.');
  console.log(`Public chatbot ID: ${publicId}`);
  console.log('Owner credentials remain in ignored .env.smoke.local; no credentials were printed.');
} catch(error) { console.error('Public smoke failed. Inspect status-only results; no response content was logged.'); process.exitCode=1; }
finally { if(cookie && csrf) await api('/api/auth/logout',{method:'POST',admin:true,expected:204}).catch(()=>{}); }
