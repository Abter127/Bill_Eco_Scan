import { parseAmountToMinor } from './money.js';
import { findGstin } from './gstin.js';
import { resolveAmbiguousDate, type DateOrder } from './time.js';
import type { BillLine, FieldConfidence } from './schema.js';

/**
 * Layout-aware extraction from receipt text.
 *
 * Deliberately shared by the print-stream path and the photo path. A printed
 * stream and an OCR result are both "lines of text off a receipt"; the only
 * difference is where the per-field confidence comes from. Keeping one
 * extractor means a format that parses correctly at a participating counter
 * also parses correctly from a photograph of the same shop's slip.
 *
 * The governing rule is E3's last entry — "confidently wrong, quietly relied
 * on" is the single failure mode the pipeline is designed against. So:
 *   - every field carries its own confidence, never a document-level score;
 *   - a total computed from the lines is marked `derived`, never `extracted`;
 *   - anything under the gate is flagged rather than quietly accepted.
 */

export interface TextLine {
  text: string;
  /** 0..1 from the OCR engine. Print-stream lines are exact, so 1. */
  confidence: number;
}

export interface ExtractOptions {
  /** `printed` for an intercepted stream, `extracted` for OCR output. */
  source: 'printed' | 'extracted';
  currency?: string;
  captureDate?: Date;
  merchantDateOrder?: DateOrder;
  /** Below this a field is flagged for the customer to confirm (R-01). */
  confidenceGate?: number;
}

export interface ExtractedBill {
  merchantName: string | null;
  gstin: string | null;
  documentNumber: string | null;
  documentDateKey: string | null;
  documentDateAmbiguous: boolean;
  documentDateCandidates: string[];
  timeOfDay: string | null;
  currency: string;
  subtotalMinor: number | null;
  taxTotalMinor: number | null;
  discountTotalMinor: number | null;
  roundOffMinor: number | null;
  grandTotalMinor: number | null;
  /** True when the grand total was computed from the lines, not read (E3). */
  grandTotalDerived: boolean;
  lineSumMinor: number | null;
  sumDiscrepancyMinor: number | null;
  sumDiscrepancyFlagged: boolean;
  paymentMethod: string | null;
  lines: BillLine[];
  fields: FieldConfidence[];
  /** No GSTIN, no structure — a kacha bill, not a tax invoice (E3). */
  looksHandwritten: boolean;
}

export const DEFAULT_CONFIDENCE_GATE = 0.9;

// --- label vocabularies -----------------------------------------------------

const GRAND_TOTAL_LABELS = [
  /\bGRAND\s*TOTAL\b/i, /\bNET\s*PAYABLE\b/i, /\bAMOUNT\s*PAYABLE\b/i,
  /\bNET\s*AMOUNT\b/i, /\bBILL\s*AMOUNT\b/i, /\bTOTAL\s*PAYABLE\b/i, /\bNET\s*TOTAL\b/i,
];
const SUBTOTAL_LABELS = [/\bSUB\s*-?\s*TOTAL\b/i, /\bTAXABLE\s*(?:VALUE|AMOUNT)\b/i, /\bGROSS\s*AMOUNT\b/i];
const TAX_LABELS = [/\bCGST\b/i, /\bSGST\b/i, /\bUTGST\b/i, /\bIGST\b/i, /\bCESS\b/i, /\bTAX\s*(?:AMOUNT|TOTAL)?\b/i, /\bGST\b/i];
const DISCOUNT_LABELS = [/\bDISCOUNT\b/i, /\bDISC\b/i, /\bSAVINGS?\b/i, /\bOFFER\b/i];
const ROUNDOFF_LABELS = [/\bROUND\s*-?\s*(?:OFF|ING)\b/i, /\bR\.?O\.?F\b/i];
const PLAIN_TOTAL_LABELS = [/\bTOTAL\b/i, /\bAMOUNT\b/i];
const NON_ITEM_LABELS = [
  ...GRAND_TOTAL_LABELS, ...SUBTOTAL_LABELS, ...TAX_LABELS, ...DISCOUNT_LABELS,
  ...ROUNDOFF_LABELS, ...PLAIN_TOTAL_LABELS,
  /\bCHANGE\b/i, /\bTENDER(?:ED)?\b/i, /\bCASH\b/i, /\bCARD\b/i, /\bUPI\b/i,
  /\bBALANCE\b/i, /\bGSTIN\b/i, /\bHSN\b/i, /\bSAC\b/i, /\bPHONE\b/i, /\bPH\b/i,
  /\bTHANK\s*YOU\b/i, /\bVISIT\s*AGAIN\b/i, /\bINVOICE\b/i, /\bBILL\s*NO\b/i,
  /\bDATE\b/i, /\bTIME\b/i, /\bCASHIER\b/i, /\bTERMINAL\b/i, /\bITEM\b/i, /\bQTY\b/i,
  /\bRATE\b/i, /\bDESCRIPTION\b/i, /\bPARTICULARS\b/i, /\bSAVED\b/i,
];

