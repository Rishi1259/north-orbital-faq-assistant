import { createHmac } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { hashPassword, hashToken, randomToken, verifyPassword } from './crypto.js';
import { EmailSchema, PasswordSchema, type SecurityConfig } from './config.js';
import { HttpError, notFound } from './errors.js';

export type Role = 'owner' | 'admin' | 'member';
export interface Session { id: string; userId: string; email: string; csrfHash: string; }
export interface Audit {
  action: string; targetType: string; organizationId?: string; chatbotId?: string;
  actorUserId?: string; targetId?: string; requestId?: string;
  metadata?: { result?: 'success' | 'failure'; count?: number; enabled?: boolean; role?: Role };
}
export async function appendAudit(db: Pick<Pool, 'query'>, event: Audit) {
  // Explicit allowlist prevents callers from accidentally persisting body/content/credentials.
  const m = event.metadata;
  const metadata = { ...(m?.result && { result: m.result }), ...(m?.count !== undefined && { count: m.count }),
    ...(m?.enabled !== undefined && { enabled: m.enabled }), ...(m?.role && { role: m.role }) };
  await db.query(`INSERT INTO audit_events(organization_id,actor_user_id,chatbot_id,action,target_type,target_id,request_id,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [event.organizationId ?? null, event.actorUserId ?? null,
    event.chatbotId ?? null, event.action, event.targetType, event.targetId ?? null,
    event.requestId && z.uuid().safeParse(event.requestId).success ? event.requestId : null, JSON.stringify(metadata)]);
}
export class SecurityRepository {
  private dummyHash?: Promise<string>;
  constructor(readonly database: Pool, readonly config: SecurityConfig) {}
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.database.connect();
    try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  audit(event: Audit) { return appendAudit(this.database, event); }
  async bootstrap(email: string, password: string, organizationId: string) {
    email = EmailSchema.parse(email); PasswordSchema.parse(password); z.uuid().parse(organizationId);
    const passwordHash = await hashPassword(password);
    return this.transaction(async db => {
      if (!(await db.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [organizationId])).rowCount) throw notFound();
      const inserted = await db.query(`INSERT INTO users(email,password_hash) VALUES($1,$2)
        ON CONFLICT (lower(email)) DO NOTHING RETURNING id`, [email, passwordHash]);
      let userId = inserted.rows[0]?.id as string | undefined;
      if (!userId) {
        const user = (await db.query('SELECT id,password_hash FROM users WHERE lower(email)=$1', [email])).rows[0];
        if (!user || !await verifyPassword(user.password_hash, password)) throw new HttpError(409, 'ACCOUNT_EXISTS', 'Existing account password must match.');
        userId = user.id;
      }
      await db.query(`INSERT INTO organization_memberships(organization_id,user_id,role) VALUES($1,$2,'owner')
        ON CONFLICT (organization_id,user_id) DO UPDATE SET role='owner'`, [organizationId, userId]);
      await appendAudit(db, { action: 'membership.owner_bootstrapped', targetType: 'user', targetId: userId,
        actorUserId: userId, organizationId, metadata: { role: 'owner' } });
      return { id: userId!, email };
    });
  }
  async login(email: string, password: string, requestId: string) {
    const user = (await this.database.query('SELECT id,email,password_hash FROM users WHERE lower(email)=$1', [email])).rows[0];
    this.dummyHash ??= hashPassword(randomToken());
    const valid = await verifyPassword(user?.password_hash ?? await this.dummyHash, password);
    if (!valid || !user) {
      await this.audit({ action: 'auth.login.failure', targetType: 'auth', requestId, metadata: { result: 'failure' } });
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
    }
    const token = randomToken(), csrfToken = randomToken();
    await this.transaction(async db => {
      await db.query(`INSERT INTO auth_sessions(user_id,token_hash,csrf_hash,expires_at)
        VALUES($1,$2,$3,now()+$4 * interval '1 second')`,
      [user.id, hashToken(token), hashToken(csrfToken), this.config.SESSION_TTL_SECONDS]);
      await appendAudit(db, { action: 'auth.login.success', targetType: 'auth', actorUserId: user.id, requestId });
    });
    return { token, csrfToken, user: { id: user.id, email: user.email } };
  }
  async authenticate(token: string): Promise<Session | undefined> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    return (await this.database.query<Session>(`SELECT s.id,u.id AS "userId",u.email,s.csrf_hash AS "csrfHash"
      FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()`, [hashToken(token)])).rows[0];
  }
  async logout(session: Session, requestId: string) {
    await this.transaction(async db => {
      await db.query('DELETE FROM auth_sessions WHERE id=$1', [session.id]);
      await appendAudit(db, { action: 'auth.logout', targetType: 'auth', actorUserId: session.userId, requestId });
    });
  }
  async role(userId: string, organizationId: string): Promise<Role | undefined> {
    if (!z.uuid().safeParse(organizationId).success) return;
    return (await this.database.query('SELECT role FROM organization_memberships WHERE organization_id=$1 AND user_id=$2',
      [organizationId, userId])).rows[0]?.role;
  }
  async createOrganization(input: {name: string; slug: string}, userId: string, requestId: string) {
    return this.transaction(async db => {
      const row = (await db.query(`INSERT INTO organizations(name,slug) VALUES($1,$2)
        RETURNING id,name,slug,created_at AS "createdAt",updated_at AS "updatedAt"`, [input.name, input.slug])).rows[0];
      await db.query(`INSERT INTO organization_memberships(organization_id,user_id,role) VALUES($1,$2,'owner')`, [row.id, userId]);
      await appendAudit(db, { action: 'organization.created', targetType: 'organization', organizationId: row.id,
        targetId: row.id, actorUserId: userId, requestId });
      await appendAudit(db, { action: 'membership.created', targetType: 'user', organizationId: row.id,
        targetId: userId, actorUserId: userId, requestId, metadata: { role: 'owner' } });
      return row;
    });
  }
  async consume(kind: string, parts: string[], limit: number, seconds: number, now = Date.now()) {
    if (!this.config.RATE_LIMIT_HASH_SECRET) throw new Error('Rate limit secret is not configured.');
    const key = createHmac('sha256', this.config.RATE_LIMIT_HASH_SECRET).update(JSON.stringify([kind, ...parts])).digest('hex');
    const start = Math.floor(now / (seconds * 1000)) * seconds;
    const result = await this.database.query(`INSERT INTO rate_limit_windows(key_hash,window_start,expires_at,hits)
      VALUES($1,$2,to_timestamp($2::bigint+$3::integer),1)
      ON CONFLICT(key_hash,window_start) DO UPDATE SET hits=LEAST(rate_limit_windows.hits+1,$4::integer+1)
      RETURNING hits`, [key, start, seconds, limit]);
    return { allowed: result.rows[0].hits <= limit, retryAfter: Math.max(1, Math.ceil(start + seconds - now / 1000)) };
  }
  async cleanup() {
    // Bounded batches keep routine cleanup from holding large locks.
    await this.database.query('DELETE FROM auth_sessions WHERE id IN (SELECT id FROM auth_sessions WHERE expires_at<=now() LIMIT 10000)');
    await this.database.query(`DELETE FROM rate_limit_windows WHERE (key_hash,window_start) IN
      (SELECT key_hash,window_start FROM rate_limit_windows WHERE expires_at<=now() LIMIT 10000)`);
  }
  async auditPage(organizationId: string, limit: number, offset: number) {
    return (await this.database.query(`SELECT id,actor_user_id AS "actorUserId",chatbot_id AS "chatbotId",action,
      target_type AS "targetType",target_id AS "targetId",request_id AS "requestId",metadata,created_at AS "createdAt"
      FROM audit_events WHERE organization_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3`, [organizationId, limit, offset])).rows;
  }
}
export type SecurityStore = Pick<SecurityRepository, 'authenticate' | 'role' | 'consume' | 'audit' | 'login' | 'logout' |
  'createOrganization' | 'auditPage'>;
