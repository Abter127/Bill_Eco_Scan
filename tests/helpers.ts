import { openDb, type Db } from '../src/db/sqlite.js';
import * as registry from '../src/db/repo/registry.js';
import * as people from '../src/db/repo/people.js';
import type { OcrLine, OcrResult } from '../src/services/ocr/types.js';

/** A valid GSTIN (passes the check digit) used across the suite. */
export const TEST_GSTIN = '27AAPFU0939F1ZV';
export const TEST_GSTIN_2 = '03AABCU9603R1ZM';

export interface TestWorld {
  db: Db;
  merchantId: string;
  outletId: string;
  terminalId: string;
  terminalSecret: string;
  accountId: string;
  profileId: string;
}

export function makeWorld(opts: {
  category?: string;
  legalName?: string;
  tradeName?: string;
  gstin?: string | null;
  returnWindowDays?: number | null;
} = {}): TestWorld {
  const db = openDb({ path: ':memory:' });
  const merchant = registry.createMerchant(db, {
    gstin: opts.gstin === undefined ? TEST_GSTIN : opts.gstin,
    legalName: opts.legalName ?? 'SHARMA ENTERPRISES PRIVATE LIMITED',
    tradeName: opts.tradeName ?? 'Sharma General Store',
    category: opts.category ?? 'grocery',
    returnWindowDays: opts.returnWindowDays === undefined ? 7 : opts.returnWindowDays,
    returnPolicySource: 'Shop’s stated return policy: 7 days with the bill',
  });
  const outlet = registry.createOutlet(db, merchant.id, 'Sector 17', 'Chandigarh');
  const terminalSecret = 'till-secret-1';
  const terminal = registry.createTerminal(db, outlet.id, 'Till 1', terminalSecret);
  const { account, defaultProfile } = people.createAccount(db, { phoneE164: '+919800000001' });

  return {
    db,
    merchantId: merchant.id,
    outletId: outlet.id,
    terminalId: terminal.id,
    terminalSecret,
    accountId: account.id,
    profileId: defaultProfile.id,
  };
}

// ---------------------------------------------------------------------------
// ESC/POS stream construction
// ---------------------------------------------------------------------------

const ESC_INIT = Buffer.from([0x1b, 0x40]);
const CENTRE = Buffer.from([0x1b, 0x61, 0x01]);
const LEFT = Buffer.from([0x1b, 0x61, 0x00]);
const BOLD_ON = Buffer.from([0x1b, 0x45, 0x01]);
const BOLD_OFF = Buffer.from([0x1b, 0x45, 0x00]);
export const CUT = Buffer.from([0x1d, 0x56, 0x42, 0x00]);

function text(s: string): Buffer {
  return Buffer.from(`${s}\n`, 'utf8');
}

export interface ReceiptSpec {
  merchantName?: string;
  gstin?: string | null;
  billNumber?: string | null;
  dateText?: string;
  timeText?: string;
  items?: Array<{ name: string; qty?: number; rate?: number; amount: number; hsn?: string; serial?: string }>;
  taxLines?: Array<{ label: string; amount: number }>;
  subtotal?: number | null;
  discount?: number | null;
  roundOff?: number | null;
  /** Overrides the computed total, for the line-sum-mismatch case. */
  total: number;
  totalLabel?: string;
  payment?: string;
  banner?: string | null;
  footer?: string | null;
  /** Omit the cut so the fragment is structurally invalid. */
  noCut?: boolean;
}

function amt(n: number): string {
  return n.toFixed(2);
}

function pad(left: string, right: string, width = 40): string {
  const space = Math.max(1, width - left.length - right.length);
  return `${left}${' '.repeat(space)}${right}`;
}

