import type { Db } from '../db/sqlite.js';
import { tx } from '../db/sqlite.js';
import { newId } from '../core/ids.js';
import { contentFingerprint } from '../core/fingerprint.js';
import { financialYearOf } from '../core/time.js';
import { classifySensitivity } from '../core/sensitivity.js';
import { isValidGstin } from '../core/gstin.js';
import type { BillLine, CanonicalBill, FieldConfidence } from '../core/schema.js';
import * as billsRepo from '../db/repo/bills.js';
import * as registry from '../db/repo/registry.js';
import * as ledgers from '../db/repo/ledgers.js';
import { resolveMerchant } from './capture.js';
import { buildBillView, type BillView } from './billview.js';

/**
 * Manual paper-bill entry (journey J2, the manual arm).
 *
 * The PRD's J2 is "pull in a paper bill from a non-participating shop". The
 * headline path is a photograph, but the manual path is the same journey and is
 * the one that stands on its own without an OCR engine or a blob store: the
 * customer types what the slip says, and it joins the same history, marked with
 * `user_manual` provenance so nobody downstream mistakes it for a document we
 * read.
 *
 * E3's rule holds here too: with no GSTIN this is a low-provenance record
 * labelled "not a tax invoice", and the merchant is resolved on GSTIN where one
 * is given rather than on the typed name.
 */

export interface ManualBillInput {
  accountId: string;
  merchantName: string;
  gstin?: string | null;
  documentNumber?: string | null;
  documentDateKey: string;
  grandTotalMinor: number;
  currency?: string;
  paymentMethod?: string | null;
  /** Optional itemisation. When present, a line-sum mismatch is flagged (E1). */
  items?: Array<{ description: string; lineTotalMinor: number; qty?: number }>;
  now?: Date;
}

export function createManualBill(db: Db, input: ManualBillInput): BillView {
  const now = input.now ?? new Date();
  const currency = input.currency ?? 'INR';
  const gstin = input.gstin?.trim().toUpperCase() || null;
  const validGstin = gstin && isValidGstin(gstin) ? gstin : null;

  return tx(db, () => {
    const { merchantId, outletId } = resolveMerchant(db, validGstin, input.merchantName);
    const merchant = registry.getMerchant(db, merchantId);

    const lines: BillLine[] = (input.items ?? []).map((item, i) => ({
      lineNo: i,
      description: item.description,
      hsnSac: null,
      qty: item.qty ?? 1,
      uom: null,
      unitPriceMinor: null,
      gstRateBp: null,
      taxableValueMinor: null,
      cgstMinor: null,
      sgstMinor: null,
      igstMinor: null,
      cessMinor: null,
      discountMinor: null,
      lineTotalMinor: item.lineTotalMinor,
      serialNumber: null,
      warrantyMonths: null,
      returnedQty: 0,
    }));

    const lineSumMinor = lines.length > 0 ? lines.reduce((a, l) => a + l.lineTotalMinor, 0) : null;
    // E1: keep both figures; the amount the customer entered as the total is
    // canonical, exactly as a printed grand total would be.
    const sumDiscrepancyMinor = lineSumMinor === null ? null : input.grandTotalMinor - lineSumMinor;
    const sumDiscrepancyFlagged = sumDiscrepancyMinor !== null && sumDiscrepancyMinor !== 0;

    const { sensitivityClass } = classifySensitivity(
      merchant?.category ?? null,
      merchant?.tradeName ?? merchant?.legalName ?? input.merchantName,
    );

    const id = newId();
    const fields: FieldConfidence[] = [
      {
        fieldPath: 'grandTotalMinor', source: 'user', confidence: null,
        originalValue: null, flagged: false, note: 'entered by the account holder',
      },
      {
        fieldPath: 'merchantName', source: 'user', confidence: null,
        originalValue: null, flagged: false, note: 'entered by the account holder',
      },
    ];

    const bill: CanonicalBill = {
      id,
      billGroupId: id,
      merchantId,
      outletId,
      terminalId: null,
      // No GSTIN typed in means this is not a tax invoice, whatever the amount.
      documentType: validGstin ? 'tax_invoice' : 'kacha',
      documentNumber: input.documentNumber?.trim() || null,
      financialYear: financialYearOf(input.documentDateKey).label,
      documentDateKey: input.documentDateKey,
      documentDateAmbiguous: false,
      documentDateCandidates: [],
      terminalTime: null,
      serverReceiptTime: now.toISOString(),
      clockSkewMs: null,
      clockSkewFlagged: false,
      currency,
      subtotalMinor: null,
      taxTotalMinor: null,
      discountTotalMinor: null,
      roundOffMinor: null,
      grandTotalMinor: input.grandTotalMinor,
      lineSumMinor,
      sumDiscrepancyMinor,
      sumDiscrepancyFlagged,
      paymentMethod: input.paymentMethod ?? null,
      buyerGstin: null,
      placeOfSupply: null,
      provenance: 'user_manual',
      contentFingerprint: contentFingerprint({
        merchantId, outletId, documentNumber: input.documentNumber?.trim() || null,
        documentDateKey: input.documentDateKey, grandTotalMinor: input.grandTotalMinor,
        currency, lines: lines.map((l) => ({ description: l.description, qty: l.qty, lineTotalMinor: l.lineTotalMinor })),
      }),
      idempotencyKey: null,
      state: 'claimed',
      ownerAccountId: input.accountId,
      ownerProfileId: null,
      sensitivityClass,
      // A typed record has no document behind it; it is never a tax invoice.
      notATaxInvoice: true,
      expensable: true,
      isSharedCopy: false,
      imageRef: null,
      rawSourceRef: null,
      claimedAt: now.toISOString(),
      holdExpiresAt: null,
      createdAt: now.toISOString(),
      lines,
      fields,
    };

    billsRepo.insertBill(db, bill);
    ledgers.logAccess(db, {
      billId: id, accountId: input.accountId, actorType: 'system', actorId: input.accountId,
      action: 'manual_bill_added',
      reason: 'the account holder typed in a paper bill from a non-participating shop',
    });

    return buildBillView(db, billsRepo.getBill(db, id)!, { now, paginate: false });
  });
}
