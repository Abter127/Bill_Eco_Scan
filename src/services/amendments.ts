import type { Db } from '../db/sqlite.js';
import { nowIso, tx } from '../db/sqlite.js';
import { newId } from '../core/ids.js';
import { transition } from '../core/lifecycle.js';
import { warrantyAfterReplacement, type ReplacementWarrantyRule } from '../core/warranty.js';
import { contentFingerprint } from '../core/fingerprint.js';
import { financialYearOf } from '../core/time.js';
import type { CanonicalBill } from '../core/schema.js';
import * as billsRepo from '../db/repo/bills.js';
import * as ledgers from '../db/repo/ledgers.js';
import * as registry from '../db/repo/registry.js';

/**
 * Amendments, returns and voids (E4).
 *
 * The section heading is the rule: "Bills are immutable, so every one of these
 * is a new linked document." Nothing in this module edits an amount on an
 * existing bill; it creates a document and links it.
 */

export interface CreditNoteInput {
  /** The bill being credited. Either id, or merchant + document number. */
  originalBillId?: string;
  merchantId?: string;
  originalDocumentNumber?: string;
  financialYear?: string | null;
  documentNumber: string;
  /** Empty means the whole bill. */
  returnedLines: Array<{ lineNo: number; qty: number }>;
  amountMinor: number;
  currency?: string;
  /** The outlet processing the return, which may differ from the sale (E4). */
  outletId: string;
  now?: Date;
}

export interface CreditNoteResult {
  creditNoteId: string;
  originalBillId: string | null;
  /** 'parked' when the original has not arrived yet. */
  status: 'applied' | 'parked';
  billState: 'partially_returned' | 'fully_returned' | 'unchanged' | 'pending';
  voidedWarrantyLineNos: number[];
  exportsFlagged: number;
  message: string;
  warnings: string[];
}