/** Builds a realistic Indian retail ESC/POS slip. */
export function escposReceipt(spec: ReceiptSpec): Buffer {
  const parts: Buffer[] = [ESC_INIT, CENTRE, BOLD_ON];
  parts.push(text(spec.merchantName ?? 'Sharma General Store'));
  parts.push(BOLD_OFF);
  parts.push(text('Sector 17, Chandigarh'));
  if (spec.gstin !== null) parts.push(text(`GSTIN: ${spec.gstin ?? TEST_GSTIN}`));
  if (spec.banner) parts.push(text(spec.banner));
  parts.push(LEFT);
  parts.push(text('TAX INVOICE'));
  if (spec.billNumber !== null) parts.push(text(`Bill No: ${spec.billNumber ?? 'INV/2026/0417'}`));
  parts.push(text(`Date: ${spec.dateText ?? '17/09/2026'}  Time: ${spec.timeText ?? '19:42'}`));
  parts.push(text('-'.repeat(40)));
  parts.push(text(pad('ITEM', 'AMOUNT')));
  parts.push(text('-'.repeat(40)));

  for (const item of spec.items ?? [{ name: 'Basmati Rice 5kg', qty: 1, rate: 620, amount: 620 }]) {
    const qtyPart = item.qty && item.rate ? `  ${item.qty} x ${amt(item.rate)}` : '';
    parts.push(text(pad(item.name, amt(item.amount))));
    if (qtyPart) parts.push(text(qtyPart));
    if (item.hsn) parts.push(text(`  HSN: ${item.hsn}`));
    if (item.serial) parts.push(text(`  S/N: ${item.serial}`));
  }

  parts.push(text('-'.repeat(40)));
  if (spec.subtotal != null) parts.push(text(pad('Sub Total', amt(spec.subtotal))));
  if (spec.discount != null) parts.push(text(pad('Discount', amt(spec.discount))));
  for (const t of spec.taxLines ?? []) parts.push(text(pad(t.label, amt(t.amount))));
  if (spec.roundOff != null) parts.push(text(pad('Round Off', amt(spec.roundOff))));
  parts.push(BOLD_ON);
  parts.push(text(pad(spec.totalLabel ?? 'GRAND TOTAL', amt(spec.total))));
  parts.push(BOLD_OFF);
  parts.push(text(pad('Paid by', spec.payment ?? 'UPI')));
  parts.push(CENTRE);
  parts.push(text(spec.footer ?? 'Thank you! Visit again'));
  if (!spec.noCut) parts.push(CUT);

  return Buffer.concat(parts);
}

/** A kitchen order ticket: items and quantities, no prices anywhere. */
export function escposKot(): Buffer {
  return Buffer.concat([
    ESC_INIT, CENTRE, BOLD_ON, text('K.O.T.'), BOLD_OFF,
    LEFT, text('Table: 7   Steward: Ramesh'), text('Token No: 214'),
    text('-'.repeat(32)),
    text('2  Paneer Butter Masala'),
    text('1  Butter Naan'),
    text('3  Masala Chai'),
    text('-'.repeat(32)),
    text('19:41'),
    CUT,
  ]);
}

export function escposShiftReport(): Buffer {
  return Buffer.concat([
    ESC_INIT, CENTRE, BOLD_ON, text('Z REPORT'), BOLD_OFF, LEFT,
    text('Terminal: TILL1  Shift: Evening'),
    text(pad('No. of Bills', '84')),
    text(pad('TOTAL SALES', '48250.00')),
    text(pad('CASH DRAWER', '12400.00')),
    text(pad('Closing Balance', '12400.00')),
    CUT,
  ]);
}

export function escposQuote(): Buffer {
  return Buffer.concat([
    ESC_INIT, CENTRE, BOLD_ON, text('QUOTATION'), BOLD_OFF, LEFT,
    text(`GSTIN: ${TEST_GSTIN}`),
    text('Quote No: Q/2026/77'),
    text('Valid until: 30/09/2026'),
    text(pad('Split AC 1.5T', '38500.00')),
    text(pad('GRAND TOTAL', '38500.00')),
    text('This is not a tax invoice'),
    CUT,
  ]);
}

export function escposTestPrint(): Buffer {
  return Buffer.concat([
    ESC_INIT, CENTRE, text('*** TEST PRINT ***'), LEFT,
    text('Printer: TM-T82'), text('Status: OK'), text(pad('Sample amount', '0.00')),
    CUT,
  ]);
}

// ---------------------------------------------------------------------------
// OCR fixtures
// ---------------------------------------------------------------------------

export function ocrLines(lines: Array<[string, number]>): OcrLine[] {
  return lines.map(([text, confidence]) => ({ text, confidence }));
}

export function ocrResult(partial: Partial<OcrResult> & { lines: OcrLine[] }): OcrResult {
  return {
    scripts: ['Latn'],
    screenDetected: false,
    documentCount: 1,
    isReceipt: true,
    rejectReason: null,
    annotations: [],
    stitch: null,
    engine: 'test',
    ...partial,
  };
}

/** Turns an ESC/POS receipt into plausible OCR output at a given confidence. */
export function ocrFromReceipt(spec: ReceiptSpec, confidence = 0.97): OcrLine[] {
  const decoded = escposReceipt(spec).toString('utf8')
    // Strip the control sequences the printer would have consumed.
    .replace(/\x1b[@aE][\x00-\x02]?/g, '')
    .replace(/\x1d V[\x00-\xff]{0,2}/g, '')
    .split('\n')
    .map((l) => l.replace(/[\x00-\x1f]/g, '').trimEnd())
    .filter((l) => l.trim() !== '');
  return decoded.map((text) => ({ text, confidence }));
}
