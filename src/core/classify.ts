import type { StreamClass } from './schema.js';

/**
 * Document-type classification (M-05).
 *
 * The acceptance criterion is blunt: "A restaurant's kitchen tickets never
 * appear as customer bills." It is #2 on the will-bite-first list because a
 * single restaurant pilot can flood the system in an afternoon.
 *
 * Two design rules follow from that asymmetry:
 *
 *  1. Negative markers win. "QUOTATION" or "KOT" on a slip disqualifies it as a
 *     bill even when it also has totals and a GSTIN, because the cost of
 *     ingesting a non-bill is far higher than the cost of quarantining a bill.
 *
 *  2. Unknown is never "probably a bill". Anything we cannot positively
 *     classify goes to merchant-side quarantine (E1), never to a customer.
 */

export interface ClassificationSignal {
  marker: string;
  weight: number;
  line: number;
}

export interface ClassificationResult {
  streamClass: StreamClass;
  confidence: number;
  signals: ClassificationSignal[];
  /** True when this must not be surfaced to a customer without review. */
  quarantine: boolean;
  reason: string;
}

type MarkerSet = { class: StreamClass; patterns: RegExp[]; weight: number };

/**
 * Markers are matched against upper-cased, punctuation-normalised lines so that
 * "K.O.T." and "KOT" behave the same.
 */
const DISQUALIFYING: MarkerSet[] = [
  {
    class: 'test_print',
    weight: 1,
    patterns: [/\bTEST PRINT\b/, /\bPRINTER TEST\b/, /\bSELF TEST\b/, /\bTEST MODE\b/, /\bHEX DUMP\b/],
  },
  {
    class: 'training_mode',
    weight: 1,
    patterns: [/\bTRAINING MODE\b/, /\bTRAINING RECEIPT\b/, /\bNOT A VALID SALE\b/, /\bDEMO MODE\b/, /\bSAMPLE ONLY\b/],
  },
  {
    class: 'quote',
    weight: 1,
    patterns: [
      /\bQUOTATION\b/, /\bQUOTE NO\b/, /\bESTIMATE\b/, /\bPROFORMA\b/, /\bPRO FORMA\b/,
      /\bVALID (?:UNTIL|TILL|UPTO|FOR)\b/, /\bTHIS IS NOT A TAX INVOICE\b/,
    ],
  },
  {
    class: 'delivery_challan',
    weight: 1,
    patterns: [/\bDELIVERY CHALLAN\b/, /\bCHALLAN NO\b/, /\bE ?WAY BILL\b/, /\bGOODS RECEIPT\b/, /\bDISPATCH NOTE\b/, /\bPACKING SLIP\b/],
  },
  {
    class: 'shift_report',
    weight: 1,
    patterns: [
      /\b[XZ] ?REPORT\b/, /\bSHIFT REPORT\b/, /\bDAY ?END\b/, /\bDAILY SUMMARY\b/,
      /\bCASH DRAWER\b/, /\bNO\.? OF BILLS\b/, /\bTOTAL SALES\b/, /\bOPENING BALANCE\b/, /\bCLOSING BALANCE\b/,
    ],
  },
  {
    class: 'kitchen_order_ticket',
    weight: 1,
    patterns: [
      /\bK ?O ?T\b/, /\bKITCHEN ORDER\b/, /\bKITCHEN COPY\b/, /\bORDER TICKET\b/,
      /\bSTEWARD\b/, /\bTOKEN NO\b/, /\bBOT\b/,
    ],
  },
];

const REPRINT_MARKERS = [/\bREPRINT\b/, /\bDUPLICATE\b/, /\bDUPLICATE COPY\b/, /\bCOPY OF ORIGINAL\b/];

const BILL_MARKERS: Array<{ pattern: RegExp; weight: number; name: string }> = [
  { pattern: /\bTAX INVOICE\b/, weight: 3, name: 'tax-invoice-header' },
  { pattern: /\bINVOICE\b/, weight: 2, name: 'invoice-header' },
  { pattern: /\bBILL OF SUPPLY\b/, weight: 3, name: 'bill-of-supply-header' },
  { pattern: /\bRETAIL INVOICE\b/, weight: 3, name: 'retail-invoice-header' },
  { pattern: /\bGSTIN\b/, weight: 2, name: 'gstin-label' },
  { pattern: /\b(?:CGST|SGST|IGST)\b/, weight: 2, name: 'gst-split' },
  { pattern: /\bHSN\b|\bSAC\b/, weight: 1, name: 'hsn-sac' },
  { pattern: /\b(?:GRAND TOTAL|NET (?:PAYABLE|AMOUNT|TOTAL)|AMOUNT PAYABLE|TOTAL AMOUNT)\b/, weight: 3, name: 'grand-total-label' },
  { pattern: /\bTOTAL\b/, weight: 1, name: 'total-label' },
  { pattern: /\b(?:BILL NO|INVOICE NO|INV NO|RECEIPT NO)\b/, weight: 2, name: 'document-number' },
  { pattern: /\b(?:CASH|CARD|UPI|PAYTM|GPAY|PHONEPE|RUPAY|CREDIT CARD|DEBIT CARD)\b/, weight: 1, name: 'payment-method' },
  { pattern: /\bTHANK YOU\b|\bVISIT AGAIN\b/, weight: 1, name: 'closing-courtesy' },
];

