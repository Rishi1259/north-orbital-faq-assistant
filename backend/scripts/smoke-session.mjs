// Synthetic principals for opt-in live acceptance checks. Never prints credentials.
import { randomUUID } from 'node:crypto';
import { SecurityRepository } from '../dist/security/repository.js';
import { loadSecurityConfig } from '../dist/security/config.js';
import { randomToken } from '../dist/security/crypto.js';
export async function smokeSession(pool, root, existingOrganization) {
  const config = loadSecurityConfig();
  const organizationId = existingOrganization ?? (await pool.query('INSERT INTO organizations(name,slug) VALUES($1,$2) RETURNING id', ['Smoke setup',`smoke-setup-${randomUUID()}`])).rows[0].id;
  const email = `smoke-${randomUUID()}@example.test`, password = randomToken();
  const store = new SecurityRepository(pool, config);
  let userId, cookie, csrf;
  const close = async () => {
    if(cookie) await fetch(`${root}/api/auth/logout`, {method:'POST',headers:{Cookie:cookie,'X-CSRF-Token':csrf}});
    if(userId) await pool.query('DELETE FROM users WHERE id=$1',[userId]);
    if(!existingOrganization) await pool.query('DELETE FROM organizations WHERE id=$1',[organizationId]);
  };
  try {
    userId = (await store.bootstrap(email,password,organizationId)).id;
    const response = await fetch(`${root}/api/auth/login`,{method:'POST',headers:{Origin:config.ADMIN_APP_ORIGIN,'Content-Type':'application/json'},body:JSON.stringify({email,password})});
    if(response.status!==200) throw new Error('Smoke authentication failed.');
    cookie=response.headers.get('set-cookie').split(';')[0]; csrf=(await response.json()).csrfToken;
    return { fetch: (url,options={}) => fetch(url,{...options,headers:{...options.headers,Cookie:cookie,'X-CSRF-Token':csrf,Origin:config.ADMIN_APP_ORIGIN}}), close };
  } catch(error) { await close(); throw error; }
}
