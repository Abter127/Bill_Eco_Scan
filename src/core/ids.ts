import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * Claim tokens are bearer credentials displayed in public (E2). The entropy
 * floor from E6 "Claim-token enumeration" is 128 bits; we issue 256 and store
 * only a hash, so a database read cannot be turned into a claim.
 */
export const CLAIM_TOKEN_BYTES = 32; // 256 bits

export function newId(): string {
  return randomUUID();
}

/** Client-generated so the offline queue can dedupe before the server sees it. */
export function newIdempotencyKey(): string {
  return randomUUID();
}

export function newClaimTokenSecret(): string {
  return randomBytes(CLAIM_TOKEN_BYTES).toString('base64url');
}

export function hashToken(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Short, human-readable reference shown on the claim page and in support
 * tickets. Not a secret and never a lookup key on its own.
 */
export function shortRef(id: string): string {
  return sha256Hex(id).slice(0, 8).toUpperCase();
}
