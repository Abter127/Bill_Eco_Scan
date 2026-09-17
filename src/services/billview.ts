import type { Db } from '../db/sqlite.js';
import { formatMoney, money, toDecimalString } from '../core/money.js';
import { applyConfidenceGate, gateFor, hasUserEditedAmount } from '../core/confidence.js';
import { provenanceBadge } from '../core/provenance.js';
import { returnWindowState, warrantyState, type ReturnWindowState, type WarrantyState } from '../core/warranty.js';
import { shortRef } from '../core/ids.js';
import type { CanonicalBill } from '../core/schema.js';
import * as registry from '../db/repo/registry.js';
import * as ledgers from '../db/repo/ledgers.js';

/**
 * The read model behind the claim page (C-01) and the bill detail screen.
 *
 * Everything the PRD says must be *visible* is assembled here rather than in a
 * template, so the claim page, the history view and the export all show the
 * same provenance, the same flags and the same countdown.
 */

export interface FlaggedField {
  fieldPath: string;
  label: string;
  /** What we read, so the user can compare against the image. */
  value: string | null;
  note: string | null;
  blocking: boolean;
  source: string;
}

export interface BillView {
  id: string;
  shortRef: string;
  merchant: {
    id: string;
    displayName: string;
    legalName: string;
    gstin: string | null;
    /** E5: the badge the customer can see, for fake-merchant defence. */
    verified: boolean;
    departed: boolean;
    successorMerchantId: string | null;
  };
  outlet: { id: string; name: string; city: string | null; closed: boolean };
  documentType: string;
  documentNumber: string | null;
  financialYear: string | null;
  documentDateKey: string | null;
  dateAmbiguous: boolean;
  dateCandidates: string[];
  currency: string;
  totals: {
    subtotal: string | null;
    tax: string | null;
    discount: string | null;
    roundOff: string | null;
    grandTotal: string;
    grandTotalMinor: number;
    /** E1: shown alongside, never reconciled into the total. */
    lineSum: string | null;
    sumDiscrepancy: string | null;
    sumDiscrepancyFlagged: boolean;
  };
  paymentMethod: string | null;
  state: string;
  provenance: { key: string; label: string; detail: string; tone: string };
  /** E3: a kacha bill is labelled clearly as not a tax invoice. */
  notATaxInvoice: boolean;
  expensable: boolean;
  sensitive: boolean;
  /** E1: zero-value bills still carry warranty; negatives are never spend. */
  countsAsSpend: boolean;
  lines: Array<{
    lineNo: number;
    description: string;
    hsnSac: string | null;
    qty: number;
    uom: string | null;
    lineTotal: string;
    lineTotalMinor: number;
    serialNumber: string | null;
    returnedQty: number;
    returned: boolean;
    warranty: WarrantyState | null;
  }>;
  /** E1: a 400-line wholesale bill paginates rather than rendering whole. */
  lineCount: number;
  paginated: boolean;
  flaggedFields: FlaggedField[];
  blockingFieldCount: number;
  userEditedAmounts: boolean;
  returnWindow: ReturnWindowState;
  links: Array<{ relation: string; billId: string | null; documentNumber: string | null; resolved: boolean }>;
  annotations: Array<{ kind: string; value: string }>;
  imageRef: string | null;
  clockSkewFlagged: boolean;
  warnings: string[];
}

/** E1: above this the claim page paginates its line items. */
export const LINE_PAGINATION_THRESHOLD = 40;

export interface BuildViewOptions {
  now?: Date;
  /** Render only the first page of lines (claim page default). */
  paginate?: boolean;
  linePageSize?: number;
}

