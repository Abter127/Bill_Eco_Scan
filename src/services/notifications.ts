import type { Db } from '../db/sqlite.js';
import { nowIso, boolToInt } from '../db/sqlite.js';
import { newId } from '../core/ids.js';
import { formatMoney, money } from '../core/money.js';
import { notificationPreview } from '../core/sensitivity.js';
import { warrantyState, returnWindowState, shouldRemindWarranty } from '../core/warranty.js';
import * as billsRepo from '../db/repo/bills.js';
import * as registry from '../db/repo/registry.js';

/**
 * Notifications, and the leak they cause.
 *
 * E6: the lock-screen preview is "the highest-likelihood privacy incident in
 * the product". It is not a breach — the data is exactly where it should be —
 * it is an interface leak, and the fix belongs here rather than in a policy.
 *
 * Every notification in this module goes through `notificationPreview`, so
 * there is no path that emits a merchant name for a sensitive-class bill.
 */

export type NotificationKind = 'bill_ready' | 'warranty_expiring' | 'return_window_closing';

export interface SentNotification {
  id: string;
  accountId: string;
  billId: string | null;
  kind: NotificationKind;
  title: string;
  body: string;
  suppressedPreview: boolean;
  sentAt: string;
}

export function sendBillNotification(
  db: Db, accountId: string, billId: string, kind: NotificationKind,
): SentNotification | null {
  const bill = billsRepo.getBill(db, billId);
  if (!bill) return null;
  const merchant = registry.getMerchant(db, bill.merchantId);

  const preview = notificationPreview({
    sensitivityClass: bill.sensitivityClass,
    merchantDisplayName: merchant?.tradeName ?? merchant?.legalName ?? 'Your bill',
    amountLabel: formatMoney(money(bill.grandTotalMinor, bill.currency)),
    kind,
  });

  const id = newId();
  const at = nowIso();
  db.prepare(`INSERT INTO notifications
    (id, account_id, bill_id, kind, title, body, suppressed_preview, sent_at, meta)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, accountId, billId, kind, preview.title, preview.body,
      boolToInt(preview.suppressed), at,
      JSON.stringify({ includesMerchantName: preview.includesMerchantName }));

  return {
    id, accountId, billId, kind, title: preview.title, body: preview.body,
    suppressedPreview: preview.suppressed, sentAt: at,
  };
}

export function notificationsFor(db: Db, accountId: string, limit = 50): SentNotification[] {
  return db.prepare<[string, number], {
    id: string; account_id: string; bill_id: string | null; kind: string;
    title: string; body: string; suppressed_preview: number; sent_at: string;
  }>('SELECT * FROM notifications WHERE account_id = ? ORDER BY sent_at DESC LIMIT ?')
    .all(accountId, limit)
    .map((r) => ({
      id: r.id, accountId: r.account_id, billId: r.bill_id, kind: r.kind as NotificationKind,
      title: r.title, body: r.body, suppressedPreview: r.suppressed_preview === 1, sentAt: r.sent_at,
    }));
}

/**
 * R-05's acceptance criterion, as a job: "Eleven months after an appliance
 * purchase, the user is told unprompted that warranty ends next month."
 */
export interface ReminderSweepResult {
  warrantyReminders: number;
  returnWindowReminders: number;
  suppressedPreviews: number;
}

export function sweepReminders(db: Db, now = new Date()): ReminderSweepResult {
  const rows = db.prepare<[], { id: string }>(
    `SELECT id FROM bills
      WHERE owner_account_id IS NOT NULL
        AND state IN ('claimed')
        AND document_date_key IS NOT NULL`,
  ).all();

  let warrantyReminders = 0;
  let returnWindowReminders = 0;
  let suppressedPreviews = 0;

  for (const { id } of rows) {
    const bill = billsRepo.getBill(db, id);
    if (!bill?.ownerAccountId) continue;
    const merchant = registry.getMerchant(db, bill.merchantId);

    const alreadySent = db.prepare<[string, string], { kind: string }>(
      'SELECT kind FROM notifications WHERE bill_id = ? AND kind = ?',
    ).all(bill.id, 'warranty_expiring').length;

    for (const line of bill.lines) {
      const w = warrantyState(
        { line, documentDateKey: bill.documentDateKey, merchantCategory: merchant?.category ?? null },
        now,
      );
      if (alreadySent > 0) break;
      if (shouldRemindWarranty(w) !== null) {
        const sent = sendBillNotification(db, bill.ownerAccountId, bill.id, 'warranty_expiring');
        if (sent) { warrantyReminders++; if (sent.suppressedPreview) suppressedPreviews++; }
        break;
      }
    }

    const rw = returnWindowState(
      {
        documentDateKey: bill.documentDateKey,
        merchantReturnWindowDays: merchant?.returnWindowDays ?? null,
        merchantReturnPolicySource: merchant?.returnPolicySource ?? null,
      },
      now,
    );
    if (rw.open && rw.daysRemaining !== null && rw.daysRemaining <= 2) {
      const already = db.prepare<[string, string], { id: string }>(
        'SELECT id FROM notifications WHERE bill_id = ? AND kind = ?',
      ).all(bill.id, 'return_window_closing').length;
      if (already === 0) {
        const sent = sendBillNotification(db, bill.ownerAccountId, bill.id, 'return_window_closing');
        if (sent) { returnWindowReminders++; if (sent.suppressedPreview) suppressedPreviews++; }
      }
    }
  }

  return { warrantyReminders, returnWindowReminders, suppressedPreviews };
}
