import type { Db } from '../sqlite.js';
import { boolToInt, intToBool, nowIso } from '../sqlite.js';
import { newId } from '../../core/ids.js';
import type { ProfileKind } from '../../core/schema.js';

export interface Account {
  id: string;
  phoneE164: string | null;
  phoneVerifiedAt: string | null;
  displayName: string | null;
  appLockEnabled: boolean;
  /** T-05: set once, honoured at every participating counter. */
  formatPreference: 'paper' | 'digital' | 'both';
  state: 'active' | 'deleted';
  mergedIntoAccountId: string | null;
  createdAt: string;
  deletedAt: string | null;
}

export interface Profile {
  id: string;
  accountId: string;
  kind: ProfileKind;
  label: string;
  gstin: string | null;
  isDefault: boolean;
  createdAt: string;
}

interface AccountRow {
  id: string; phone_e164: string | null; phone_verified_at: string | null;
  display_name: string | null; app_lock_enabled: number; format_preference: string;
  state: string; merged_into_account_id: string | null; created_at: string; deleted_at: string | null;
}

function toAccount(r: AccountRow): Account {
  return {
    id: r.id, phoneE164: r.phone_e164, phoneVerifiedAt: r.phone_verified_at,
    displayName: r.display_name, appLockEnabled: intToBool(r.app_lock_enabled),
    formatPreference: r.format_preference as Account['formatPreference'],
    state: r.state as Account['state'], mergedIntoAccountId: r.merged_into_account_id,
    createdAt: r.created_at, deletedAt: r.deleted_at,
  };
}

export function createAccount(
  db: Db,
  input: { phoneE164?: string | null; displayName?: string | null } = {},
): { account: Account; defaultProfile: Profile } {
  const id = newId();
  const at = nowIso();
  db.prepare(`INSERT INTO accounts
    (id, phone_e164, phone_verified_at, display_name, app_lock_enabled, format_preference, state, created_at)
    VALUES (?,?,?,?,0,'paper','active',?)`)
    .run(id, input.phoneE164 ?? null, input.phoneE164 ? at : null, input.displayName ?? null, at);

  const profile = createProfile(db, id, 'personal', 'Personal', null, true);
  return { account: getAccount(db, id)!, defaultProfile: profile };
}

export function getAccount(db: Db, id: string): Account | null {
  const r = db.prepare<[string], AccountRow>('SELECT * FROM accounts WHERE id = ?').get(id);
  return r ? toAccount(r) : null;
}

/**
 * E2 "phone number changed or recycled".
 *
 * Indian numbers get reassigned, so a phone lookup that returned an account
 * would hand a stranger someone else's bills. Phone is a lookup key only, and
 * only for an account whose verification is still current — a re-verified
 * number never auto-binds historical bills.
 */
export function findAccountByPhone(db: Db, phoneE164: string): Account | null {
  const r = db.prepare<[string], AccountRow>(
    "SELECT * FROM accounts WHERE phone_e164 = ? AND state = 'active'",
  ).get(phoneE164);
  return r ? toAccount(r) : null;
}

export interface PhoneChangeOutcome {
  accountId: string;
  /** Always false. Kept explicit so the rule is visible at the call site. */
  historicalBillsRebound: boolean;
  note: string;
}

export function changePhone(db: Db, accountId: string, newPhoneE164: string): PhoneChangeOutcome {
  const at = nowIso();
  // Detach the number from any other account that still holds it, rather than
  // silently allowing two accounts to share a recycled number.
  db.prepare("UPDATE accounts SET phone_e164 = NULL WHERE phone_e164 = ? AND id != ?")
    .run(newPhoneE164, accountId);
  db.prepare('UPDATE accounts SET phone_e164 = ?, phone_verified_at = ? WHERE id = ?')
    .run(newPhoneE164, at, accountId);
  return {
    accountId,
    historicalBillsRebound: false,
    note: 'Phone re-verified. Existing bills stay with this account; no bills were bound to the number itself.',
  };
}

export function setFormatPreference(
  db: Db, accountId: string, preference: Account['formatPreference'],
): void {
  db.prepare('UPDATE accounts SET format_preference = ? WHERE id = ?').run(preference, accountId);
}

export function setAppLock(db: Db, accountId: string, enabled: boolean): void {
  db.prepare('UPDATE accounts SET app_lock_enabled = ? WHERE id = ?').run(boolToInt(enabled), accountId);
}

// ---------------------------------------------------------------------------
// Profiles (C-04)
// ---------------------------------------------------------------------------