export function buildBillView(db: Db, bill: CanonicalBill, opts: BuildViewOptions = {}): BillView {
  const now = opts.now ?? new Date();
  const merchant = registry.getMerchant(db, bill.merchantId);
  const outlet = registry.getOutlet(db, bill.outletId);
  const gate = applyConfidenceGate(bill.fields);
  const warnings: string[] = [];

  const fmt = (minor: number | null): string | null =>
    minor === null ? null : formatMoney(money(minor, bill.currency));

  if (bill.sumDiscrepancyFlagged) {
    warnings.push(
      'The item amounts on this bill do not add up to the printed total. We have kept both figures; the printed total is the one the shop charged.',
    );
  }
  if (bill.clockSkewFlagged) {
    warnings.push('The till’s clock did not match ours when this bill arrived, so we recorded both times.');
  }
  if (bill.documentDateAmbiguous) {
    warnings.push(
      `The date on this bill could be read two ways (${bill.documentDateCandidates.join(' or ')}). Confirm it so the return and warranty countdowns are right.`,
    );
  }
  if (bill.notATaxInvoice) {
    warnings.push('This is a receipt, not a GST tax invoice. It cannot be used to claim input tax credit.');
  }
  if (merchant?.state === 'departed') {
    warnings.push('This shop no longer uses Billing Hub. Your bill stays here and stays exportable.');
  }
  if (outlet?.state === 'closed') {
    warnings.push('This outlet has closed. Warranty and returns are handled by the parent business.');
  }

  const lineLimit = opts.paginate === false
    ? bill.lines.length
    : Math.min(bill.lines.length, opts.linePageSize ?? LINE_PAGINATION_THRESHOLD);

  const lines = bill.lines.slice(0, lineLimit).map((l) => {
    const w = warrantyState(
      { line: l, documentDateKey: bill.documentDateKey, merchantCategory: merchant?.category ?? null },
      now,
    );
    return {
      lineNo: l.lineNo,
      description: l.description,
      hsnSac: l.hsnSac,
      qty: l.qty,
      uom: l.uom,
      lineTotal: formatMoney(money(l.lineTotalMinor, bill.currency)),
      lineTotalMinor: l.lineTotalMinor,
      serialNumber: l.serialNumber,
      returnedQty: l.returnedQty,
      returned: l.returnedQty > 0,
      warranty: w.applicable ? w : null,
    };
  });

  const flaggedFields: FlaggedField[] = gate.flagged.map((f) => ({
    fieldPath: f.fieldPath,
    label: gateFor(f.fieldPath).label,
    value: f.originalValue,
    note: f.note,
    blocking: gateFor(f.fieldPath).blocking,
    source: f.source,
  }));

  const fullyReturned =
    bill.lines.length > 0 && bill.lines.every((l) => l.returnedQty >= l.qty);

  return {
    id: bill.id,
    shortRef: shortRef(bill.id),
    merchant: {
      id: bill.merchantId,
      displayName: merchant?.tradeName ?? merchant?.legalName ?? 'Unknown shop',
      legalName: merchant?.legalName ?? 'Unknown',
      gstin: merchant?.gstin ?? null,
      verified: merchant?.verifiedBadge ?? false,
      departed: merchant?.state === 'departed',
      successorMerchantId: merchant?.successorMerchantId ?? null,
    },
    outlet: {
      id: bill.outletId,
      name: outlet?.name ?? 'Unknown outlet',
      city: outlet?.city ?? null,
      closed: outlet?.state === 'closed',
    },
    documentType: bill.documentType,
    documentNumber: bill.documentNumber,
    financialYear: bill.financialYear,
    documentDateKey: bill.documentDateKey,
    dateAmbiguous: bill.documentDateAmbiguous,
    dateCandidates: bill.documentDateCandidates,
    currency: bill.currency,
    totals: {
      subtotal: fmt(bill.subtotalMinor),
      tax: fmt(bill.taxTotalMinor),
      discount: fmt(bill.discountTotalMinor),
      roundOff: fmt(bill.roundOffMinor),
      grandTotal: formatMoney(money(bill.grandTotalMinor, bill.currency)),
      grandTotalMinor: bill.grandTotalMinor,
      lineSum: fmt(bill.lineSumMinor),
      sumDiscrepancy: fmt(bill.sumDiscrepancyMinor),
      sumDiscrepancyFlagged: bill.sumDiscrepancyFlagged,
    },
    paymentMethod: bill.paymentMethod,
    state: bill.state,
    provenance: { key: bill.provenance, ...provenanceBadge(bill.provenance) },
    notATaxInvoice: bill.notATaxInvoice,
    expensable: bill.expensable,
    sensitive: bill.sensitivityClass === 'sensitive',
    countsAsSpend: bill.grandTotalMinor > 0 && bill.state !== 'cancelled',
    lines,
    lineCount: bill.lines.length,
    paginated: lineLimit < bill.lines.length,
    flaggedFields,
    blockingFieldCount: gate.blocking.length,
    userEditedAmounts: hasUserEditedAmount(bill.fields),
    returnWindow: returnWindowState(
      {
        documentDateKey: bill.documentDateKey,
        merchantReturnWindowDays: merchant?.returnWindowDays ?? null,
        merchantReturnPolicySource: merchant?.returnPolicySource ?? null,
        fullyReturned,
        cancelled: bill.state === 'cancelled',
      },
      now,
    ),
    links: ledgers.linksFrom(db, bill.id).concat(ledgers.linksTo(db, bill.id)).map((l) => ({
      relation: l.relation,
      billId: l.toBillId,
      documentNumber: l.toDocumentNumber,
      resolved: l.resolved,
    })),
    annotations: ledgers.annotationsFor(db, bill.billGroupId).map((a) => ({ kind: a.kind, value: a.value })),
    imageRef: bill.imageRef,
    clockSkewFlagged: bill.clockSkewFlagged,
    warnings,
  };
}

/**
 * The minimal identification shown for an *expired* token (E2).
 *
 * "Expired token still resolves to a page identifying merchant, time and
 * amount, and offers retroactive claim. Never a dead 404 — the worst first
 * impression the product can make." This is #1 on the will-bite-first list.
 */
export interface MinimalBillIdentity {
  merchantDisplayName: string;
  outletName: string;
  documentDateKey: string | null;
  amount: string;
  amountDecimal: string;
  shortRef: string;
}

export function minimalIdentity(db: Db, bill: CanonicalBill): MinimalBillIdentity {
  const merchant = registry.getMerchant(db, bill.merchantId);
  const outlet = registry.getOutlet(db, bill.outletId);
  return {
    merchantDisplayName: merchant?.tradeName ?? merchant?.legalName ?? 'this shop',
    outletName: outlet?.name ?? '',
    documentDateKey: bill.documentDateKey,
    amount: formatMoney(money(bill.grandTotalMinor, bill.currency)),
    amountDecimal: toDecimalString(money(bill.grandTotalMinor, bill.currency)),
    shortRef: shortRef(bill.id),
  };
}
