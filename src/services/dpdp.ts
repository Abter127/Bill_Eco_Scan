import type { Db } from '../db/sqlite.js';
import { nowIso } from '../db/sqlite.js';
import { newId } from '../core/ids.js';
import { CONSENT_NOTICE, type ConsentItem } from '../core/consent.js';
import { purgePlanFor } from '../core/lifecycle.js';
import * as billsRepo from '../db/repo/bills.js';
import * as people from '../db/repo/people.js';
import * as ledgers from '../db/repo/ledgers.js';
import { buildBillView } from './billview.js';

/**
 * DPDP Act 2023 rights endpoints (T-03).
 *
 * "Access, correction, erasure, grievance with SLA timers, plus a plain-language
 * itemised consent notice."
 *
 * The SLA timer is stored on the request rather than computed at read time, so
 * a request that has blown its deadline is visible in a query rather than only
 * in a report someone has to remember to run.
 */

export type DpdpKind = 'access' | 'correction' | 'erasure' | 'grievance';
export type DpdpState = 'received' | 'in_progress' | 'fulfilled' | 'rejected';

/** Statutory-facing defaults. Grievances get the tightest clock. */
export const SLA_DAYS: Record<DpdpKind, number> = {
  access: 30,
  correction: 30,
  erasure: 30,
  grievance: 7,
};

export interface DpdpRequest {
  id: string;
  accountId: string;
  kind: DpdpKind;
  state: DpdpState;
  detail: string | null;
  slaDueAt: string;
  resolvedAt: string | null;
  resolution: string | null;
  createdAt: string;
  /** Computed for the operations queue. */
  overdue?: boolean;
  hoursRemaining?: number;
}

export function fileRequest(
  db: Db, accountId: string, kind: DpdpKind, detail?: string | null, now = new Date(),
): DpdpRequest {
  const id = newId();
  const slaDueAt = new Date(now.getTime() + SLA_DAYS[kind] * 86_400_000).toISOString();
  const createdAt = now.toISOString();
  db.prepare(`INSERT INTO dpdp_requests
    (id, account_id, kind, state, detail, sla_due_at, created_at)
    VALUES (?,?,?,'received',?,?,?)`)
    .run(id, accountId, kind, detail ?? null, slaDueAt, createdAt);

  ledgers.logAccess(db, {
    accountId, actorType: 'system', actorId: 'dpdp',
    action: `dpdp_${kind}_filed`, reason: `data principal filed a ${kind} request`,
  });

  return {
    id, accountId, kind, state: 'received', detail: detail ?? null,
    slaDueAt, resolvedAt: null, resolution: null, createdAt,
  };
}

export function listRequests(db: Db, accountId: string, now = new Date()): DpdpRequest[] {
  return db.prepare<[string], {
    id: string; account_id: string; kind: string; state: string; detail: string | null;
    sla_due_at: string; resolved_at: string | null; resolution: string | null; created_at: string;
  }>('SELECT * FROM dpdp_requests WHERE account_id = ? ORDER BY created_at DESC')
    .all(accountId)
    .map((r) => ({
      id: r.id, accountId: r.account_id, kind: r.kind as DpdpKind, state: r.state as DpdpState,
      detail: r.detail, slaDueAt: r.sla_due_at, resolvedAt: r.resolved_at,
      resolution: r.resolution, createdAt: r.created_at,
      overdue: r.resolved_at === null && Date.parse(r.sla_due_at) < now.getTime(),
      hoursRemaining: Math.round((Date.parse(r.sla_due_at) - now.getTime()) / 3_600_000),
    }));
}

/** The operations queue that makes the SLA real. */
export function overdueRequests(db: Db, now = new Date()): DpdpRequest[] {
  return db.prepare<[string], { account_id: string }>(
    "SELECT DISTINCT account_id FROM dpdp_requests WHERE resolved_at IS NULL AND sla_due_at < ?",
  ).all(now.toISOString())
    .flatMap((r) => listRequests(db, r.account_id, now).filter((x) => x.overdue));
}

