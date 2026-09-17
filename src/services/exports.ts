import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Db } from '../db/sqlite.js';
import { nowIso } from '../db/sqlite.js';
import { newId } from '../core/ids.js';
import { financialYearOf, financialYearFromLabel, localDateKey } from '../core/time.js';
import { formatMoney, money, sumByCurrency, toDecimalString } from '../core/money.js';
import { hasUserEditedAmount } from '../core/confidence.js';
import { provenanceBadge } from '../core/provenance.js';
import { countsAsSpend } from '../core/lifecycle.js';
import type { CanonicalBill } from '../core/schema.js';
import * as billsRepo from '../db/repo/bills.js';
import * as registry from '../db/repo/registry.js';
import { makePdf, makeXlsx, toCsv, type PdfLine } from './filewriters.js';
import { buildBillView } from './billview.js';

/**
 * Export (R-06): CSV, XLSX with tax columns intact, faithful PDF. Not behind a
 * paywall in v1.
 *
 * Two PRD rules shape the output more than the format does:
 *
 *  - E7: "Tax exports default to the financial year." April-March, because a
 *    January-December export is useless to an Indian filing and getting it
 *    wrong is an instant credibility loss with the business buyer.
 *
 *  - E6: "Exports must carry provenance flags." A user can edit an extracted
 *    amount upward to inflate a reimbursement; whoever receives the export has
 *    to be able to see that, so every row carries its source and whether an
 *    amount was user-edited.
 */

export type ExportFormat = 'csv' | 'xlsx' | 'pdf';

export interface ExportRequest {
  accountId: string;
  profileId?: string | null;
  format: ExportFormat;
  /** Defaults to the current financial year (E7). */
  financialYear?: string | null;
  fromDateKey?: string | null;
  toDateKey?: string | null;
  includeSensitive?: boolean;
  now?: Date;
  outDir?: string;
}

export interface ExportResult {
  exportId: string;
  format: ExportFormat;
  financialYear: string | null;
  fromDateKey: string;
  toDateKey: string;
  billCount: number;
  /** One entry per currency. Currencies are never mixed into one total (E7). */
  totals: Array<{ currency: string; grandTotal: string; grandTotalMinor: number }>;
  fileRef: string;
  bytes: number;
  /** True when the export ran as a background job (E7: 50,000 bills). */
  async: boolean;
  warnings: string[];
}

/** E7: above this the export runs async with a download link. */
export const ASYNC_EXPORT_THRESHOLD = 2_000;

const COLUMNS = [
  'Bill ID', 'Document number', 'Document type', 'Financial year', 'Date',
  'Shop (trade name)', 'Shop (legal name)', 'GSTIN', 'Outlet', 'Place of supply',
  'Currency', 'Taxable value', 'CGST', 'SGST', 'IGST', 'Cess', 'Discount',
  'Round off', 'Total', 'Payment method', 'State', 'Counts as spend',
  'Source', 'Tax invoice', 'Amounts edited by user', 'Items',
] as const;

function billRow(db: Db, bill: CanonicalBill): Array<string | number | null> {
  const merchant = registry.getMerchant(db, bill.merchantId);
  const outlet = registry.getOutlet(db, bill.outletId);
  const dec = (v: number | null) => (v === null ? null : Number(toDecimalString(money(v, bill.currency))));

  const cgst = bill.lines.reduce((a, l) => a + (l.cgstMinor ?? 0), 0) || null;
  const sgst = bill.lines.reduce((a, l) => a + (l.sgstMinor ?? 0), 0) || null;
  const igst = bill.lines.reduce((a, l) => a + (l.igstMinor ?? 0), 0) || null;
  const cess = bill.lines.reduce((a, l) => a + (l.cessMinor ?? 0), 0) || null;

  return [
    bill.id,
    bill.documentNumber,
    bill.documentType,
    bill.financialYear,
    bill.documentDateKey,
    merchant?.tradeName ?? null,
    merchant?.legalName ?? null,
    merchant?.gstin ?? null,
    outlet?.name ?? null,
    bill.placeOfSupply,
    bill.currency,
    dec(bill.subtotalMinor),
    dec(cgst),
    dec(sgst),
    dec(igst),
    dec(cess),
    dec(bill.discountTotalMinor),
    dec(bill.roundOffMinor),
    dec(bill.grandTotalMinor),
    bill.paymentMethod,
    bill.state,
    // E1: a negative document is real but is never spend.
    countsAsSpend(bill.state) && bill.grandTotalMinor > 0 ? 'yes' : 'no',
    provenanceBadge(bill.provenance).label,
    bill.notATaxInvoice ? 'no' : 'yes',
    hasUserEditedAmount(bill.fields) ? 'yes' : 'no',
    bill.lines.map((l) => `${l.qty} x ${l.description}`).join('; '),
  ];
}