export function applyCreditNote(db: Db, input: CreditNoteInput): CreditNoteResult {
  const now = input.now ?? new Date();
  const currency = input.currency ?? 'INR';
  const warnings: string[] = [];

  const original = input.originalBillId
    ? billsRepo.getBill(db, input.originalBillId)
    : input.merchantId && input.originalDocumentNumber
      ? billsRepo.findByDocumentNumber(
          db, input.merchantId, input.financialYear ?? null, input.originalDocumentNumber,
        )[0] ?? null
      : null;

  const merchantId = original?.merchantId ?? input.merchantId;
  if (!merchantId) throw new Error('credit note needs a merchant');

  return tx(db, (): CreditNoteResult => {
    const id = newId();
    const dateKey = now.toISOString().slice(0, 10);
    const fy = financialYearOf(dateKey).label;

    // A credit note is a negative document. E1: "negative bills must never be
    // counted as spend", which `countsAsSpend` on the view enforces.
    const creditNote: CanonicalBill = {
      id,
      billGroupId: original?.billGroupId ?? id,
      merchantId,
      outletId: input.outletId,
      terminalId: null,
      documentType: 'credit_note',
      documentNumber: input.documentNumber,
      financialYear: fy,
      documentDateKey: dateKey,
      documentDateAmbiguous: false,
      documentDateCandidates: [],
      terminalTime: now.toISOString(),
      serverReceiptTime: now.toISOString(),
      clockSkewMs: null,
      clockSkewFlagged: false,
      currency,
      subtotalMinor: null,
      taxTotalMinor: null,
      discountTotalMinor: null,
      roundOffMinor: null,
      grandTotalMinor: -Math.abs(input.amountMinor),
      lineSumMinor: null,
      sumDiscrepancyMinor: null,
      sumDiscrepancyFlagged: false,
      paymentMethod: original?.paymentMethod ?? null,
      buyerGstin: original?.buyerGstin ?? null,
      placeOfSupply: original?.placeOfSupply ?? null,
      provenance: 'print_stream',
      contentFingerprint: contentFingerprint({
        merchantId, outletId: input.outletId, documentNumber: input.documentNumber,
        documentDateKey: dateKey, grandTotalMinor: -Math.abs(input.amountMinor),
        currency, lines: [],
      }),
      idempotencyKey: null,
      // E4: "credit note for a bill nobody ever claimed" — it applies to the
      // unclaimed record, and a later claimant sees the full corrected history.
      state: original?.state === 'claimed' ? 'claimed' : 'unclaimed',
      ownerAccountId: original?.ownerAccountId ?? null,
      ownerProfileId: original?.ownerProfileId ?? null,
      sensitivityClass: original?.sensitivityClass ?? 'standard',
      notATaxInvoice: false,
      expensable: original?.expensable ?? true,
      isSharedCopy: false,
      imageRef: null,
      rawSourceRef: null,
      claimedAt: original?.claimedAt ?? null,
      holdExpiresAt: original?.holdExpiresAt ?? null,
      createdAt: now.toISOString(),
      lines: [],
      fields: [],
    };
    billsRepo.insertBill(db, creditNote);

    if (!original) {
      // E4: accept and park; reconcile when the original arrives, alert if it
      // never does. The merchant was offline when the return was processed.
      ledgers.createLink(db, {
        fromBillId: id,
        toBillId: null,
        toDocumentNumber: input.originalDocumentNumber ?? null,
        toMerchantId: merchantId,
        relation: 'credit_note_for',
        targetLineNos: input.returnedLines.map((l) => l.lineNo),
        now,
      });
      return {
        creditNoteId: id, originalBillId: null, status: 'parked',
        billState: 'pending', voidedWarrantyLineNos: [], exportsFlagged: 0,
        warnings: ['The bill this refund belongs to has not reached us yet. We will attach it automatically when it does.'],
        message: 'Refund recorded and waiting for its original bill.',
      };
    }

    ledgers.createLink(db, {
      fromBillId: id, toBillId: original.id, toDocumentNumber: original.documentNumber,
      toMerchantId: merchantId, relation: 'credit_note_for',
      targetLineNos: input.returnedLines.map((l) => l.lineNo),
      now,
    });

    // --- E4 partial return -------------------------------------------------
    // "Credit note references specific lines. Bill becomes partially returned;
    // warranty voids only on returned lines; the remaining return window keeps
    // running."
    const voidedWarrantyLineNos: number[] = [];
    const targets = input.returnedLines.length > 0
      ? input.returnedLines
      : original.lines.map((l) => ({ lineNo: l.lineNo, qty: l.qty }));

    for (const t of targets) {
      const line = original.lines.find((l) => l.lineNo === t.lineNo);
      if (!line) {
        warnings.push(`the refund references line ${t.lineNo}, which is not on the original bill`);
        continue;
      }
      const returned = Math.min(line.qty, line.returnedQty + t.qty);
      billsRepo.setReturnedQty(db, original.id, t.lineNo, returned);
      if (returned >= line.qty) voidedWarrantyLineNos.push(t.lineNo);
    }

    const refreshed = billsRepo.getBill(db, original.id)!;
    const fully = refreshed.lines.length > 0 && refreshed.lines.every((l) => l.returnedQty >= l.qty);
    const partially = !fully && refreshed.lines.some((l) => l.returnedQty > 0);

    // E4 "return at a different outlet": verification is at merchant level, not
    // outlet level, and both outlet identities stay on their own documents.
    if (input.outletId !== original.outletId) {
      warnings.push('This was returned at a different outlet. Both outlets are recorded on the documents.');
    }

    // --- E4: return after the bill was exported ----------------------------
    const exportsFlagged = flagAffectedExports(
      db, original.id,
      'a refund was recorded against this bill after it was exported',
    );
    if (exportsFlagged > 0) {
      warnings.push(
        `This bill was already in ${exportsFlagged} export${exportsFlagged > 1 ? 's' : ''}. ` +
        'We have flagged them — tell your accountant if they have already filed.',
      );
    }

    return {
      creditNoteId: id,
      originalBillId: original.id,
      status: 'applied',
      billState: fully ? 'fully_returned' : partially ? 'partially_returned' : 'unchanged',
      voidedWarrantyLineNos,
      exportsFlagged,
      warnings,
      message: fully
        ? 'Everything on this bill has been returned. The refund is recorded as its own document.'
        : 'Partly returned. The rest of the bill, and its return window, are unchanged.',
    };
  });
}

/**
 * E1 "sale voided seconds after printing". A claim may already exist.
 *
 * "Void is a linked cancellation document, not a delete. A claimed bill flips
 * to `cancelled`, leaves expense totals, stays in history."
 */
export interface VoidResult {
  voidDocumentId: string;
  billState: string;
  message: string;
}

