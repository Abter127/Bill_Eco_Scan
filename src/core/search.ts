import { parseAmountToMinor } from './money.js';
import { localDateKey } from './time.js';

/**
 * Search query parsing (R-02, journey J3).
 *
 * The journey is the whole specification: someone is standing at a returns desk
 * and needs one document *now*, and what they have is a half-memory — "that
 * kettle, around two thousand, sometime in March". So the parser pulls
 * structure out of natural phrasing rather than demanding filters, and ranking
 * weights recency and item match rather than a single relevance score.
 */

export interface AmountRange { minMinor: number; maxMinor: number; label: string }
export interface DateRange { fromKey: string; toKey: string; label: string }

export interface ParsedQuery {
  /** What goes to the full-text index. */
  text: string;
  terms: string[];
  amount: AmountRange | null;
  dates: DateRange | null;
  /** Explicit filters the caller may have supplied alongside the text. */
  merchantHint: string | null;
  categoryHint: string | null;
  paymentMethodHint: string | null;
  /** Recognised fragments, so the UI can show what it understood. */
  understood: string[];
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
const MONTH_ABBR = MONTHS.map((m) => m.slice(0, 3));

const PAYMENT_WORDS: Array<[RegExp, string]> = [
  [/\b(?:upi|gpay|google pay|phonepe|paytm)\b/i, 'upi'],
  [/\bcredit card\b/i, 'card_credit'],
  [/\bdebit card\b/i, 'card_debit'],
  [/\bcash\b/i, 'cash'],
  [/\bcard\b/i, 'card'],
];

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'for', 'from', 'in', 'on', 'at', 'to', 'my', 'that',
  'i', 'bought', 'buy', 'purchase', 'purchased', 'bill', 'receipt', 'find',
  'show', 'me', 'was', 'is', 'it', 'and', 'or', 'about', 'around', 'roughly',
  'approximately', 'some', 'sometime', 'something', 'rupees', 'rs', 'inr',
]);

