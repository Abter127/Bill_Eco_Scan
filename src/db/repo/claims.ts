import type { Db } from '../sqlite.js';
import { boolToInt, intToBool, nowIso } from '../sqlite.js';
import { hashToken, newClaimTokenSecret, newId } from '../../core/ids.js';

/**
 * Claim tokens (M-02, C-01) and the idempotency ledger (M-03).
 *
 * E2's framing governs everything here: "A QR on a screen is a bearer token in
 * public. Design for that." Short TTL, single use, stored only as a hash, and
 * an atomic first-claim-wins consume so two devices racing on one token cannot
 * both succeed.
 */

/** M-02: <= 15 minutes. */
export const CLAIM_TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * E2 "scanned offline": the customer scanned in the shop with no signal and the
 * request lands after the TTL. The server accepts a late claim when the client
 * proves when it scanned, within this grace period.
 */
export const OFFLINE_SCAN_GRACE_MS = 6 * 60 * 60 * 1000;

/** Open decision §9.05 — second factor above this value. Config, not a guess. */
export const HIGH_VALUE_SECOND_FACTOR_MINOR = 25_000_00;

export interface IssuedToken {
  id: string;
  billId: string;
  /** Returned exactly once, at issue. Only the hash is persisted. */
  secret: string;
  expiresAt: string;
  requiresSecondFactor: boolean;
  secondFactorHint: string | null;
}

export function issueClaimToken(
  db: Db,
  billId: string,
  opts: { now?: Date; grandTotalMinor?: number; offlineSigned?: boolean; ttlMs?: number } = {},
): IssuedToken {
  const now = opts.now ?? new Date();
  const secret = newClaimTokenSecret();
  const id = newId();
  const expiresAt = new Date(now.getTime() + (opts.ttlMs ?? CLAIM_TOKEN_TTL_MS)).toISOString();

  // E2 "the person behind in the queue scans your QR": on a high-value bill we
  // ask for the last 4 digits of the amount. Cheap for the buyer, who is
  // holding the slip; useless to a shoulder-surfer, who is not.
  const requiresSecondFactor =
    (opts.grandTotalMinor ?? 0) >= HIGH_VALUE_SECOND_FACTOR_MINOR;
  const secondFactorHint = requiresSecondFactor ? 'last-4-of-amount' : null;

  db.prepare(`INSERT INTO claim_tokens
    (id, bill_id, token_hash, issued_at, expires_at, offline_signed, scan_count,
     requires_second_factor, second_factor_hint)
    VALUES (?,?,?,?,?,?,0,?,?)`)
    .run(
      id, billId, hashToken(secret), now.toISOString(), expiresAt,
      boolToInt(opts.offlineSigned ?? false),
      boolToInt(requiresSecondFactor), secondFactorHint,
    );

  return { id, billId, secret, expiresAt, requiresSecondFactor, secondFactorHint };
}

/**
 * M-03: "Locally-signed tokens validate on reconnect."
 *
 * During an outage the agent mints the claim token itself and prints its QR, so
 * the customer's experience at the counter is unchanged. On reconnect the agent
 * replays the token alongside the bill and we register it as-is — otherwise the
 * QR the customer already photographed would resolve to nothing.
 */
export function registerOfflineToken(
  db: Db,
  billId: string,
  secret: string,
  issuedAt: string,
  ttlMs: number = CLAIM_TOKEN_TTL_MS,
  grandTotalMinor = 0,
): IssuedToken {
  const id = newId();
  // The TTL runs from when the token was shown at the counter, not from when we
  // finally heard about it; the offline-scan grace in `claimBill` covers the gap.
  const expiresAt = new Date(Date.parse(issuedAt) + ttlMs).toISOString();
  const requiresSecondFactor = grandTotalMinor >= HIGH_VALUE_SECOND_FACTOR_MINOR;

  db.prepare(`INSERT OR IGNORE INTO claim_tokens
    (id, bill_id, token_hash, issued_at, expires_at, offline_signed, scan_count,
     requires_second_factor, second_factor_hint)
    VALUES (?,?,?,?,?,1,0,?,?)`)
    .run(id, billId, hashToken(secret), issuedAt, expiresAt,
      boolToInt(requiresSecondFactor), requiresSecondFactor ? 'last-4-of-amount' : null);

  return {
    id, billId, secret, expiresAt, requiresSecondFactor,
    secondFactorHint: requiresSecondFactor ? 'last-4-of-amount' : null,
  };
}

export interface TokenRecord {
  id: string;
  billId: string;
  issuedAt: string;
  expiresAt: string;
  consumedAt: string | null;
  consumedByAccountId: string | null;
  offlineSigned: boolean;
  scanCount: number;
  requiresSecondFactor: boolean;
  secondFactorHint: string | null;
}