const CREDIT_MARKERS = [/\bCREDIT NOTE\b/, /\bREFUND (?:VOUCHER|SLIP|RECEIPT)\b/, /\bRETURN NOTE\b/];
const VOID_MARKERS = [/\bVOID(?:ED)?\b/, /\bCANCELLED BILL\b/, /\bBILL CANCELLED\b/, /\bTRANSACTION CANCELLED\b/];

const MONEY_LINE = /(?:^|\s)(?:₹|RS\.?|INR)?\s*\d{1,3}(?:[,\s]\d{2,3})*(?:\.\d{1,2})?\s*$/;

function normalizeLine(line: string): string {
  return line
    .toUpperCase()
    .replace(/[.\-_*|]+/g, (m) => (m.length > 2 ? ' ' : ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * `minBillScore` is the positive evidence required before a slip is treated as
 * a customer bill. Tuned so a bare "TOTAL 120.00" slip with nothing else does
 * not qualify on its own.
 */
export interface ClassifyOptions {
  minBillScore?: number;
}

export function classifyDocument(
  lines: string[],
  opts: ClassifyOptions = {},
): ClassificationResult {
  const minBillScore = opts.minBillScore ?? 5;
  const normalized = lines.map(normalizeLine);
  const signals: ClassificationSignal[] = [];

  // --- Pass 1: disqualifying markers. These beat everything. ---------------
  for (const set of DISQUALIFYING) {
    for (let i = 0; i < normalized.length; i++) {
      for (const p of set.patterns) {
        if (p.test(normalized[i]!)) {
          signals.push({ marker: `${set.class}:${p.source}`, weight: set.weight, line: i });
          return {
            streamClass: set.class,
            confidence: 0.95,
            signals,
            quarantine: true,
            reason: `disqualifying marker for ${set.class} on line ${i}`,
          };
        }
      }
    }
  }

  // --- Pass 2: positive bill evidence --------------------------------------
  let score = 0;
  const seen = new Set<string>();
  for (let i = 0; i < normalized.length; i++) {
    for (const m of BILL_MARKERS) {
      if (seen.has(m.name)) continue;
      if (m.pattern.test(normalized[i]!)) {
        seen.add(m.name);
        score += m.weight;
        signals.push({ marker: m.name, weight: m.weight, line: i });
      }
    }
  }

  const moneyLines = normalized.filter((l) => MONEY_LINE.test(l)).length;
  if (moneyLines >= 2) {
    score += 2;
    signals.push({ marker: 'money-columns', weight: 2, line: -1 });
  }

  // A KOT prints items and quantities but no prices. Absence of money on a
  // slip that otherwise looks like an order is the strongest KOT signal there
  // is, and it catches the ones with no "KOT" text at all.
  if (moneyLines === 0 && normalized.length >= 3) {
    return {
      streamClass: 'kitchen_order_ticket',
      confidence: 0.6,
      signals,
      quarantine: true,
      reason: 'no monetary amounts anywhere on the slip',
    };
  }

  // --- Pass 3: sub-type of a bill ------------------------------------------
  const joined = normalized.join('\n');
  const isCredit = CREDIT_MARKERS.some((p) => p.test(joined));
  const isVoid = VOID_MARKERS.some((p) => p.test(joined));
  const isReprint = REPRINT_MARKERS.some((p) => p.test(joined));

  if (score < minBillScore) {
    return {
      streamClass: 'unknown',
      confidence: Math.min(0.5, score / minBillScore),
      signals,
      quarantine: true,
      reason: `insufficient bill evidence (score ${score} < ${minBillScore})`,
    };
  }

  // A reprint is still a bill — it is the *same* bill. We classify it as such
  // so issuance can look for the existing fingerprint instead of creating a
  // second document (E1 reprint).
  if (isReprint) {
    return {
      streamClass: 'reprint',
      confidence: 0.9,
      signals,
      quarantine: false,
      reason: 'reprint marker present; resolve against existing fingerprint',
    };
  }

  return {
    streamClass: 'bill',
    confidence: Math.min(0.99, 0.5 + score / 20),
    signals,
    quarantine: false,
    reason: isVoid
      ? 'bill carrying a void marker'
      : isCredit
        ? 'bill carrying a credit-note marker'
        : 'positive bill evidence',
  };
}

/** Maps a classified stream to the canonical document type, where it is a bill. */
export function documentTypeForStream(lines: string[]): 'credit_note' | 'void' | null {
  const joined = lines.map(normalizeLine).join('\n');
  if (CREDIT_MARKERS.some((p) => p.test(joined))) return 'credit_note';
  if (VOID_MARKERS.some((p) => p.test(joined))) return 'void';
  return null;
}