export function voidBill(db: Db, billId: string, documentNumber: string, now = new Date()): VoidResult {
  return tx(db, () => {
    const original = billsRepo.getBill(db, billId);
    if (!original) throw new Error('bill not found');

    const id = newId();
    const dateKey = now.toISOString().slice(0, 10);
    const voidDoc: CanonicalBill = {
      ...original,
      id,
      billGroupId: original.billGroupId,
      documentType: 'void',
      documentNumber,
      documentDateKey: dateKey,
      financialYear: financialYearOf(dateKey).label,
      grandTotalMinor: -original.grandTotalMinor,
      contentFingerprint: contentFingerprint({
        merchantId: original.merchantId, outletId: original.outletId,
        documentNumber, documentDateKey: dateKey,
        grandTotalMinor: -original.grandTotalMinor, currency: original.currency, lines: [],
      }),
      idempotencyKey: null,
      lines: [],
      fields: [],
      createdAt: now.toISOString(),
      serverReceiptTime: now.toISOString(),
    };
    billsRepo.insertBill(db, voidDoc);
    ledgers.createLink(db, {
      fromBillId: id, toBillId: original.id, relation: 'cancels',
      toDocumentNumber: original.documentNumber, toMerchantId: original.merchantId,
    });

    billsRepo.updateBillState(db, original.id, transition(original.state, 'cancelled', { viaDocument: true }));
    flagAffectedExports(db, original.id, 'this sale was cancelled after it was exported');

    return {
      voidDocumentId: id,
      billState: 'cancelled',
      message: 'This sale was cancelled. The bill stays in your history, marked cancelled, and is not counted as spend.',
    };
  });
}

/**
 * E1 "amount changed after printing". A manual discount applied post-print, or
 * a pricing error corrected. "New amended document linked to the original. The
 * claim page shows the amendment inline, not a silently different number."
 */
export function amendBill(
  db: Db, billId: string, documentNumber: string, newGrandTotalMinor: number, now = new Date(),
): { amendmentId: string; message: string } {
  return tx(db, () => {
    const original = billsRepo.getBill(db, billId);
    if (!original) throw new Error('bill not found');

    const id = newId();
    const dateKey = now.toISOString().slice(0, 10);
    const amendment: CanonicalBill = {
      ...original,
      id,
      documentType: 'amendment',
      documentNumber,
      documentDateKey: dateKey,
      financialYear: financialYearOf(dateKey).label,
      grandTotalMinor: newGrandTotalMinor,
      contentFingerprint: contentFingerprint({
        merchantId: original.merchantId, outletId: original.outletId, documentNumber,
        documentDateKey: dateKey, grandTotalMinor: newGrandTotalMinor,
        currency: original.currency, lines: [],
      }),
      idempotencyKey: null,
      createdAt: now.toISOString(),
      serverReceiptTime: now.toISOString(),
      fields: [],
    };
    billsRepo.insertBill(db, amendment);
    ledgers.createLink(db, {
      fromBillId: id, toBillId: original.id, relation: 'amends',
      toDocumentNumber: original.documentNumber, toMerchantId: original.merchantId,
    });
    flagAffectedExports(db, original.id, 'this bill was amended after it was exported');

    return {
      amendmentId: id,
      message: 'The shop changed this bill. Both the original and the change are shown, so the history is complete.',
    };
  });
}

/**
 * E4 "exchange": a return and a new purchase, one event, two documents. Linked
 * as an exchange group so history reads as one thing, and the new item's
 * warranty starts from the exchange date.
 */
export function recordExchange(
  db: Db, returnedBillId: string, newBillId: string, now = new Date(),
): { groupId: string; newWarrantyStartDateKey: string; message: string } {
  return tx(db, () => {
    const returned = billsRepo.getBill(db, returnedBillId);
    const fresh = billsRepo.getBill(db, newBillId);
    if (!returned || !fresh) throw new Error('both bills must exist');

    ledgers.createLink(db, { fromBillId: newBillId, toBillId: returnedBillId, relation: 'exchange_of' });
    db.prepare('UPDATE bills SET bill_group_id = ? WHERE id = ?').run(returned.billGroupId, newBillId);

    return {
      groupId: returned.billGroupId,
      newWarrantyStartDateKey: fresh.documentDateKey ?? now.toISOString().slice(0, 10),
      message: 'Recorded as an exchange. The new item’s warranty starts from today, not from the original purchase.',
    };
  });
}

/**
 * E4 "warranty replacement": new unit, new serial, old bill. Whether the
 * warranty restarts or continues varies by manufacturer (open decision §9.03),
 * so we record the replacement, show the rule's source, and allow an override.
 */
