import type { Db } from '../sqlite.js';
import { boolToInt, intToBool, nowIso } from '../sqlite.js';
import { newId, hashToken } from '../../core/ids.js';
import { isValidGstin } from '../../core/gstin.js';
import { classifySensitivity } from '../../core/sensitivity.js';
import type { Merchant, Outlet } from '../../core/schema.js';

interface MerchantRow {
  id: string; gstin: string | null; legal_name: string; trade_name: string | null;
  category: string; gstin_verified: number; verified_badge: number;
  successor_merchant_id: string | null; state: string;
  return_window_days: number | null; return_policy_source: string | null;
  sensitivity_class: string; created_at: string;
}

function toMerchant(r: MerchantRow): Merchant & { sensitivityClass: string } {
  return {
    id: r.id, gstin: r.gstin, legalName: r.legal_name, tradeName: r.trade_name,
    category: r.category, gstinVerified: intToBool(r.gstin_verified),
    verifiedBadge: intToBool(r.verified_badge), successorMerchantId: r.successor_merchant_id,
    state: r.state as Merchant['state'], returnWindowDays: r.return_window_days,
    returnPolicySource: r.return_policy_source, createdAt: r.created_at,
    sensitivityClass: r.sensitivity_class,
  };
}

export interface CreateMerchantInput {
  gstin?: string | null;
  legalName: string;
  tradeName?: string | null;
  category?: string;
  returnWindowDays?: number | null;
  returnPolicySource?: string | null;
}

/**
 * E5 "fake merchant onboards": GSTIN verification at onboarding is the first
 * of the three defences (the others are velocity anomaly detection and the
 * verification badge the customer can see on the bill).
 */
export function createMerchant(db: Db, input: CreateMerchantInput): Merchant & { sensitivityClass: string } {
  const gstin = input.gstin?.trim().toUpperCase() || null;
  const verified = gstin ? isValidGstin(gstin) : false;
  const category = input.category ?? 'general';
  const { sensitivityClass } = classifySensitivity(category, input.tradeName ?? input.legalName);

  const id = newId();
  db.prepare(`INSERT INTO merchants
    (id, gstin, legal_name, trade_name, category, gstin_verified, verified_badge,
     successor_merchant_id, state, return_window_days, return_policy_source,
     sensitivity_class, created_at)
    VALUES (?,?,?,?,?,?,?,NULL,'active',?,?,?,?)`)
    .run(
      id, gstin, input.legalName, input.tradeName ?? null, category,
      boolToInt(verified), boolToInt(verified),
      input.returnWindowDays ?? null, input.returnPolicySource ?? null,
      sensitivityClass, nowIso(),
    );
  return getMerchant(db, id)!;
}

export function getMerchant(db: Db, id: string): (Merchant & { sensitivityClass: string }) | null {
  const r = db.prepare<[string], MerchantRow>('SELECT * FROM merchants WHERE id = ?').get(id);
  return r ? toMerchant(r) : null;
}

/**
 * E3: resolve on GSTIN, never on trade name. "Sharma General Store" and
 * "SHARMA ENTERPRISES PVT LTD" are one merchant; splitting them would scatter
 * a customer's history across two shops that are the same shop.
 */
export function resolveMerchantByGstin(db: Db, gstin: string): (Merchant & { sensitivityClass: string }) | null {
  const r = db.prepare<[string], MerchantRow>('SELECT * FROM merchants WHERE gstin = ?')
    .get(gstin.trim().toUpperCase());
  return r ? toMerchant(r) : null;
}

/** Name lookup is a display-layer convenience and never creates a merchant. */
export function findMerchantsByName(db: Db, name: string, limit = 5): Array<Merchant & { sensitivityClass: string }> {
  const like = `%${name.trim().toUpperCase().replace(/\s+/g, '%')}%`;
  return db.prepare<[string, string, number], MerchantRow>(
    `SELECT * FROM merchants
      WHERE UPPER(legal_name) LIKE ? OR UPPER(COALESCE(trade_name,'')) LIKE ?
      LIMIT ?`,
  ).all(like, like, limit).map(toMerchant);
}

/**
 * E5 "merchant changes GSTIN or re-registers": new legal entity, same shop.
 * The successor link makes history continuous for the customer while each bill
 * keeps the GSTIN it was issued under — rewriting that would falsify a tax
 * document.
 */
export function linkSuccessor(db: Db, predecessorId: string, successorId: string): void {
  db.prepare('UPDATE merchants SET successor_merchant_id = ?, state = ? WHERE id = ?')
    .run(successorId, 'departed', predecessorId);
}

export function resolveCurrentMerchant(db: Db, merchantId: string): string {
  const seen = new Set<string>();
  let current = merchantId;
  for (;;) {
    if (seen.has(current)) return current; // defensive: cycle
    seen.add(current);
    const r = db.prepare<[string], { successor_merchant_id: string | null }>(
      'SELECT successor_merchant_id FROM merchants WHERE id = ?',
    ).get(current);
    if (!r?.successor_merchant_id) return current;
    current = r.successor_merchant_id;
  }
}

/** E5: departing the platform never affects the readability of issued bills. */
export function markMerchantDeparted(db: Db, merchantId: string): void {
  db.prepare("UPDATE merchants SET state = 'departed' WHERE id = ?").run(merchantId);
}