function selectBills(db: Db, req: ExportRequest): { bills: CanonicalBill[]; from: string; to: string; fy: string | null } {
  const now = req.now ?? new Date();

  let from: string;
  let to: string;
  let fy: string | null = null;

  if (req.fromDateKey && req.toDateKey) {
    from = req.fromDateKey;
    to = req.toDateKey;
  } else {
    // E7: the default is the financial year, not the calendar year.
    const year = req.financialYear
      ? financialYearFromLabel(req.financialYear)
      : financialYearOf(now);
    if (!year) throw new Error(`unrecognised financial year: ${req.financialYear}`);
    from = year.startDateKey;
    to = year.endDateKey;
    fy = year.label;
  }

  const clauses = ['owner_account_id = ?', "state != 'purged'", 'document_date_key BETWEEN ? AND ?'];
  const params: unknown[] = [req.accountId, from, to];
  if (req.profileId) { clauses.push('owner_profile_id = ?'); params.push(req.profileId); }
  // T-04: sensitive-class bills stay out unless the owner explicitly asks.
  if (!req.includeSensitive) clauses.push("sensitivity_class = 'standard'");

  const ids = db.prepare<unknown[], { id: string }>(
    `SELECT id FROM bills WHERE ${clauses.join(' AND ')} ORDER BY document_date_key, created_at`,
  ).all(...params);

  return { bills: ids.map((r) => billsRepo.getBill(db, r.id)!), from, to, fy };
}

export async function createExport(db: Db, req: ExportRequest): Promise<ExportResult> {
  const now = req.now ?? new Date();
  const { bills, from, to, fy } = selectBills(db, req);
  const warnings: string[] = [];

  if (!req.includeSensitive) {
    const hidden = db.prepare<[string, string, string], { n: number }>(
      `SELECT COUNT(*) AS n FROM bills WHERE owner_account_id = ?
        AND document_date_key BETWEEN ? AND ? AND sensitivity_class = 'sensitive'`,
    ).get(req.accountId, from, to)!.n;
    if (hidden > 0) {
      warnings.push(
        `${hidden} health-related bill${hidden > 1 ? 's are' : ' is'} not included. You can add them explicitly if you need them.`,
      );
    }
  }

  const editedCount = bills.filter((b) => hasUserEditedAmount(b.fields)).length;
  if (editedCount > 0) {
    warnings.push(
      `${editedCount} bill${editedCount > 1 ? 's have' : ' has'} amounts you corrected. The export marks these so whoever receives it can see.`,
    );
  }

  const totals = sumByCurrency(
    bills.filter((b) => countsAsSpend(b.state)).map((b) => money(b.grandTotalMinor, b.currency)),
  ).map((m) => ({ currency: m.currency, grandTotal: formatMoney(m), grandTotalMinor: m.minor }));

  const exportId = newId();
  const outDir = req.outDir ?? process.env.BILLING_HUB_EXPORT_DIR ?? './data/exports';
  const filename = `billing-hub-${fy ?? `${from}_${to}`}-${exportId.slice(0, 8)}.${req.format}`;
  const fileRef = join(outDir, filename);

  const buffer = renderExport(db, req.format, bills, { fy, from, to, now });
  await mkdir(dirname(fileRef), { recursive: true });
  await writeFile(fileRef, buffer);

  db.prepare(`INSERT INTO exports
    (id, account_id, profile_id, format, financial_year, from_date_key, to_date_key,
     bill_ids, state, stale, file_ref, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,0,?,?)`)
    .run(
      exportId, req.accountId, req.profileId ?? null, req.format, fy, from, to,
      JSON.stringify(bills.map((b) => b.id)),
      bills.length >= ASYNC_EXPORT_THRESHOLD ? 'ready_async' : 'ready',
      fileRef, nowIso(),
    );

  return {
    exportId, format: req.format, financialYear: fy, fromDateKey: from, toDateKey: to,
    billCount: bills.length, totals, fileRef, bytes: buffer.length,
    async: bills.length >= ASYNC_EXPORT_THRESHOLD, warnings,
  };
}

function renderExport(
  db: Db,
  format: ExportFormat,
  bills: CanonicalBill[],
  meta: { fy: string | null; from: string; to: string; now: Date },
): Buffer {
  const rows = bills.map((b) => billRow(db, b));

  if (format === 'csv') {
    return Buffer.from(toCsv([...COLUMNS], rows), 'utf8');
  }
  if (format === 'xlsx') {
    return makeXlsx(meta.fy ?? 'Bills', [...COLUMNS], rows as Array<Array<string | number | null>>);
  }
  return renderPdf(db, bills, meta);
}