export interface ReplacementResult {
  billId: string;
  lineNo: number;
  newSerialNumber: string;
  rule: ReplacementWarrantyRule;
  warrantyStartDateKey: string;
  warrantyEndDateKey: string;
  sourceLabel: string;
  message: string;
}

export function recordWarrantyReplacement(
  db: Db,
  billId: string,
  lineNo: number,
  newSerialNumber: string,
  replacementDateKey: string,
  warrantyMonths: number,
  rule?: ReplacementWarrantyRule,
): ReplacementResult {
  const bill = billsRepo.getBill(db, billId);
  if (!bill) throw new Error('bill not found');
  const line = bill.lines.find((l) => l.lineNo === lineNo);
  if (!line) throw new Error('line not found');

  const w = warrantyAfterReplacement(
    bill.documentDateKey ?? replacementDateKey, replacementDateKey, warrantyMonths, rule,
  );

  db.prepare('UPDATE bill_lines SET serial_number = ? WHERE bill_id = ? AND line_no = ?')
    .run(newSerialNumber, billId, lineNo);

  const summary =
    `Warranty replacement on line ${lineNo}: new serial ${newSerialNumber} on ${replacementDateKey} (${w.rule})`;

  // An annotation belongs to an account. On a bill nobody has claimed yet there
  // is no account to attach it to, so the event is recorded where it does
  // belong — the audit log, which the eventual claimant can also read.
  if (bill.ownerAccountId) {
    ledgers.addAnnotation(db, bill.billGroupId, bill.ownerAccountId, 'note', summary);
  }
  ledgers.logAccess(db, {
    billId, accountId: bill.ownerAccountId, actorType: 'merchant', actorId: bill.merchantId,
    action: 'warranty_replacement', reason: summary,
  });

  return {
    billId, lineNo, newSerialNumber, rule: w.rule,
    warrantyStartDateKey: w.startDateKey, warrantyEndDateKey: w.endDateKey,
    sourceLabel: w.sourceLabel,
    message: 'Replacement recorded. Check the warranty rule below — manufacturers differ, and you can change it.',
  };
}

/**
 * E1 "one shop, two legal entities": restaurant and bar on separate GSTINs,
 * one meal, two bills. A linked bill group makes a single visit read as one
 * event with two tax documents.
 */
export function groupVisit(db: Db, billIds: string[]): { groupId: string; message: string } {
  if (billIds.length < 2) throw new Error('a visit group needs at least two bills');
  return tx(db, () => {
    const first = billsRepo.getBill(db, billIds[0]!);
    if (!first) throw new Error('bill not found');
    const groupId = first.billGroupId;

    for (const id of billIds.slice(1)) {
      db.prepare('UPDATE bills SET bill_group_id = ? WHERE id = ?').run(groupId, id);
      ledgers.createLink(db, { fromBillId: id, toBillId: billIds[0]!, relation: 'visit_group' });
    }
    return {
      groupId,
      message: 'These bills are from one visit. They stay separate tax documents but read as one event in your history.',
    };
  });
}

/**
 * E4 "return after the bill was exported": flag the affected export and notify.
 * "Silent divergence between your record and their books loses a business user
 * permanently."
 */
export function flagAffectedExports(db: Db, billId: string, reason: string): number {
  return db.prepare(
    `UPDATE exports SET stale = 1, stale_reason = ?
      WHERE stale = 0 AND bill_ids LIKE '%' || ? || '%'`,
  ).run(reason, billId).changes;
}

/**
 * The sweep that satisfies E4's "alert if it never does". Orphan amendments
 * older than the threshold are surfaced in the merchant console.
 */
export function orphanAmendmentAlerts(db: Db, olderThanDays = 3, now = new Date()) {
  const cutoff = new Date(now.getTime() - olderThanDays * 86_400_000).toISOString();
  return ledgers.staleOrphanLinks(db, cutoff).map((link) => ({
    linkId: link.id,
    relation: link.relation,
    awaitingDocumentNumber: link.toDocumentNumber,
    merchantId: link.toMerchantId,
    merchantName: link.toMerchantId ? registry.getMerchant(db, link.toMerchantId)?.legalName ?? null : null,
    createdAt: link.createdAt,
    message: `A ${link.relation.replace(/_/g, ' ')} has been waiting ${olderThanDays}+ days for bill ${link.toDocumentNumber}. It may never have been captured.`,
  }));
}

export { nowIso };