export function findToken(db: Db, secret: string): TokenRecord | null {
  const r = db.prepare<[string], {
    id: string; bill_id: string; issued_at: string; expires_at: string;
    consumed_at: string | null; consumed_by_account_id: string | null;
    offline_signed: number; scan_count: number;
    requires_second_factor: number; second_factor_hint: string | null;
  }>('SELECT * FROM claim_tokens WHERE token_hash = ?').get(hashToken(secret));
  if (!r) return null;
  return {
    id: r.id, billId: r.bill_id, issuedAt: r.issued_at, expiresAt: r.expires_at,
    consumedAt: r.consumed_at, consumedByAccountId: r.consumed_by_account_id,
    offlineSigned: intToBool(r.offline_signed), scanCount: r.scan_count,
    requiresSecondFactor: intToBool(r.requires_second_factor),
    secondFactorHint: r.second_factor_hint,
  };
}

export function recordScan(db: Db, tokenId: string): void {
  db.prepare('UPDATE claim_tokens SET scan_count = scan_count + 1 WHERE id = ?').run(tokenId);
}

export type ConsumeOutcome =
  | { won: true; tokenId: string }
  | { won: false; reason: 'already_claimed'; claimedByAccountId: string | null; claimedAt: string | null };

/**
 * E2 "two devices claim simultaneously". One UPDATE with `consumed_at IS NULL`
 * in the predicate is the whole race resolution: SQLite serialises it, exactly
 * one caller sees `changes === 1`, and the loser gets a clear message rather
 * than an error.
 */
export function consumeToken(db: Db, tokenId: string, accountId: string, now = new Date()): ConsumeOutcome {
  const res = db.prepare(
    'UPDATE claim_tokens SET consumed_at = ?, consumed_by_account_id = ? WHERE id = ? AND consumed_at IS NULL',
  ).run(now.toISOString(), accountId, tokenId);

  if (res.changes === 1) return { won: true, tokenId };

  const r = db.prepare<[string], { consumed_at: string | null; consumed_by_account_id: string | null }>(
    'SELECT consumed_at, consumed_by_account_id FROM claim_tokens WHERE id = ?',
  ).get(tokenId);
  return {
    won: false,
    reason: 'already_claimed',
    claimedByAccountId: r?.consumed_by_account_id ?? null,
    claimedAt: r?.consumed_at ?? null,
  };
}

/** E1: the QR clears from the display the instant the transaction ends. */
export function expireTokensForBill(db: Db, billId: string, now = new Date()): number {
  return db.prepare(
    'UPDATE claim_tokens SET expires_at = ? WHERE bill_id = ? AND consumed_at IS NULL AND expires_at > ?',
  ).run(now.toISOString(), billId, now.toISOString()).changes;
}

/**
 * E6 "claim-token enumeration": per-terminal rate limits and anomaly alerting
 * on failed-claim volume. This is the counting half.
 */
export function failedClaimVolume(db: Db, sinceIso: string): number {
  return db.prepare<[string], { n: number }>(
    `SELECT COUNT(*) AS n FROM access_log
      WHERE action = 'claim_failed' AND created_at >= ?`,
  ).get(sinceIso)!.n;
}

// ---------------------------------------------------------------------------
// Idempotency ledger (M-03)
// ---------------------------------------------------------------------------

export type IdempotencyOutcome = 'created' | 'duplicate_reprint' | 'quarantined' | 'rejected';

export interface IdempotencyRecord {
  key: string;
  billId: string | null;
  outcome: IdempotencyOutcome;
  response: unknown;
  createdAt: string;
}

export function findIdempotency(db: Db, key: string): IdempotencyRecord | null {
  const r = db.prepare<[string], {
    key: string; bill_id: string | null; outcome: string; response_json: string; created_at: string;
  }>('SELECT * FROM idempotency_records WHERE key = ?').get(key);
  if (!r) return null;
  return {
    key: r.key, billId: r.bill_id, outcome: r.outcome as IdempotencyOutcome,
    response: JSON.parse(r.response_json) as unknown, createdAt: r.created_at,
  };
}

/**
 * Recorded inside the same transaction as the bill insert. A four-hour outage
 * that replays the whole local queue therefore reconciles with zero duplicates
 * and zero losses (M-03's acceptance criterion) — every replayed key finds its
 * record and returns the original response.
 */
export function recordIdempotency(
  db: Db, key: string, billId: string | null, outcome: IdempotencyOutcome, response: unknown,
): void {
  db.prepare(`INSERT OR IGNORE INTO idempotency_records (key, bill_id, outcome, response_json, created_at)
              VALUES (?,?,?,?,?)`)
    .run(key, billId, outcome, JSON.stringify(response), nowIso());
}