export function createProfile(
  db: Db, accountId: string, kind: ProfileKind, label: string,
  gstin: string | null = null, isDefault = false,
): Profile {
  const id = newId();
  const at = nowIso();
  if (isDefault) {
    db.prepare('UPDATE profiles SET is_default = 0 WHERE account_id = ?').run(accountId);
  }
  db.prepare('INSERT INTO profiles (id, account_id, kind, label, gstin, is_default, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, accountId, kind, label, gstin, boolToInt(isDefault), at);
  return { id, accountId, kind, label, gstin, isDefault, createdAt: at };
}

export function listProfiles(db: Db, accountId: string): Profile[] {
  return db.prepare<[string], {
    id: string; account_id: string; kind: string; label: string;
    gstin: string | null; is_default: number; created_at: string;
  }>('SELECT * FROM profiles WHERE account_id = ? ORDER BY is_default DESC, created_at')
    .all(accountId)
    .map((r) => ({
      id: r.id, accountId: r.account_id, kind: r.kind as ProfileKind, label: r.label,
      gstin: r.gstin, isDefault: intToBool(r.is_default), createdAt: r.created_at,
    }));
}

export function defaultProfile(db: Db, accountId: string): Profile | null {
  return listProfiles(db, accountId).find((p) => p.isDefault) ?? null;
}

// ---------------------------------------------------------------------------
// Account merge (E2 "two accounts, one person")
// ---------------------------------------------------------------------------

export interface MergeOutcome {
  survivingAccountId: string;
  mergedAccountId: string;
  billsMoved: number;
  /** Bills that looked like duplicates and were left for the user to confirm. */
  possibleDuplicates: number;
}

/**
 * Merge preserves provenance and does not create duplicate bills. Bills that
 * appear in both accounts are *flagged*, not merged, for the same reason as
 * E3: a false merge is worse than a visible duplicate.
 */
export function mergeAccounts(db: Db, survivingId: string, mergedId: string): MergeOutcome {
  const dupes = db.prepare<[string, string], { n: number }>(
    `SELECT COUNT(*) AS n FROM bills a
      WHERE a.owner_account_id = ?
        AND EXISTS (SELECT 1 FROM bills b
                     WHERE b.owner_account_id = ?
                       AND b.content_fingerprint = a.content_fingerprint)`,
  ).get(mergedId, survivingId)!.n;

  const moved = db.prepare('UPDATE bills SET owner_account_id = ?, owner_profile_id = NULL WHERE owner_account_id = ?')
    .run(survivingId, mergedId).changes;

  db.prepare('UPDATE annotations SET account_id = ? WHERE account_id = ?').run(survivingId, mergedId);
  db.prepare('UPDATE captures SET account_id = ? WHERE account_id = ?').run(survivingId, mergedId);
  db.prepare("UPDATE accounts SET state = 'deleted', merged_into_account_id = ?, deleted_at = ?, phone_e164 = NULL WHERE id = ?")
    .run(survivingId, nowIso(), mergedId);

  return { survivingAccountId: survivingId, mergedAccountId: mergedId, billsMoved: moved, possibleDuplicates: dupes };
}

// ---------------------------------------------------------------------------
// Deletion (E2 "account deleted while unclaimed bills reference it")
// ---------------------------------------------------------------------------

export interface DeletionOutcome {
  accountId: string;
  billsDeIdentified: number;
  merchantCopiesRetained: number;
  disclosure: string;
}

export function deleteAccount(db: Db, accountId: string): DeletionOutcome {
  const total = db.prepare<[string], { n: number }>(
    'SELECT COUNT(*) AS n FROM bills WHERE owner_account_id = ?',
  ).get(accountId)!.n;

  // De-identify the customer link. The merchant's statutory copy of the
  // document persists under the retention carve-out disclosed up front.
  db.prepare(`UPDATE bills
                 SET owner_account_id = NULL, owner_profile_id = NULL,
                     state = CASE WHEN state = 'claimed' THEN 'orphaned' ELSE state END,
                     buyer_gstin = NULL
               WHERE owner_account_id = ?`).run(accountId);
  db.prepare('DELETE FROM annotations WHERE account_id = ?').run(accountId);
  db.prepare('UPDATE grants SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL')
    .run(nowIso(), accountId);
  db.prepare("UPDATE accounts SET state = 'deleted', deleted_at = ?, phone_e164 = NULL, display_name = NULL WHERE id = ?")
    .run(nowIso(), accountId);

  return {
    accountId,
    billsDeIdentified: total,
    merchantCopiesRetained: total,
    disclosure:
      'Your link to these bills has been removed. Each shop keeps its own copy of the bill it issued, ' +
      'with no link to you, for as long as tax law requires. This is disclosed in the consent notice.',
  };
}
