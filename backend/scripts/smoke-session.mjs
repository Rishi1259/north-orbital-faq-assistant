import { readFile } from 'node:fs/promises';
import { parse } from 'dotenv';
// Synthetic principals for opt-in live acceptance checks. Never prints credentials.
import { randomUUID } from 'node:crypto';
import { SecurityRepository } from '../dist/security/repository.js';
import { loadSecurityConfig } from '../dist/security/config.js';
import { randomToken } from '../dist/security/crypto.js';
export async function smokeSession(pool, root, existingOrganization) {
  const config = loadSecurityConfig();
  const organizationId = existingOrganization ?? (await pool.query('INSERT INTO organizations(name,slug) VALUES($1,$2) RETURNING id', ['Smoke setup',`smoke-setup-${randomUUID()}`])).rows[0].id;
  const reuse = !!existingOrganization && process.env.SMOKE_USE_EXISTING_OWNER === 'true';
  const credentials = reuse ? parse(await readFile(new URL('../../.env.smoke.local',import.meta.url))) : undefined;
  const email = credentials?.SMOKE_EMAIL ?? `smoke-${randomUUID()}@example.test`, password = credentials?.SMOKE_PASSWORD ?? randomToken();
  const store = new SecurityRepository(pool, config);
  let userId, cookie, csrf;
  const close = async () => {
    if(cookie) await fetch(`${root}/api/auth/logout`, {method:'POST',headers:{Cookie:cookie,'X-CSRF-Token':csrf}});
    if(userId && !reuse) await pool.query('DELETE FROM users WHERE id=$1',[userId]);
    if(!existingOrganization) await pool.query('DELETE FROM organizations WHERE id=$1',[organizationId]);
  };
  try {
    if (!reuse) userId = (await store.bootstrap(email,password,organizationId)).id;
    const response = await fetch(`${root}/api/auth/login`,{method:'POST',headers:{Origin:config.ADMIN_APP_ORIGIN,'Content-Type':'application/json'},body:JSON.stringify({email,password})});
    if(response.status!==200) throw new Error('Smoke authentication failed.');
    cookie=response.headers.get('set-cookie').split(';')[0]; const login=await response.json(); csrf=login.csrfToken;
    if (reuse && !await store.role(login.user.id,organizationId)) throw new Error('Smoke owner lacks organization membership.');
    return { fetch: (url,options={}) => fetch(url,{...options,headers:{...options.headers,Cookie:cookie,'X-CSRF-Token':csrf,Origin:config.ADMIN_APP_ORIGIN}}), close };
  } catch(error) { await close(); throw error; }
}