function monthRange(monthIndex: number, year: number): DateRange {
  const from = `${year}-${String(monthIndex + 1).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const to = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { fromKey: from, toKey: to, label: `${MONTHS[monthIndex]![0]!.toUpperCase()}${MONTHS[monthIndex]!.slice(1)} ${year}` };
}

function shiftMonths(now: Date, delta: number, timeZone?: string): DateRange {
  const key = localDateKey(now, timeZone);
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7)) - 1 + delta;
  return monthRange(((m % 12) + 12) % 12, y + Math.floor(m / 12));
}

export interface ParseQueryOptions {
  now?: Date;
  timeZone?: string;
  /** Tolerance for "around 2000". Wide enough to survive a fuzzy memory. */
  amountTolerance?: number;
}

export function parseSearchQuery(raw: string, opts: ParseQueryOptions = {}): ParsedQuery {
  const now = opts.now ?? new Date();
  const tolerance = opts.amountTolerance ?? 0.15;
  const understood: string[] = [];
  let working = ` ${raw.toLowerCase().trim()} `;

  const consume = (re: RegExp, note: string): RegExpExecArray | null => {
    const m = re.exec(working);
    if (m) {
      working = working.replace(m[0], ' ');
      understood.push(note);
    }
    return m;
  };

  // --- amounts -------------------------------------------------------------
  let amount: AmountRange | null = null;

  const between = /\bbetween\s+(?:₹|rs\.?|inr)?\s*([\d,.]+)\s+(?:and|to|-)\s+(?:₹|rs\.?|inr)?\s*([\d,.]+)/;
  const bm = between.exec(working);
  if (bm) {
    const lo = parseAmountToMinor(bm[1]!);
    const hi = parseAmountToMinor(bm[2]!);
    if (lo !== null && hi !== null) {
      amount = { minMinor: Math.min(lo, hi), maxMinor: Math.max(lo, hi), label: `₹${bm[1]}–₹${bm[2]}` };
      working = working.replace(bm[0], ' ');
      understood.push(`amount between ${bm[1]} and ${bm[2]}`);
    }
  }

  if (!amount) {
    const under = consume(/\b(?:under|below|less than|upto|up to|<)\s*(?:₹|rs\.?|inr)?\s*([\d,.]+)/, 'amount under');
    if (under) {
      const hi = parseAmountToMinor(under[1]!);
      if (hi !== null) amount = { minMinor: 0, maxMinor: hi, label: `under ₹${under[1]}` };
    }
  }
  if (!amount) {
    const over = consume(/\b(?:over|above|more than|greater than|>)\s*(?:₹|rs\.?|inr)?\s*([\d,.]+)/, 'amount over');
    if (over) {
      const lo = parseAmountToMinor(over[1]!);
      if (lo !== null) amount = { minMinor: lo, maxMinor: Number.MAX_SAFE_INTEGER, label: `over ₹${over[1]}` };
    }
  }
  if (!amount) {
    // "around 2000", "~2000", "about ₹2,000", and a bare "₹2000".
    const approx = consume(
      /\b(?:around|about|roughly|approx\.?|approximately|~)\s*(?:₹|rs\.?|inr)?\s*([\d,.]+)|(?:₹|rs\.?)\s*([\d,.]+)/,
      'approximate amount',
    );
    if (approx) {
      const digits = approx[1] ?? approx[2];
      const centre = digits ? parseAmountToMinor(digits) : null;
      if (centre !== null && centre > 0) {
        amount = {
          minMinor: Math.round(centre * (1 - tolerance)),
          maxMinor: Math.round(centre * (1 + tolerance)),
          label: `about ₹${digits}`,
        };
      }
    }
  }

  // --- dates ---------------------------------------------------------------
  let dates: DateRange | null = null;

  if (/\blast month\b/.test(working)) {
    dates = shiftMonths(now, -1, opts.timeZone);
    working = working.replace(/\blast month\b/, ' ');
    understood.push('last month');
  } else if (/\bthis month\b/.test(working)) {
    dates = shiftMonths(now, 0, opts.timeZone);
    working = working.replace(/\bthis month\b/, ' ');
    understood.push('this month');
  } else if (/\blast year\b/.test(working)) {
    const y = Number(localDateKey(now, opts.timeZone).slice(0, 4)) - 1;
    dates = { fromKey: `${y}-01-01`, toKey: `${y}-12-31`, label: String(y) };
    working = working.replace(/\blast year\b/, ' ');
    understood.push('last year');
  } else {
    // "march", "in march", "march 2026", "last march"
    const monthMatch = new RegExp(
      `\\b(?:last\\s+|in\\s+)?(${MONTHS.join('|')}|${MONTH_ABBR.join('|')})\\b\\s*(\\d{4})?`,
    ).exec(working);
    if (monthMatch) {
      const name = monthMatch[1]!;
      let idx = MONTHS.indexOf(name);
      if (idx < 0) idx = MONTH_ABBR.indexOf(name);
      if (idx >= 0) {
        const todayKey = localDateKey(now, opts.timeZone);
        const currentYear = Number(todayKey.slice(0, 4));
        const currentMonth = Number(todayKey.slice(5, 7)) - 1;
        // A bare month name means the most recent occurrence of it, not a
        // future one — nobody searches for a bill they have not received.
        const year = monthMatch[2]
          ? Number(monthMatch[2])
          : idx <= currentMonth ? currentYear : currentYear - 1;
        dates = monthRange(idx, year);
        working = working.replace(monthMatch[0], ' ');
        understood.push(dates.label);
      }
    }
  }

  // --- payment method ------------------------------------------------------
  let paymentMethodHint: string | null = null;
  for (const [pattern, value] of PAYMENT_WORDS) {
    if (pattern.test(working)) {
      paymentMethodHint = value;
      working = working.replace(pattern, ' ');
      understood.push(`paid by ${value.replace('_', ' ')}`);
      break;
    }
  }

  // --- what is left is the item / shop text --------------------------------
  const terms = working
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));

  return {
    text: terms.join(' '),
    terms,
    amount,
    dates,
    merchantHint: null,
    categoryHint: null,
    paymentMethodHint,
    understood,
  };
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

export interface RankInput {
  /** Normalised 0..1 full-text relevance from the index. */
  textScore: number;
  /** 1 when a query term appears in a line-item description. */
  itemMatch: boolean;
  merchantMatch: boolean;
  documentDateKey: string | null;
  amountInRange: boolean;
}

/**
 * "Results rank by recency and item match, not relevance score alone."
 *
 * A bill from last week that mentions the item beats a perfect text match from
 * two years ago, because the person at the returns desk is almost always
 * looking for something recent.
 */
export function rankScore(input: RankInput, todayKey: string): number {
  const ageDays = input.documentDateKey
    ? Math.max(0, Math.round((Date.parse(`${todayKey}T00:00:00Z`) - Date.parse(`${input.documentDateKey}T00:00:00Z`)) / 86_400_000))
    : 3650;
  // Half-life of roughly a year: recent stays strongly preferred without
  // burying a three-year-old appliance bill that is the only item match.
  const recency = Math.exp(-ageDays / 365);

  return (
    0.35 * input.textScore +
    0.30 * (input.itemMatch ? 1 : 0) +
    0.20 * recency +
    0.10 * (input.merchantMatch ? 1 : 0) +
    0.05 * (input.amountInRange ? 1 : 0)
  );
}

/**
 * E8 "search with nothing to find": don't show a search bar over a list short
 * enough to read. Search appears once a history is long enough to need it.
 */
export const SEARCH_VISIBILITY_THRESHOLD = 12;

export function shouldShowSearch(billCount: number): boolean {
  return billCount >= SEARCH_VISIBILITY_THRESHOLD;
}
