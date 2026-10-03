import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
export const randomToken = () => randomBytes(32).toString('base64url');
export const randomPublicId = () => `pub_${randomBytes(24).toString('hex')}`;
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export const hashPassword = (password: string) => argon2.hash(password, {
  type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1,
});
export const verifyPassword = (hash: string, password: string) => argon2.verify(hash, password);
