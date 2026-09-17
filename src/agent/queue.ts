import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { newId } from '../core/ids.js';
import type { BillPayload } from '../core/schema.js';

/**
 * The agent's durable local queue (M-03).
 *
 * Acceptance criterion: "Four-hour outage during peak trade reconciles with
 * zero duplicates and zero losses."
 *
 * Both halves of that are structural rather than hopeful:
 *
 *  - *Zero losses*: the enqueue is a synchronous committed write to local disk
 *    before the agent acknowledges anything. If the shop loses power mid-sale,
 *    the queue survives it.
 *
 *  - *Zero duplicates*: the idempotency key is generated here, on the client,
 *    once per bill, and stays with the row through every retry. The server's
 *    idempotency ledger does the rest. A retry storm after four hours offline
 *    cannot create a second bill, because it is replaying keys, not bills.
 */

/**
 * `rejected` is terminal and distinct from `sent`: the server refused the
 * payload for a reason retrying cannot fix. Keeping it separate means a bill
 * that was never accepted is visible in the agent's status rather than counted
 * as delivered.
 */
export type QueueItemState = 'pending' | 'inflight' | 'sent' | 'failed' | 'rejected';

export interface QueueItem {
  id: string;
  idempotencyKey: string;
  payload: BillPayload;
  /** A token minted locally during the outage, already shown to the customer. */
  offlineClaimTokenSecret: string | null;
  offlineTokenIssuedAt: string | null;
  state: QueueItemState;
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  enqueuedAt: string;
  sentAt: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS outbox (
  id                      TEXT PRIMARY KEY,
  idempotency_key         TEXT NOT NULL UNIQUE,
  payload_json            TEXT NOT NULL,
  offline_token_secret    TEXT,
  offline_token_issued_at TEXT,
  state                   TEXT NOT NULL DEFAULT 'pending',
  attempts                INTEGER NOT NULL DEFAULT 0,
  next_attempt_at         TEXT NOT NULL,
  last_error              TEXT,
  enqueued_at             TEXT NOT NULL,
  sent_at                 TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_ready ON outbox(state, next_attempt_at);
`;

/** Full jitter exponential backoff, capped. */
export function backoffMs(attempt: number, base = 1_000, cap = 5 * 60_000, random = Math.random): number {
  const exponential = Math.min(cap, base * 2 ** Math.min(attempt, 20));
  return Math.floor(random() * exponential);
}

export class Outbox {
  private readonly db: Database.Database;

  constructor(path = process.env.BILLING_HUB_AGENT_DB ?? './data/agent-outbox.sqlite') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    if (path !== ':memory:') this.db.pragma('journal_mode = WAL');
    // The one pragma that matters here: a bill must be on disk before the
    // cashier hands over the slip.
    this.db.pragma('synchronous = FULL');
    this.db.exec(SCHEMA);
  }

  enqueue(
    payload: BillPayload,
    offline?: { secret: string; issuedAt: string },
    now = new Date(),
  ): QueueItem {
    const id = newId();
    this.db.prepare(`INSERT INTO outbox
      (id, idempotency_key, payload_json, offline_token_secret, offline_token_issued_at,
       state, attempts, next_attempt_at, enqueued_at)
      VALUES (?,?,?,?,?, 'pending', 0, ?, ?)`)
      .run(
        id, payload.idempotencyKey, JSON.stringify(payload),
        offline?.secret ?? null, offline?.issuedAt ?? null,
        now.toISOString(), now.toISOString(),
      );
    return this.get(id)!;
  }

  get(id: string): QueueItem | null {
    const r = this.db.prepare<[string], Record<string, unknown>>('SELECT * FROM outbox WHERE id = ?').get(id);
    return r ? toItem(r) : null;
  }

  /** Items whose backoff has elapsed. */
  due(now = new Date(), limit = 50): QueueItem[] {
    return this.db.prepare<[string, number], Record<string, unknown>>(
      `SELECT * FROM outbox WHERE state IN ('pending','failed') AND next_attempt_at <= ?
        ORDER BY enqueued_at LIMIT ?`,
    ).all(now.toISOString(), limit).map(toItem);
  }

  markSent(id: string, now = new Date()): void {
    this.db.prepare("UPDATE outbox SET state = 'sent', sent_at = ?, last_error = NULL WHERE id = ?")
      .run(now.toISOString(), id);
  }

  /** Terminal failure: the server will never accept this payload. */
  markRejected(id: string, error: string): void {
    this.db.prepare("UPDATE outbox SET state = 'rejected', last_error = ? WHERE id = ?")
      .run(error.slice(0, 500), id);
  }

  markFailed(id: string, error: string, now = new Date(), random = Math.random): void {
    const attempts = (this.db.prepare<[string], { attempts: number }>(
      'SELECT attempts FROM outbox WHERE id = ?',
    ).get(id)?.attempts ?? 0) + 1;

    this.db.prepare(
      "UPDATE outbox SET state = 'failed', attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?",
    ).run(
      attempts, error.slice(0, 500),
      new Date(now.getTime() + backoffMs(attempts, 1_000, 5 * 60_000, random)).toISOString(),
      id,
    );
  }

  /** Sent rows are kept briefly so a duplicate local capture can be detected. */
  prune(olderThanMs = 7 * 86_400_000, now = new Date()): number {
    return this.db.prepare("DELETE FROM outbox WHERE state = 'sent' AND sent_at < ?")
      .run(new Date(now.getTime() - olderThanMs).toISOString()).changes;
  }

  stats(now = new Date()): {
    pending: number; failed: number; sent: number; rejected: number; oldestPendingAgeMs: number | null;
  } {
    const counts = this.db.prepare<[], { state: string; n: number }>(
      'SELECT state, COUNT(*) AS n FROM outbox GROUP BY state',
    ).all();
    const byState = Object.fromEntries(counts.map((c) => [c.state, c.n]));
    const oldest = this.db.prepare<[], { enqueued_at: string }>(
      "SELECT enqueued_at FROM outbox WHERE state IN ('pending','failed') ORDER BY enqueued_at LIMIT 1",
    ).get();
    return {
      pending: byState.pending ?? 0,
      failed: byState.failed ?? 0,
      sent: byState.sent ?? 0,
      rejected: byState.rejected ?? 0,
      oldestPendingAgeMs: oldest ? now.getTime() - Date.parse(oldest.enqueued_at) : null,
    };
  }

  close(): void {
    this.db.close();
  }
}

function toItem(r: Record<string, unknown>): QueueItem {
  return {
    id: r.id as string,
    idempotencyKey: r.idempotency_key as string,
    payload: JSON.parse(r.payload_json as string) as BillPayload,
    offlineClaimTokenSecret: (r.offline_token_secret as string | null) ?? null,
    offlineTokenIssuedAt: (r.offline_token_issued_at as string | null) ?? null,
    state: r.state as QueueItemState,
    attempts: r.attempts as number,
    nextAttemptAt: r.next_attempt_at as string,
    lastError: (r.last_error as string | null) ?? null,
    enqueuedAt: r.enqueued_at as string,
    sentAt: (r.sent_at as string | null) ?? null,
  };
}
