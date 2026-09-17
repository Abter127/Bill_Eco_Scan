import type { Db } from '../sqlite.js';
import { boolToInt, intToBool, nowIso } from '../sqlite.js';
import { newId } from '../../core/ids.js';
import { localDateKey } from '../../core/time.js';
import type { LinkRelation } from '../../core/schema.js';
import type { GrantScope, ScopedGrant } from '../../core/consent.js';

// ---------------------------------------------------------------------------
// Document links (E4 — every amendment is a new linked document)
// ---------------------------------------------------------------------------

export interface DocumentLink {
  id: string;
  fromBillId: string;
  toBillId: string | null;
  toDocumentNumber: string | null;
  toMerchantId: string | null;
  relation: LinkRelation;
  targetLineNos: number[];
  resolved: boolean;
  createdAt: string;
}

export function createLink(
  db: Db,
  input: {
    fromBillId: string;
    toBillId?: string | null;
    toDocumentNumber?: string | null;
    toMerchantId?: string | null;
    relation: LinkRelation;
    targetLineNos?: number[];
  },
): DocumentLink {
  const id = newId();
  const at = nowIso();
  const resolved = Boolean(input.toBillId);
  db.prepare(`INSERT INTO document_links
    (id, from_bill_id, to_bill_id, to_document_number, to_merchant_id, relation, target_line_nos, resolved, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(
      id, input.fromBillId, input.toBillId ?? null, input.toDocumentNumber ?? null,
      input.toMerchantId ?? null, input.relation,
      JSON.stringify(input.targetLineNos ?? []), boolToInt(resolved), at,
    );
  return {
    id, fromBillId: input.fromBillId, toBillId: input.toBillId ?? null,
    toDocumentNumber: input.toDocumentNumber ?? null, toMerchantId: input.toMerchantId ?? null,
    relation: input.relation, targetLineNos: input.targetLineNos ?? [], resolved, createdAt: at,
  };
}

interface LinkRow {
  id: string; from_bill_id: string; to_bill_id: string | null; to_document_number: string | null;
  to_merchant_id: string | null; relation: string; target_line_nos: string;
  resolved: number; created_at: string;
}

function toLink(r: LinkRow): DocumentLink {
  return {
    id: r.id, fromBillId: r.from_bill_id, toBillId: r.to_bill_id,
    toDocumentNumber: r.to_document_number, toMerchantId: r.to_merchant_id,
    relation: r.relation as LinkRelation, targetLineNos: JSON.parse(r.target_line_nos) as number[],
    resolved: intToBool(r.resolved), createdAt: r.created_at,
  };
}

export function linksFrom(db: Db, billId: string): DocumentLink[] {
  return db.prepare<[string], LinkRow>('SELECT * FROM document_links WHERE from_bill_id = ?')
    .all(billId).map(toLink);
}

export function linksTo(db: Db, billId: string): DocumentLink[] {
  return db.prepare<[string], LinkRow>('SELECT * FROM document_links WHERE to_bill_id = ?')
    .all(billId).map(toLink);
}

/**
 * E4 "credit note arrives out of order": the merchant was offline when the
 * return was processed, so the credit note lands before the bill it refunds.
 * We park it and reconcile when the original arrives.
 */
export function parkedLinksFor(db: Db, merchantId: string, documentNumber: string): DocumentLink[] {
  return db.prepare<[string, string], LinkRow>(
    'SELECT * FROM document_links WHERE resolved = 0 AND to_merchant_id = ? AND to_document_number = ?',
  ).all(merchantId, documentNumber).map(toLink);
}

export function resolveLink(db: Db, linkId: string, toBillId: string): void {
  db.prepare('UPDATE document_links SET to_bill_id = ?, resolved = 1 WHERE id = ?').run(toBillId, linkId);
}

/** Orphan amendments that never found their original — the console alerts on these. */
export function staleOrphanLinks(db: Db, olderThanIso: string): DocumentLink[] {
  return db.prepare<[string], LinkRow>(
    'SELECT * FROM document_links WHERE resolved = 0 AND created_at < ?',
  ).all(olderThanIso).map(toLink);
}

// ---------------------------------------------------------------------------
// Quarantine (E1 — never to a customer)
// ---------------------------------------------------------------------------

export interface QuarantineEntry {
  id: string; terminalId: string | null; outletId: string | null;
  streamClass: string; reason: string; confidence: number | null;
  preview: string; rawRef: string | null; createdAt: string;
  resolvedAs: string | null; resolvedAt: string | null;
}

export function quarantine(
  db: Db,
  input: {
    terminalId?: string | null; outletId?: string | null; streamClass: string;
    reason: string; confidence?: number | null; preview: string; rawRef?: string | null;
  },
): QuarantineEntry {
  const id = newId();
  const at = nowIso();
  // The preview is truncated deliberately: a quarantine queue is a debugging
  // surface for the merchant, not a second copy of every document.
  const preview = input.preview.slice(0, 500);
  db.prepare(`INSERT INTO quarantine
    (id, terminal_id, outlet_id, stream_class, reason, confidence, preview, raw_ref, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, input.terminalId ?? null, input.outletId ?? null, input.streamClass,
      input.reason, input.confidence ?? null, preview, input.rawRef ?? null, at);
  return {
    id, terminalId: input.terminalId ?? null, outletId: input.outletId ?? null,
    streamClass: input.streamClass, reason: input.reason, confidence: input.confidence ?? null,
    preview, rawRef: input.rawRef ?? null, createdAt: at, resolvedAs: null, resolvedAt: null,
  };
}

export function listQuarantine(db: Db, outletId: string, limit = 50): QuarantineEntry[] {
  return db.prepare<[string, number], {
    id: string; terminal_id: string | null; outlet_id: string | null; stream_class: string;
    reason: string; confidence: number | null; preview: string; raw_ref: string | null;
    created_at: string; resolved_as: string | null; resolved_at: string | null;
  }>('SELECT * FROM quarantine WHERE outlet_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(outletId, limit)
    .map((r) => ({
      id: r.id, terminalId: r.terminal_id, outletId: r.outlet_id, streamClass: r.stream_class,
      reason: r.reason, confidence: r.confidence, preview: r.preview, rawRef: r.raw_ref,
      createdAt: r.created_at, resolvedAs: r.resolved_as, resolvedAt: r.resolved_at,
    }));
}

export function resolveQuarantine(db: Db, id: string, resolvedAs: string): void {
  db.prepare('UPDATE quarantine SET resolved_as = ?, resolved_at = ? WHERE id = ?')
    .run(resolvedAs, nowIso(), id);
}

// ---------------------------------------------------------------------------
// Access log (T-02)
// ---------------------------------------------------------------------------

export interface AccessLogEntry {
  id: number; billId: string | null; accountId: string | null;
  actorType: string; actorId: string; action: string; reason: string;
  visibleToOwner: boolean; createdAt: string;
}

/**
 * T-02: "Every read by a non-owner — support, admin, automated job — logged
 * with actor, reason, timestamp, and visible to the owner."
 *
 * `reason` is required and not nullable on purpose. A log of accesses without
 * reasons tells an owner that someone looked, which is worse than not knowing.
 */
export function logAccess(
  db: Db,
  input: {
    billId?: string | null; accountId?: string | null;
    actorType: 'support' | 'admin' | 'automated_job' | 'merchant' | 'grant' | 'system';
    actorId: string; action: string; reason: string; visibleToOwner?: boolean;
  },
): void {
  db.prepare(`INSERT INTO access_log
    (bill_id, account_id, actor_type, actor_id, action, reason, visible_to_owner, created_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(
      input.billId ?? null, input.accountId ?? null, input.actorType, input.actorId,
      input.action, input.reason, boolToInt(input.visibleToOwner ?? true), nowIso(),
    );
}

export function accessLogForOwner(db: Db, accountId: string, limit = 100): AccessLogEntry[] {
  return db.prepare<[string, number], {
    id: number; bill_id: string | null; account_id: string | null; actor_type: string;
    actor_id: string; action: string; reason: string; visible_to_owner: number; created_at: string;
  }>(`SELECT * FROM access_log
       WHERE account_id = ? AND visible_to_owner = 1
       ORDER BY created_at DESC LIMIT ?`)
    .all(accountId, limit)
    .map((r) => ({
      id: r.id, billId: r.bill_id, accountId: r.account_id, actorType: r.actor_type,
      actorId: r.actor_id, action: r.action, reason: r.reason,
      visibleToOwner: intToBool(r.visible_to_owner), createdAt: r.created_at,
    }));
}

// ---------------------------------------------------------------------------
// Grants (T-01)
// ---------------------------------------------------------------------------

export function createGrant(
  db: Db,
  input: {
    billId: string; accountId: string; grantedToMerchantId?: string | null;
    scope: GrantScope; ttlMs: number;
  },
  now = new Date(),
): ScopedGrant {
  const id = newId();
  const expiresAt = new Date(now.getTime() + input.ttlMs).toISOString();
  const createdAt = now.toISOString();
  db.prepare(`INSERT INTO grants
    (id, bill_id, account_id, granted_to_merchant_id, scope, expires_at, revoked_at, created_at)
    VALUES (?,?,?,?,?,?,NULL,?)`)
    .run(id, input.billId, input.accountId, input.grantedToMerchantId ?? null,
      input.scope, expiresAt, createdAt);
  return {
    id, billId: input.billId, grantedToMerchantId: input.grantedToMerchantId ?? null,
    scope: input.scope, expiresAt, revokedAt: null, createdAt, fields: [],
  };
}

export function revokeGrant(db: Db, grantId: string): void {
  db.prepare('UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(nowIso(), grantId);
}

export function activeGrants(db: Db, billId: string, now = new Date()): ScopedGrant[] {
  return db.prepare<[string, string], {
    id: string; bill_id: string; granted_to_merchant_id: string | null; scope: string;
    expires_at: string; revoked_at: string | null; created_at: string;
  }>('SELECT * FROM grants WHERE bill_id = ? AND revoked_at IS NULL AND expires_at > ?')
    .all(billId, now.toISOString())
    .map((r) => ({
      id: r.id, billId: r.bill_id, grantedToMerchantId: r.granted_to_merchant_id,
      scope: r.scope as GrantScope, expiresAt: r.expires_at, revokedAt: r.revoked_at,
      createdAt: r.created_at, fields: [],
    }));
}

// ---------------------------------------------------------------------------
// Annotations (E4 — attached to the group, so they survive amendments)
// ---------------------------------------------------------------------------

export interface Annotation {
  id: string; billGroupId: string; accountId: string;
  kind: 'note' | 'tag' | 'category' | 'attachment'; value: string; createdAt: string;
}

export function addAnnotation(
  db: Db, billGroupId: string, accountId: string, kind: Annotation['kind'], value: string,
): Annotation {
  const id = newId();
  const at = nowIso();
  db.prepare('INSERT INTO annotations (id, bill_group_id, account_id, kind, value, created_at) VALUES (?,?,?,?,?,?)')
    .run(id, billGroupId, accountId, kind, value, at);
  return { id, billGroupId, accountId, kind, value, createdAt: at };
}

export function annotationsFor(db: Db, billGroupId: string): Annotation[] {
  return db.prepare<[string], {
    id: string; bill_group_id: string; account_id: string; kind: string; value: string; created_at: string;
  }>('SELECT * FROM annotations WHERE bill_group_id = ? ORDER BY created_at')
    .all(billGroupId)
    .map((r) => ({
      id: r.id, billGroupId: r.bill_group_id, accountId: r.account_id,
      kind: r.kind as Annotation['kind'], value: r.value, createdAt: r.created_at,
    }));
}

// ---------------------------------------------------------------------------
// Merchant metrics (M-04, E5)
// ---------------------------------------------------------------------------

export function bumpIssuanceStat(
  db: Db,
  outletId: string,
  field: 'bills_issued' | 'bills_claimed' | 'paper_printed' | 'paper_suppressed' | 'quarantined',
  now = new Date(),
  by = 1,
): void {
  const dateKey = localDateKey(now);
  db.prepare(`INSERT INTO issuance_stats (outlet_id, date_key, ${field})
              VALUES (?, ?, ?)
              ON CONFLICT(outlet_id, date_key) DO UPDATE SET ${field} = ${field} + excluded.${field}`)
    .run(outletId, dateKey, by);
}

export interface OutletMetrics {
  outletId: string;
  fromDateKey: string;
  toDateKey: string;
  billsIssued: number;
  billsClaimed: number;
  claimRate: number;
  paperPrinted: number;
  paperSuppressed: number;
  paperSuppressionRate: number;
  quarantined: number;
}

export function outletMetrics(
  db: Db, outletId: string, fromDateKey: string, toDateKey: string,
): OutletMetrics {
  const r = db.prepare<[string, string, string], {
    issued: number; claimed: number; printed: number; suppressed: number; quarantined: number;
  }>(`SELECT COALESCE(SUM(bills_issued),0) AS issued,
             COALESCE(SUM(bills_claimed),0) AS claimed,
             COALESCE(SUM(paper_printed),0) AS printed,
             COALESCE(SUM(paper_suppressed),0) AS suppressed,
             COALESCE(SUM(quarantined),0) AS quarantined
        FROM issuance_stats
       WHERE outlet_id = ? AND date_key BETWEEN ? AND ?`)
    .get(outletId, fromDateKey, toDateKey)!;

  const paperTotal = r.printed + r.suppressed;
  return {
    outletId, fromDateKey, toDateKey,
    billsIssued: r.issued, billsClaimed: r.claimed,
    claimRate: r.issued === 0 ? 0 : r.claimed / r.issued,
    paperPrinted: r.printed, paperSuppressed: r.suppressed,
    paperSuppressionRate: paperTotal === 0 ? 0 : r.suppressed / paperTotal,
    quarantined: r.quarantined,
  };
}

/**
 * E5 "staff claim bills to their own account": a single account taking a high
 * share of one terminal's bills is a flag, not a power user.
 */
export function recordTerminalClaim(db: Db, terminalId: string, accountId: string, now = new Date()): void {
  db.prepare(`INSERT INTO terminal_claim_patterns (terminal_id, account_id, date_key, claims)
              VALUES (?,?,?,1)
              ON CONFLICT(terminal_id, account_id, date_key) DO UPDATE SET claims = claims + 1`)
    .run(terminalId, accountId, localDateKey(now));
}

export interface ClaimAnomaly {
  terminalId: string;
  accountId: string;
  claims: number;
  totalClaims: number;
  share: number;
}

export const STAFF_CLAIM_SHARE_THRESHOLD = 0.25;
export const STAFF_CLAIM_MIN_VOLUME = 8;

export function claimAnomalies(
  db: Db, terminalId: string, fromDateKey: string, toDateKey: string,
): ClaimAnomaly[] {
  const rows = db.prepare<[string, string, string], { account_id: string; claims: number }>(
    `SELECT account_id, SUM(claims) AS claims FROM terminal_claim_patterns
      WHERE terminal_id = ? AND date_key BETWEEN ? AND ?
      GROUP BY account_id`,
  ).all(terminalId, fromDateKey, toDateKey);

  const total = rows.reduce((acc, r) => acc + r.claims, 0);
  if (total < STAFF_CLAIM_MIN_VOLUME) return [];

  return rows
    .map((r) => ({
      terminalId, accountId: r.account_id, claims: r.claims, totalClaims: total,
      share: r.claims / total,
    }))
    .filter((a) => a.share >= STAFF_CLAIM_SHARE_THRESHOLD)
    .sort((a, b) => b.share - a.share);
}
