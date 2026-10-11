import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { hashToken, safeEqual } from '../security/crypto.js';
import { HttpError, notFound } from '../security/errors.js';
import { appendAudit, type Audit } from '../security/repository.js';
import { assertEntitled, CreateKeySchema } from './model.js';
import type { CommercialService } from './service.js';
export function generateApiKey() {
  const secret = `no_live_${randomBytes(32).toString('base64url')}`;
  return {secret,hash:hashToken(secret),prefix:secret.slice(0,16)};
}
export function verifyApiKey(raw: string, hash: string) {
  return /^no_live_[A-Za-z0-9_-]{43}$/.test(raw) && safeEqual(hashToken(raw),hash);
}
export function keyUsable(key: {revoked_at: Date|null; expires_at: Date|null}, now = new Date()) {
  return !key.revoked_at && (!key.expires_at || key.expires_at > now);
}
export const keyColumns = 'id,name,key_prefix,scopes,created_by,created_at,expires_at,revoked_at,last_used_at';
export class ApiKeyService {
  constructor(private commercial: CommercialService) {}
  async create(org: string, input: unknown, audit: Audit) {
    const data = CreateKeySchema.parse(input);
    const expires = data.expiresAt ? new Date(data.expiresAt) : null;
    if (expires && expires <= new Date()) throw new HttpError(400,'INVALID_REQUEST','Expiration must be in the future.');
    const key = generateApiKey();
    return this.commercial.run(org,async(db,{subscription,plan})=>{
      assertEntitled(subscription);
      if (!plan.api_access) throw new HttpError(403,'API_ACCESS_DISABLED','API access is not included in this plan.');
      // Bounded active credentials, independent of commercial usage quotas.
      if (Number((await db.query(`SELECT count(*) AS n FROM api_keys WHERE organization_id=$1 AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at>now())`,[org])).rows[0].n) >= 100) throw new HttpError(409,'KEY_LIMIT','Revoke an existing API key before creating another.');
      const row = (await db.query(`INSERT INTO api_keys(organization_id,name,key_prefix,secret_hash,scopes,created_by,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING ${keyColumns}`,[org,data.name,key.prefix,key.hash,data.scopes,audit.actorUserId,expires])).rows[0];
      await appendAudit(db,{...audit,organizationId:org,action:'api_key.created',targetType:'api_key',targetId:row.id});
      return {apiKey:row,secret:key.secret};
    });
  }
  async list(org: string, limit: number, offset: number) {
    return (await this.commercial.pool.query(`SELECT ${keyColumns} FROM api_keys WHERE organization_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3`,[org,limit,offset])).rows;
  }
  async revoke(org: string, id: string, audit: Audit) {
    z.uuid().parse(id);
    return this.commercial.run(org,async(db)=>{
      const key = (await db.query('SELECT id,revoked_at FROM api_keys WHERE organization_id=$1 AND id=$2 FOR UPDATE',[org,id])).rows[0];
      if (!key) throw notFound();
      if (!key.revoked_at) {
        await db.query('UPDATE api_keys SET revoked_at=now() WHERE organization_id=$1 AND id=$2',[org,id]);
        await appendAudit(db,{...audit,organizationId:org,action:'api_key.revoked',targetType:'api_key',targetId:id});
      }
    });
  }
  async authenticate(raw: string) {
    if (!/^no_live_[A-Za-z0-9_-]{43}$/.test(raw)) throw new HttpError(401,'INVALID_API_KEY','Invalid API key.');
    const key = (await this.commercial.pool.query('SELECT id,organization_id,secret_hash,scopes,expires_at,revoked_at FROM api_keys WHERE secret_hash=$1',[hashToken(raw)])).rows[0];
    if (!key || !verifyApiKey(raw,key.secret_hash) || !keyUsable(key)) throw new HttpError(401,'INVALID_API_KEY','Invalid API key.');
    await this.commercial.pool.query('UPDATE api_keys SET last_used_at=now() WHERE id=$1 AND organization_id=$2',[key.id,key.organization_id]);
    return {id:key.id as string,organizationId:key.organization_id as string,scopes:key.scopes as string[]};
  }
}
