import type { Db } from '../db/sqlite.js';
import { canTransition, purgePlanFor } from '../core/lifecycle.js';
import * as billsRepo from '../db/repo/bills.js';
import * as ledgers from '../db/repo/ledgers.js';
import { sweepReminders } from './notifications.js';

/**
 * Scheduled work. Each of these closes a loop the PRD opens but that nothing
 * else in the system would ever get around to.
 */

export interface HoldWindowSweepResult {
  orphaned: number;
  purged: number;
  retainedForMerchant: number;
}

/**
 * C-02's "defined hold window before purge or de-identification".
 *
 * Unclaimed bills become `orphaned` when the window elapses — still claimable,
 * because C-03 retroactive claim is what rescues every customer who scanned
 * nothing at the counter. Purge only happens after a second window, and even
 * then the merchant's statutory copy survives.
 */
export function sweepHoldWindows(
  db: Db, now = new Date(), purgeGraceDays = 30,
): HoldWindowSweepResult {
  let orphaned = 0;
  let purged = 0;
  let retainedForMerchant = 0;

  for (const bill of billsRepo.findExpiredHolds(db, now)) {
    const check = canTransition(bill.state, 'orphaned', { holdWindowElapsed: true });
    if (!check.ok) continue;
    billsRepo.updateBillState(db, bill.id, 'orphaned');
    orphaned++;
    ledgers.logAccess(db, {
      billId: bill.id, actorType: 'automated_job', actorId: 'hold-window-sweep',
      action: 'bill_orphaned',
      reason: 'the hold window elapsed without the bill being claimed; it can still be claimed retroactively',
      visibleToOwner: false,
    });
  }

  const purgeCutoff = new Date(now.getTime() - purgeGraceDays * 86_400_000).toISOString();
  const candidates = db.prepare<[string], { id: string }>(
    "SELECT id FROM bills WHERE state = 'orphaned' AND hold_expires_at <= ?",
  ).all(purgeCutoff);

  for (const { id } of candidates) {
    const bill = billsRepo.getBill(db, id);
    if (!bill) continue;
    const plan = purgePlanFor(bill.state);

    if (plan.dropCustomerVisiblePayload) {
      // Keep only what the merchant must retain; drop the rest.
      db.prepare('DELETE FROM bill_lines WHERE bill_id = ?').run(id);
      db.prepare('DELETE FROM bill_fields WHERE bill_id = ?').run(id);
      db.prepare('DELETE FROM bills_fts WHERE bill_id = ?').run(id);
      db.prepare(
        "UPDATE bills SET state = 'purged', owner_account_id = NULL, owner_profile_id = NULL, " +
        'image_ref = NULL, raw_source_ref = NULL, buyer_gstin = NULL WHERE id = ?',
      ).run(id);
      purged++;
    }
    if (plan.retainMerchantStatutoryCopy) retainedForMerchant++;

    ledgers.logAccess(db, {
      billId: id, actorType: 'automated_job', actorId: 'purge-sweep',
      action: 'bill_purged',
      reason: `unclaimed past the hold window and grace period; retained fields: ${plan.retainedFields.join(', ')}`,
      visibleToOwner: false,
    });
  }

  return { orphaned, purged, retainedForMerchant };
}

export interface NightlyResult {
  holdWindows: HoldWindowSweepResult;
  reminders: ReturnType<typeof sweepReminders>;
  ranAt: string;
}

export function runNightly(db: Db, now = new Date()): NightlyResult {
  return {
    holdWindows: sweepHoldWindows(db, now),
    reminders: sweepReminders(db, now),
    ranAt: now.toISOString(),
  };
}