function renderPdf(
  db: Db, bills: CanonicalBill[], meta: { fy: string | null; from: string; to: string; now: Date },
): Buffer {
  const lines: PdfLine[] = [
    { text: meta.fy ? `Financial year ${meta.fy} (April-March)` : `${meta.from} to ${meta.to}`, size: 11, bold: true },
    { text: `Generated ${localDateKey(meta.now)} - ${bills.length} bill(s)`, size: 9 },
  ];

  for (const bill of bills) {
    const view = buildBillView(db, bill, { now: meta.now, paginate: false });
    lines.push({ text: '', size: 4, gap: 8 });
    lines.push({ text: `${view.merchant.displayName} - ${view.totals.grandTotal}`, size: 12, bold: true });
    lines.push({
      text: `${view.documentDateKey ?? 'date not read'} | ${view.documentNumber ?? 'no bill number'} | ${view.outlet.name}`,
      size: 9,
    });
    if (view.merchant.gstin) lines.push({ text: `GSTIN ${view.merchant.gstin}`, size: 9 });
    lines.push({ text: `Source: ${view.provenance.label} - ${view.provenance.detail}`, size: 8 });
    if (view.notATaxInvoice) {
      lines.push({ text: 'NOT A TAX INVOICE - cannot be used for input tax credit', size: 9, bold: true });
    }
    if (view.userEditedAmounts) {
      lines.push({ text: 'Some amounts on this bill were corrected by the account holder.', size: 8, bold: true });
    }
    for (const l of view.lines) {
      lines.push({ text: `  ${l.qty} x ${l.description}${l.returned ? ' (returned)' : ''}  ${l.lineTotal}`, size: 9 });
    }
    if (view.totals.tax) lines.push({ text: `  Tax: ${view.totals.tax}`, size: 9 });
    if (view.totals.sumDiscrepancyFlagged) {
      lines.push({
        text: `  Note: item amounts total ${view.totals.lineSum}, printed total is ${view.totals.grandTotal}.`,
        size: 8,
      });
    }
  }

  return makePdf('Billing Hub - bill export', lines);
}

/** A single bill as a shareable PDF — J3 step 4 and the R-05 warranty pack. */
export function renderBillPdf(db: Db, billId: string, now = new Date()): Buffer {
  const bill = billsRepo.getBill(db, billId);
  if (!bill) throw new Error('bill not found');
  return renderPdf(db, [bill], { fy: bill.financialYear, from: bill.documentDateKey ?? '', to: bill.documentDateKey ?? '', now });
}

/**
 * R-05's one-tap warranty pack: bill + serial + date + image, in one file a
 * service centre will accept.
 */
export function renderWarrantyPack(db: Db, billId: string, lineNo: number, now = new Date()): Buffer {
  const bill = billsRepo.getBill(db, billId);
  if (!bill) throw new Error('bill not found');
  const view = buildBillView(db, bill, { now, paginate: false });
  const line = view.lines.find((l) => l.lineNo === lineNo);
  if (!line) throw new Error('line not found');

  const lines: PdfLine[] = [
    { text: 'Warranty claim pack', size: 13, bold: true },
    { text: '', size: 4, gap: 6 },
    { text: `Item: ${line.description}`, size: 11, bold: true },
    { text: `Serial number: ${line.serialNumber ?? 'not recorded on the bill'}`, size: 10 },
    { text: `Purchased: ${view.documentDateKey ?? 'date not read'}`, size: 10 },
    { text: `Warranty ends: ${line.warranty?.endDateKey ?? 'not known'}`, size: 10 },
    { text: `Warranty source: ${line.warranty?.sourceLabel ?? 'not set'}`, size: 8 },
    { text: '', size: 4, gap: 6 },
    { text: `Shop: ${view.merchant.displayName} (${view.merchant.legalName})`, size: 10 },
    { text: `GSTIN: ${view.merchant.gstin ?? 'not on the bill'}`, size: 9 },
    { text: `Outlet: ${view.outlet.name}${view.outlet.closed ? ' (closed - contact the parent business)' : ''}`, size: 9 },
    { text: `Bill number: ${view.documentNumber ?? 'not on the bill'}`, size: 9 },
    { text: `Amount paid for this item: ${line.lineTotal}`, size: 10 },
    { text: `Bill total: ${view.totals.grandTotal}`, size: 9 },
    { text: '', size: 4, gap: 6 },
    { text: `Source of this record: ${view.provenance.label} - ${view.provenance.detail}`, size: 8 },
    { text: `Reference: ${view.shortRef}`, size: 8 },
  ];
  if (view.imageRef) lines.push({ text: `Original photo on file: ${view.imageRef}`, size: 8 });

  return makePdf('Warranty claim pack', lines);
}

export interface StaleExport {
  exportId: string;
  format: string;
  financialYear: string | null;
  reason: string;
  createdAt: string;
  message: string;
}

/** E4: the accountant already filed it. Flag, and say so plainly. */
export function staleExports(db: Db, accountId: string): StaleExport[] {
  return db.prepare<[string], {
    id: string; format: string; financial_year: string | null; stale_reason: string | null; created_at: string;
  }>('SELECT id, format, financial_year, stale_reason, created_at FROM exports WHERE account_id = ? AND stale = 1')
    .all(accountId)
    .map((r) => ({
      exportId: r.id, format: r.format, financialYear: r.financial_year,
      reason: r.stale_reason ?? 'a bill in this export changed', createdAt: r.created_at,
      message:
        `The export you downloaded on ${r.created_at.slice(0, 10)} is out of date: ${r.stale_reason ?? 'a bill in it changed'}. ` +
        'Download it again, and tell your accountant if they have already filed it.',
    }));
}
