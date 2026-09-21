import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function createWebhookSecret() {
  const secret = randomBytes(24).toString('base64url');
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(secret, salt, 32).toString('hex');
  return { secret, hash: `${salt}:${hash}` };
}

export function verifyWebhookSecret(secret: string | undefined, stored: string | null): boolean {
  if (!secret || !stored) return false;
  const [salt, expectedHex] = stored.split(':');
  if (!salt || !expectedHex) return false;
  const actual = scryptSync(secret, salt, 32);
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

