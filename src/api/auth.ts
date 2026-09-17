import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Session tokens and terminal credentials.
 *
 * Sessions are stateless and HMAC-signed so a claim can complete in one
 * round-trip on a cold device (C-01's 3-second budget), without a session
 * lookup before the bill renders.
 */

const SECRET = process.env.BILLING_HUB_SECRET ?? randomBytes(32).toString('hex');

if (!process.env.BILLING_HUB_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('BILLING_HUB_SECRET must be set in production');
}

export interface SessionClaims {
  accountId: string;
  issuedAt: number;
  expiresAt: number;
}

export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export function signSession(accountId: string, now = new Date()): string {
  const claims: SessionClaims = {
    accountId,
    issuedAt: now.getTime(),
    expiresAt: now.getTime() + SESSION_TTL_MS,
  };
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const sig = createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifySession(token: string | undefined, now = new Date()): SessionClaims | null {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;

  const expected = createHmac('sha256', SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SessionClaims;
    if (claims.expiresAt <= now.getTime()) return null;
    return claims;
  } catch {
    return null;
  }
}

export function sessionCookie(token: string): string {
  return [
    `bh_session=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    process.env.NODE_ENV === 'production' ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return undefined;
}