// ---------------------------------------------------------------------------
// Outlets and terminals
// ---------------------------------------------------------------------------

export function createOutlet(db: Db, merchantId: string, name: string, city?: string | null): Outlet {
  const id = newId();
  db.prepare("INSERT INTO outlets (id, merchant_id, name, city, state, created_at) VALUES (?,?,?,?,'active',?)")
    .run(id, merchantId, name, city ?? null, nowIso());
  return getOutlet(db, id)!;
}

export function getOutlet(db: Db, id: string): Outlet | null {
  const r = db.prepare<[string], {
    id: string; merchant_id: string; name: string; city: string | null; state: string; created_at: string;
  }>('SELECT * FROM outlets WHERE id = ?').get(id);
  if (!r) return null;
  return {
    id: r.id, merchantId: r.merchant_id, name: r.name, city: r.city,
    state: r.state as Outlet['state'], createdAt: r.created_at,
  };
}

/** E5: outlets close, they are never deleted; warranty contact routes upward. */
export function closeOutlet(db: Db, outletId: string): { warrantyContactMerchantId: string } {
  db.prepare("UPDATE outlets SET state = 'closed' WHERE id = ?").run(outletId);
  const outlet = getOutlet(db, outletId);
  return { warrantyContactMerchantId: outlet!.merchantId };
}

export interface Terminal {
  id: string; outletId: string; label: string;
  lastHeartbeatAt: string | null; lastBillAt: string | null; state: string;
}

export function createTerminal(
  db: Db, outletId: string, label: string, secret: string,
): Terminal {
  const id = newId();
  db.prepare(`INSERT INTO terminals (id, outlet_id, label, secret_hash, state, created_at)
              VALUES (?,?,?,?,'active',?)`)
    .run(id, outletId, label, hashToken(secret), nowIso());
  return getTerminal(db, id)!;
}

export function getTerminal(db: Db, id: string): Terminal | null {
  const r = db.prepare<[string], {
    id: string; outlet_id: string; label: string; last_heartbeat_at: string | null;
    last_bill_at: string | null; state: string;
  }>('SELECT id, outlet_id, label, last_heartbeat_at, last_bill_at, state FROM terminals WHERE id = ?').get(id);
  if (!r) return null;
  return {
    id: r.id, outletId: r.outlet_id, label: r.label,
    lastHeartbeatAt: r.last_heartbeat_at, lastBillAt: r.last_bill_at, state: r.state,
  };
}

export function authenticateTerminal(db: Db, terminalId: string, secret: string): Terminal | null {
  const r = db.prepare<[string, string], { id: string }>(
    "SELECT id FROM terminals WHERE id = ? AND secret_hash = ? AND state = 'active'",
  ).get(terminalId, hashToken(secret));
  return r ? getTerminal(db, r.id) : null;
}

/** M-04: credential rotation without a site visit. */
export function rotateTerminalSecret(db: Db, terminalId: string, newSecret: string): void {
  db.prepare('UPDATE terminals SET secret_hash = ?, secret_rotated_at = ? WHERE id = ?')
    .run(hashToken(newSecret), nowIso(), terminalId);
}

export function recordHeartbeat(db: Db, terminalId: string, at = nowIso()): void {
  db.prepare('UPDATE terminals SET last_heartbeat_at = ? WHERE id = ?').run(at, terminalId);
}

export function recordBillSeen(db: Db, terminalId: string, at = nowIso()): void {
  db.prepare('UPDATE terminals SET last_bill_at = ?, last_heartbeat_at = ? WHERE id = ?')
    .run(at, at, terminalId);
}

/**
 * E1 "print succeeded, capture failed". The agent crashed or was unplugged;
 * paper exists and no digital record does. The console must say so — the
 * customer's retroactive photograph (C-03) is the recovery, but only if the
 * merchant knows to expect it.
 */
export const HEARTBEAT_GAP_WARNING_MS = 10 * 60 * 1000;

export interface CaptureGap {
  terminalId: string;
  label: string;
  lastHeartbeatAt: string | null;
  gapMinutes: number | null;
  severity: 'ok' | 'warning' | 'down';
}

export function captureGaps(db: Db, outletId: string, now = new Date()): CaptureGap[] {
  const rows = db.prepare<[string], {
    id: string; label: string; last_heartbeat_at: string | null;
  }>("SELECT id, label, last_heartbeat_at FROM terminals WHERE outlet_id = ? AND state = 'active'")
    .all(outletId);

  return rows.map((r) => {
    if (!r.last_heartbeat_at) {
      return { terminalId: r.id, label: r.label, lastHeartbeatAt: null, gapMinutes: null, severity: 'down' as const };
    }
    const gapMs = now.getTime() - Date.parse(r.last_heartbeat_at);
    const gapMinutes = Math.round(gapMs / 60_000);
    const severity = gapMs > HEARTBEAT_GAP_WARNING_MS * 3
      ? ('down' as const)
      : gapMs > HEARTBEAT_GAP_WARNING_MS ? ('warning' as const) : ('ok' as const);
    return { terminalId: r.id, label: r.label, lastHeartbeatAt: r.last_heartbeat_at, gapMinutes, severity };
  });
}