const PAYMENT_METHODS: Array<[RegExp, string]> = [
  [/\bUPI\b|\bGPAY\b|\bGOOGLE\s*PAY\b|\bPHONEPE\b|\bPAYTM\b|\bBHIM\b/i, 'upi'],
  [/\bCREDIT\s*CARD\b|\bVISA\b|\bMASTERCARD\b|\bAMEX\b/i, 'card_credit'],
  [/\bDEBIT\s*CARD\b|\bRUPAY\b/i, 'card_debit'],
  [/\bNET\s*BANKING\b|\bNEFT\b|\bIMPS\b|\bRTGS\b/i, 'bank_transfer'],
  [/\bWALLET\b/i, 'wallet'],
  [/\bCASH\b/i, 'cash'],
];

const DATE_IN_TEXT =
  /\b(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[\s\-/.]*[A-Za-z]{3,9}[\s\-/.]*\d{2,4})\b/;
const TIME_IN_TEXT = /\b([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?\s*(AM|PM)?\b/i;

/**
 * A printed amount, grouped or not.
 *
 * The alternation is load-bearing. A pattern of only `\d{1,3}([,\s]\d{2,3})*`
 * matches the *last three digits* of an ungrouped number when anchored to the
 * end of a line, so "GRAND TOTAL 2205.00" reads as 205.00 and "38500.00" reads
 * as 500.00 — wrong, and confident about it, which is the one failure mode E3
 * says the pipeline exists to prevent. Ungrouped totals are common on thermal
 * slips, so the plain-digits branch comes first in intent and the grouped
 * branch handles the Indian 1,23,456 convention.
 */
const AMOUNT_BODY = String.raw`(?:\d{1,3}(?:[,\s]\d{2,3})+|\d+)(?:\.\d{1,2})?`;

/** Trailing money on a line: "PANEER BUTTER MASALA      240.00" */
const TRAILING_AMOUNT = new RegExp(
  String.raw`(-?\(?\s*(?:₹|RS\.?|INR)?\s*${AMOUNT_BODY}\s*\)?-?)\s*$`,
  'i',
);
/** Quantity forms: "2 x 45.00", "2 @ 45.00", "2.500 KG x 60.00" */
const QTY_PRICE = new RegExp(
  String.raw`(?:^|\s)(\d+(?:\.\d+)?)\s*(KG|GM|G|L|ML|PC|PCS|NOS|UNIT)?\s*(?:X|@|\*)\s*(?:₹|RS\.?|INR)?\s*(${AMOUNT_BODY})`,
  'i',
);
const LEADING_QTY = /^\s*(\d+(?:\.\d+)?)\s+(?=[A-Za-zऀ-෿])/;
const HSN_IN_TEXT = /\b(?:HSN|SAC)\s*[:.]?\s*(\d{4,8})\b/i;
const SERIAL_IN_TEXT = /\b(?:S\/?N|SERIAL|IMEI)\s*[:.]?\s*([A-Z0-9-]{6,})\b/i;
const GST_RATE_IN_TEXT = /\b(\d{1,2}(?:\.\d{1,2})?)\s*%/;
/**
 * The trailing \b after the keyword group matters: without it, `INV` matches
 * inside the word `INVOICE` on a "TAX INVOICE" header line and captures "OICE"
 * as the bill number. The captured token must also contain a digit, because a
 * document number always does and a stray word never should.
 */
const DOC_NUMBER =
  /\b(?:TAX\s*INVOICE|INVOICE|BILL|INV|RECEIPT|MEMO)\b\s*(?:NO|NUMBER|#)?\s*[:.#-]?\s*([A-Z0-9][A-Z0-9/\\-]{1,24})\b/i;

/** A continuation line carrying only quantity and rate: "2 x 145.00". */
const QTY_CONTINUATION = new RegExp(
  String.raw`^\s*\d+(?:\.\d+)?\s*(?:KG|GM|G|L|ML|PC|PCS|NOS|UNIT)?\s*(?:X|@|\*)\s*(?:₹|RS\.?|INR)?\s*${AMOUNT_BODY}\s*$`,
  'i',
);

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

function amountOnLine(text: string, currency: string): number | null {
  const m = TRAILING_AMOUNT.exec(text);
  if (!m) return null;
  return parseAmountToMinor(m[1]!, currency);
}

function cleanDescription(text: string): string {
  return text
    .replace(TRAILING_AMOUNT, '')
    .replace(QTY_PRICE, ' ')
    .replace(HSN_IN_TEXT, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/[.\-_*|]{2,}/g, ' ')
    .trim();
}

export function extractBillFromText(
  input: string[] | TextLine[],
  opts: ExtractOptions,
): ExtractedBill {
  const currency = opts.currency ?? 'INR';
  const gate = opts.confidenceGate ?? DEFAULT_CONFIDENCE_GATE;
  const src = opts.source;

  const textLines: TextLine[] =
    typeof input[0] === 'string' || input.length === 0
      ? (input as string[]).map((text) => ({ text, confidence: 1 }))
      : (input as TextLine[]);

  const fields: FieldConfidence[] = [];
  const push = (
    fieldPath: string,
    confidence: number,
    originalValue: string | null,
    source: FieldConfidence['source'] = src,
    note: string | null = null,
  ) => {
    fields.push({
      fieldPath,
      source,
      confidence: source === 'printed' || source === 'user' ? null : confidence,
      originalValue,
      flagged: source === 'extracted' || source === 'derived' ? confidence < gate : false,
      note,
    });
  };

  const joined = textLines.map((l) => l.text).join('\n');
  const confidenceOf = (idx: number) => textLines[idx]?.confidence ?? 1;

  // --- merchant identity ---------------------------------------------------
  const gstin = findGstin(joined);
  if (gstin) {
    const idx = textLines.findIndex((l) => l.text.toUpperCase().includes(gstin));
    push('gstin', confidenceOf(idx), gstin);
  }

  // The trade name is the first substantial line that is not an amount, a
  // label or the GSTIN itself.
  let merchantName: string | null = null;
  for (let i = 0; i < Math.min(textLines.length, 6); i++) {
    const t = textLines[i]!.text.trim();
    if (t.length < 3) continue;
    if (gstin && t.toUpperCase().includes(gstin)) continue;
    if (matchesAny(t, NON_ITEM_LABELS)) continue;
    if (/^\d[\d\s,.\-/]*$/.test(t)) continue;
    merchantName = t.replace(/\s{2,}/g, ' ');
    push('merchantName', confidenceOf(i), merchantName);
    break;
  }

  // --- document number -----------------------------------------------------
  let documentNumber: string | null = null;
  for (let i = 0; i < textLines.length; i++) {
    const m = DOC_NUMBER.exec(textLines[i]!.text);
    if (m && m[1] && /\d/.test(m[1]) && !/^(NO|NUMBER)$/i.test(m[1])) {
      documentNumber = m[1].trim();
      push('documentNumber', confidenceOf(i), documentNumber);
      break;
    }
  }

  // --- date ----------------------------------------------------------------
  let documentDateKey: string | null = null;
  let documentDateAmbiguous = false;
  let documentDateCandidates: string[] = [];
  let timeOfDay: string | null = null;

  for (let i = 0; i < textLines.length; i++) {
    const m = DATE_IN_TEXT.exec(textLines[i]!.text);
    if (!m) continue;
    const resolved = resolveAmbiguousDate(m[1]!, {
      captureDate: opts.captureDate,
      merchantDateOrder: opts.merchantDateOrder,
    });
    if (resolved.candidates.length === 0) continue;

    documentDateKey = resolved.dateKey;
    documentDateAmbiguous = resolved.ambiguous;
    documentDateCandidates = resolved.candidates;

    // An ambiguous date is never quietly resolved: a wrong date silently voids
    // a warranty countdown and the user finds out months later (E3).
    push(
      'documentDateKey',
      resolved.ambiguous ? 0 : confidenceOf(i),
      m[1]!,
      resolved.ambiguous ? 'extracted' : src,
      resolved.ambiguous
        ? `ambiguous day/month reading; candidates ${resolved.candidates.join(' or ')}`
        : resolved.reason,
    );

    const t = TIME_IN_TEXT.exec(textLines[i]!.text);
    if (t) timeOfDay = t[0];
    break;
  }

  // --- totals --------------------------------------------------------------
  let grandTotalMinor: number | null = null;
  let grandTotalLineIdx = -1;
  let subtotalMinor: number | null = null;
  let taxTotalMinor: number | null = null;
  let discountTotalMinor: number | null = null;
  let roundOffMinor: number | null = null;
  let plainTotalMinor: number | null = null;
  let plainTotalIdx = -1;
  let taxComponents = 0;

  for (let i = 0; i < textLines.length; i++) {
    const text = textLines[i]!.text;
    const amt = amountOnLine(text, currency);
    if (amt === null) continue;

    if (matchesAny(text, GRAND_TOTAL_LABELS)) {
      // Later grand-total lines win: receipts print the final figure last.
      grandTotalMinor = amt;
      grandTotalLineIdx = i;
      continue;
    }
    if (matchesAny(text, ROUNDOFF_LABELS)) { roundOffMinor = amt; continue; }
    if (matchesAny(text, SUBTOTAL_LABELS)) { subtotalMinor = amt; continue; }
    if (matchesAny(text, DISCOUNT_LABELS)) {
      discountTotalMinor = (discountTotalMinor ?? 0) + Math.abs(amt);
      continue;
    }
    if (matchesAny(text, TAX_LABELS)) {
      taxTotalMinor = (taxTotalMinor ?? 0) + amt;
      taxComponents++;
      continue;
    }
    if (matchesAny(text, PLAIN_TOTAL_LABELS)) {
      plainTotalMinor = amt;
      plainTotalIdx = i;
    }
  }

  if (grandTotalMinor === null && plainTotalMinor !== null) {
    grandTotalMinor = plainTotalMinor;
    grandTotalLineIdx = plainTotalIdx;
  }

  if (grandTotalMinor !== null) {
    push('grandTotalMinor', confidenceOf(grandTotalLineIdx), String(grandTotalMinor));
  }
  if (subtotalMinor !== null) push('subtotalMinor', 1, String(subtotalMinor));
  if (taxTotalMinor !== null) {
    push('taxTotalMinor', 1, String(taxTotalMinor), src,
      taxComponents > 1 ? `summed from ${taxComponents} tax components` : null);
  }

  // --- line items ----------------------------------------------------------
  const lines: BillLine[] = [];
  const stopIdx = grandTotalLineIdx >= 0 ? grandTotalLineIdx : textLines.length;

  for (let i = 0; i < textLines.length; i++) {
    if (i >= stopIdx) break;
    const raw = textLines[i]!.text;
    if (raw.trim().length < 2) continue;
    if (matchesAny(raw, NON_ITEM_LABELS)) continue;
    if (gstin && raw.toUpperCase().includes(gstin)) continue;
    if (DATE_IN_TEXT.test(raw) && !TRAILING_AMOUNT.test(raw)) continue;

    const lineTotalMinor = amountOnLine(raw, currency);
    if (lineTotalMinor === null) continue;

    // Many receipts print the item and its amount on one line and the quantity
    // and rate underneath. That continuation belongs to the item above it — as
    // its own row it would be counted twice and the line sum would come out at
    // roughly double the real one.
    if (QTY_CONTINUATION.test(raw)) {
      const previous = lines[lines.length - 1];
      const qp = QTY_PRICE.exec(raw);
      if (previous && qp) {
        previous.qty = Number(qp[1]) || previous.qty;
        previous.uom = qp[2] ? qp[2].toUpperCase() : previous.uom;
        previous.unitPriceMinor = parseAmountToMinor(qp[3]!, currency);
      }
      continue;
    }

    const description = cleanDescription(raw);
    if (!description || /^[\d\s.,-]*$/.test(description)) continue;

    const qp = QTY_PRICE.exec(raw);
    let qty = 1;
    let unitPriceMinor: number | null = null;
    let uom: string | null = null;
    if (qp) {
      qty = Number(qp[1]);
      uom = qp[2] ? qp[2].toUpperCase() : null;
      unitPriceMinor = parseAmountToMinor(qp[3]!, currency);
    } else {
      const lq = LEADING_QTY.exec(raw);
      if (lq) qty = Number(lq[1]);
    }

    const hsn = HSN_IN_TEXT.exec(raw);
    const serial = SERIAL_IN_TEXT.exec(raw);
    const rate = GST_RATE_IN_TEXT.exec(raw);
    const conf = confidenceOf(i);

    const lineNo = lines.length;
    lines.push({
      lineNo,
      description,
      hsnSac: hsn ? hsn[1]! : null,
      qty: Number.isFinite(qty) && qty > 0 ? qty : 1,
      uom,
      unitPriceMinor,
      gstRateBp: rate ? Math.round(Number(rate[1]) * 100) : null,
      taxableValueMinor: null,
      cgstMinor: null,
      sgstMinor: null,
      igstMinor: null,
      cessMinor: null,
      discountMinor: null,
      lineTotalMinor,
      serialNumber: serial ? serial[1]! : null,
      warrantyMonths: null,
      returnedQty: 0,
    });
    push(`lines.${lineNo}.description`, conf, description);
    push(`lines.${lineNo}.lineTotalMinor`, conf, String(lineTotalMinor));
  }

  const lineSumMinor = lines.length > 0
    ? lines.reduce((acc, l) => acc + l.lineTotalMinor, 0)
    : null;

  // --- E3: total illegible, items readable ---------------------------------
  let grandTotalDerived = false;
  if (grandTotalMinor === null && lineSumMinor !== null) {
    grandTotalMinor = lineSumMinor + (taxTotalMinor ?? 0) - (discountTotalMinor ?? 0) + (roundOffMinor ?? 0);
    grandTotalDerived = true;
    // Presented as derived, never as read. Confidence 0 forces the flag on.
    push('grandTotalMinor', 0, null, 'derived',
      'total not legible; computed from line items — confirm against the image');
  }

  // --- E1: line totals do not sum to the grand total ------------------------
  // Never silently reconcile. Store both, flag, keep the printed total canonical.
  let sumDiscrepancyMinor: number | null = null;
  let sumDiscrepancyFlagged = false;
  if (!grandTotalDerived && grandTotalMinor !== null && lineSumMinor !== null) {
    const expected = lineSumMinor + (taxTotalMinor ?? 0) - (discountTotalMinor ?? 0) + (roundOffMinor ?? 0);
    sumDiscrepancyMinor = grandTotalMinor - expected;
    if (sumDiscrepancyMinor !== 0) {
      sumDiscrepancyFlagged = true;
      push('lineSumMinor', 1, String(lineSumMinor), 'derived',
        `line items reconcile to ${expected} but the printed total is ${grandTotalMinor}; printed total is canonical`);
    }
  }

  // --- payment method ------------------------------------------------------
  let paymentMethod: string | null = null;
  for (const [pattern, name] of PAYMENT_METHODS) {
    if (pattern.test(joined)) { paymentMethod = name; break; }
  }
  if (paymentMethod) push('paymentMethod', 1, paymentMethod);

  // --- kacha bill detection (E3) -------------------------------------------
  const looksHandwritten =
    !gstin &&
    !documentNumber &&
    lines.length <= 4 &&
    !/\b(?:CGST|SGST|IGST|HSN|SAC|TAX INVOICE)\b/i.test(joined);

  return {
    merchantName,
    gstin,
    documentNumber,
    documentDateKey,
    documentDateAmbiguous,
    documentDateCandidates,
    timeOfDay,
    currency,
    subtotalMinor,
    taxTotalMinor,
    discountTotalMinor,
    roundOffMinor,
    grandTotalMinor,
    grandTotalDerived,
    lineSumMinor,
    sumDiscrepancyMinor,
    sumDiscrepancyFlagged,
    paymentMethod,
    lines,
    fields,
    looksHandwritten,
  };
}
