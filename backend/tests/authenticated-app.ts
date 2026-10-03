// Dependency-injected authenticated principal for existing handler/RAG tests.
// New security suites use the real createApp and real database-backed sessions.
import express from 'express';
import { randomUUID } from 'node:crypto';
import { createApp as application, type AppOptions } from '../src/app.js';
import { loadSecurityConfig } from '../src/security/config.js';
import { hashToken, randomToken } from '../src/security/crypto.js';
import type { SecurityStore } from '../src/security/repository.js';
export function createApp(options: AppOptions = {}) {
  const csrf = randomToken(), userId = randomUUID();
  const security: SecurityStore = {
    authenticate: async () => ({ id: randomUUID(), userId, email: 'fixture@example.test', csrfHash: hashToken(csrf) }),
    role: async () => 'owner', consume: async () => ({ allowed: true, retryAfter: 60 }), audit: async () => {},
    createOrganization: async input => options.organizationService!.create(input),
    login: async () => { throw new Error('Not used by handler fixtures'); }, logout: async () => {}, auditPage: async () => [],
  };
  const wrapper = express();
  wrapper.use((req, _res, next) => { req.headers['x-csrf-token'] = csrf; next(); });
  wrapper.use(application({ security, securityConfig: loadSecurityConfig({ NODE_ENV: 'test' }), ...options }));
  return wrapper;
}