export function resolveRequest(
  db: Db, requestId: string, state: 'fulfilled' | 'rejected', resolution: string,
): void {
  db.prepare('UPDATE dpdp_requests SET state = ?, resolved_at = ?, resolution = ? WHERE id = ?')
    .run(state, nowIso(), resolution, requestId);
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

export interface AccessPackage {
  accountId: string;
  generatedAt: string;
  account: { phone: string | null; displayName: string | null; formatPreference: string; createdAt: string };
  profiles: Array<{ id: string; kind: string; label: string; gstin: string | null }>;
  bills: unknown[];
  /** T-02: the owner sees every non-owner read of their data. */
  accessLog: Array<{ actorType: string; actorId: string; action: string; reason: string; at: string }>;
  consentNotice: readonly ConsentItem[];
  retentionDisclosure: string;
}

export function buildAccessPackage(db: Db, accountId: string, now = new Date()): AccessPackage {
  const account = people.getAccount(db, accountId);
  if (!account) throw new Error('account not found');

  const bills = billsRepo.listByOwner(db, accountId, { limit: 100_000 })
    .map((b) => buildBillView(db, b, { now, paginate: false }));

  ledgers.logAccess(db, {
    accountId, actorType: 'system', actorId: 'dpdp',
    action: 'access_package_generated',
    reason: 'the account holder exercised their right of access',
  });

  return {
    accountId,
    generatedAt: now.toISOString(),
    account: {
      phone: account.phoneE164, displayName: account.displayName,
      formatPreference: account.formatPreference, createdAt: account.createdAt,
    },
    profiles: people.listProfiles(db, accountId).map((p) => ({
      id: p.id, kind: p.kind, label: p.label, gstin: p.gstin,
    })),
    bills,
    accessLog: ledgers.accessLogForOwner(db, accountId, 1000).map((e) => ({
      actorType: e.actorType, actorId: e.actorId, action: e.action, reason: e.reason, at: e.createdAt,
    })),
    consentNotice: CONSENT_NOTICE,
    retentionDisclosure:
      'Each shop keeps its own copy of the bill it issued, with no link to you, for as long as tax law requires. ' +
      'Deleting your account removes your link to those bills; it does not delete the shop’s statutory copy.',
  };
}

// ---------------------------------------------------------------------------
// Erasure
// ---------------------------------------------------------------------------

export interface ErasureResult {
  accountId: string;
  billsDeIdentified: number;
  merchantCopiesRetained: number;
  retainedFields: string[];
  disclosure: string;
}

/**
 * E2 "account deleted while unclaimed bills reference it": deletion
 * de-identifies the customer link; the merchant's statutory copy persists under
 * the retention carve-out, disclosed up front.
 */
export function eraseAccount(db: Db, accountId: string, requestId?: string): ErasureResult {
  const outcome = people.deleteAccount(db, accountId);
  const plan = purgePlanFor('claimed');

  if (requestId) {
    resolveRequest(db, requestId, 'fulfilled',
      `Customer link removed from ${outcome.billsDeIdentified} bills. Merchant statutory copies retained as disclosed.`);
  }

  return {
    accountId,
    billsDeIdentified: outcome.billsDeIdentified,
    merchantCopiesRetained: outcome.merchantCopiesRetained,
    retainedFields: plan.retainedFields,
    disclosure: outcome.disclosure,
  };
}

// ---------------------------------------------------------------------------
// Consent notice
// ---------------------------------------------------------------------------

/**
 * "A plain-language itemised consent notice." Itemised means one entry per
 * purpose with its own retention — not a wall of text behind one checkbox.
 */
export function consentNotice(): {
  version: string;
  items: readonly ConsentItem[];
  optionalCount: number;
  summary: string;
} {
  return {
    version: '2026-09-01',
    items: CONSENT_NOTICE,
    optionalCount: CONSENT_NOTICE.filter((i) => i.optional).length,
    summary:
      'We keep your bills so you can find them. Shops see the bill they gave you and whether you kept it — never who you are. ' +
      'Health-related bills are handled more carefully: no shop name in notifications, not in shared views, never in analytics.',
  };
}

/**
 * E6 "law enforcement or civil subpoena": have a documented process, a
 * transparency report and minimised retention *before* the first request.
 */
export interface DisclosureRequest {
  id: string;
  authority: string;
  legalBasis: string;
  scope: string;
  receivedAt: string;
  /** Requests are narrowed before they are answered, never answered wholesale. */
  narrowedTo: string | null;
  outcome: 'pending' | 'complied_narrowed' | 'refused' | 'challenged';
  /** The owner is notified unless a court order forbids it. */
  ownerNotified: boolean;
  ownerNotificationWithheldReason: string | null;
}

export const DISCLOSURE_PROCESS = [
  'Log the request with authority, legal basis and scope before any data is looked at.',
  'Check the request is validly issued and specific. A request for "a purchase history" is not specific.',
  'Narrow to the minimum: specific bills in a specific window, never a whole account.',
  'Record the disclosure in the access log so the owner sees it.',
  'Notify the owner unless an order forbids it; record the reason if withheld.',
  'Count it in the transparency report.',
] as const;

export interface TransparencyReport {
  period: string;
  requestsReceived: number;
  requestsNarrowed: number;
  requestsRefused: number;
  accountsAffected: number;
  ownersNotified: number;
  process: readonly string[];
}

export function transparencyReport(db: Db, fromIso: string, toIso: string): TransparencyReport {
  const disclosures = db.prepare<[string, string], { n: number; accounts: number }>(
    `SELECT COUNT(*) AS n, COUNT(DISTINCT account_id) AS accounts
       FROM access_log
      WHERE action LIKE 'legal_disclosure%' AND created_at BETWEEN ? AND ?`,
  ).get(fromIso, toIso)!;

  return {
    period: `${fromIso.slice(0, 10)} to ${toIso.slice(0, 10)}`,
    requestsReceived: disclosures.n,
    requestsNarrowed: db.prepare<[string, string], { n: number }>(
      `SELECT COUNT(*) AS n FROM access_log WHERE action = 'legal_disclosure_narrowed' AND created_at BETWEEN ? AND ?`,
    ).get(fromIso, toIso)!.n,
    requestsRefused: db.prepare<[string, string], { n: number }>(
      `SELECT COUNT(*) AS n FROM access_log WHERE action = 'legal_disclosure_refused' AND created_at BETWEEN ? AND ?`,
    ).get(fromIso, toIso)!.n,
    accountsAffected: disclosures.accounts,
    ownersNotified: db.prepare<[string, string], { n: number }>(
      `SELECT COUNT(*) AS n FROM access_log WHERE action = 'legal_disclosure_owner_notified' AND created_at BETWEEN ? AND ?`,
    ).get(fromIso, toIso)!.n,
    process: DISCLOSURE_PROCESS,
  };
}
