/**
 * Every rule in E7 "Time, data and scale" lives here.
 *
 * The three that silently corrupt reports:
 *   - Financial year is April-March, not January-December.
 *   - The *document* date governs every total; claim time is metadata.
 *   - Terminal clocks lie, so terminal time never drives a countdown alone.
 */

export const IST = 'Asia/Kolkata';

export interface ZonedParts {
  year: number; month: number; day: number;
  hour: number; minute: number; second: number;
}

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    partsCache.set(timeZone, f);
  }
  return f;
}

export function zonedParts(date: Date, timeZone = IST): ZonedParts {
  const out: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return {
    year: out.year!, month: out.month!, day: out.day!,
    hour: out.hour! % 24, minute: out.minute!, second: out.second!,
  };
}

/** Calendar day in the merchant's zone — the key every report groups by. */
export function localDateKey(date: Date, timeZone = IST): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export interface FinancialYear {
  /** "2026-27" — how an Indian accountant writes it. */
  label: string;
  startYear: number;
  /** Inclusive local date keys. */
  startDateKey: string;
  endDateKey: string;
}

/**
 * India runs April-March. Getting this wrong is, per the PRD, "an instant
 * credibility loss with the business buyer", so exports default to it.
 */
export function financialYearOf(date: Date | string, timeZone = IST): FinancialYear {
  const key = typeof date === 'string' ? date : localDateKey(date, timeZone);
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(5, 7));
  const startYear = month >= 4 ? year : year - 1;
  return {
    label: `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`,
    startYear,
    startDateKey: `${startYear}-04-01`,
    endDateKey: `${startYear + 1}-03-31`,
  };
}

export function financialYearFromLabel(label: string, ): FinancialYear | null {
  const m = /^(\d{4})-(\d{2})$/.exec(label.trim());
  if (!m) return null;
  const startYear = Number(m[1]);
  if ((startYear + 1) % 100 !== Number(m[2])) return null;
  return {
    label: `${startYear}-${m[2]}`,
    startYear,
    startDateKey: `${startYear}-04-01`,
    endDateKey: `${startYear + 1}-03-31`,
  };
}

// ---------------------------------------------------------------------------
// Ambiguous dates (E3). A wrong date silently voids a warranty countdown, so
// where the reading is genuinely ambiguous we flag instead of picking.
// ---------------------------------------------------------------------------

export type DateOrder = 'DMY' | 'MDY' | 'YMD';

export interface AmbiguousDateResult {
  /** Local date key, or null when we refused to guess. */
  dateKey: string | null;
  ambiguous: boolean;
  /** All readings that survive validation, most likely first. */
  candidates: string[];
  reason: string;
  /** Which ordering produced dateKey, when one did. */
  order?: DateOrder;
}

export interface DateResolutionContext {
  /** When the photo/print was taken. A bill cannot be issued after capture. */
  captureDate?: Date;
  /** Merchant's locale convention. India is DMY; a US-origin receipt is MDY. */
  merchantDateOrder?: DateOrder;
  timeZone?: string;
}

function isRealDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function key(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function expandYear(y: number): number {
  if (y >= 1000) return y;
  // Two-digit years on receipts are this century until proven otherwise.
  return y + (y <= 79 ? 2000 : 1900);
}

/**
 * Resolves a printed date string. `03/04/2026` is March in MDY and April in
 * DMY; when both readings are plausible and nothing disambiguates them, this
 * returns `dateKey: null, ambiguous: true` and the caller must ask the user.
 */
export function resolveAmbiguousDate(
  raw: string,
  ctx: DateResolutionContext = {},
): AmbiguousDateResult {
  const timeZone = ctx.timeZone ?? IST;
  const s = raw.trim();
  if (!s) return { dateKey: null, ambiguous: false, candidates: [], reason: 'empty' };

  // Unambiguous ISO / YYYY-MM-DD form.
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (iso) {
    const [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    if (!isRealDate(y, m, d)) {
      return { dateKey: null, ambiguous: false, candidates: [], reason: 'impossible-date' };
    }
    return { dateKey: key(y, m, d), ambiguous: false, candidates: [key(y, m, d)], reason: 'iso', order: 'YMD' };
  }

  // Textual month is unambiguous: 03-Apr-2026, 3 April 26.
  const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const textual = /^(\d{1,2})[\s\-/.]*([A-Za-z]{3,9})[\s\-/.]*(\d{2,4})$/.exec(s);
  if (textual) {
    const mi = MONTHS.indexOf(textual[2]!.slice(0, 3).toLowerCase());
    if (mi >= 0) {
      const y = expandYear(Number(textual[3]));
      const d = Number(textual[1]);
      if (!isRealDate(y, mi + 1, d)) {
        return { dateKey: null, ambiguous: false, candidates: [], reason: 'impossible-date' };
      }
      return { dateKey: key(y, mi + 1, d), ambiguous: false, candidates: [key(y, mi + 1, d)], reason: 'textual-month', order: 'DMY' };
    }
  }

  const numeric = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s);
  if (!numeric) {
    return { dateKey: null, ambiguous: false, candidates: [], reason: 'unparseable' };
  }
  const a = Number(numeric[1]);
  const b = Number(numeric[2]);
  const y = expandYear(Number(numeric[3]));

  const dmy = isRealDate(y, b, a) ? key(y, b, a) : null;
  const mdy = isRealDate(y, a, b) ? key(y, a, b) : null;

  // One reading only — e.g. 25/12 can only be DMY.
  if (dmy && !mdy) return { dateKey: dmy, ambiguous: false, candidates: [dmy], reason: 'only-valid-reading', order: 'DMY' };
  if (mdy && !dmy) return { dateKey: mdy, ambiguous: false, candidates: [mdy], reason: 'only-valid-reading', order: 'MDY' };
  if (!dmy && !mdy) return { dateKey: null, ambiguous: false, candidates: [], reason: 'impossible-date' };
  if (dmy === mdy) return { dateKey: dmy, ambiguous: false, candidates: [dmy!], reason: 'identical-readings', order: 'DMY' };

  // Both readings valid and different. Capture date can still eliminate one:
  // a bill cannot be issued after it was photographed.
  const candidates = [dmy!, mdy!];
  if (ctx.captureDate) {
    const capKey = localDateKey(ctx.captureDate, timeZone);
    const feasible = candidates.filter((c) => c <= capKey);
    if (feasible.length === 1) {
      const chosen = feasible[0]!;
      return {
        dateKey: chosen, ambiguous: false, candidates,
        reason: 'disambiguated-by-capture-date', order: chosen === dmy ? 'DMY' : 'MDY',
      };
    }
    if (feasible.length === 0) {
      return { dateKey: null, ambiguous: true, candidates, reason: 'both-readings-after-capture' };
    }
  }

  // Merchant locale is a preference, not proof. We use it only to order the
  // candidates for the correction UI — we still refuse to pick.
  const order = ctx.merchantDateOrder ?? 'DMY';
  const ranked = order === 'MDY' ? [mdy!, dmy!] : [dmy!, mdy!];
  return {
    dateKey: null,
    ambiguous: true,
    candidates: ranked,
    reason: 'ambiguous-day-month',
  };
}

// ---------------------------------------------------------------------------
// Clock skew (E7). Store both times; flag, never silently trust.
// ---------------------------------------------------------------------------

export interface ClockSkewAssessment {
  skewMs: number;
  flagged: boolean;
  reason: string | null;
  /** The timestamp downstream logic (warranty, return window) must use. */
  trustedTime: Date;
}

/** Beyond this the terminal clock is wrong, not merely imprecise. */
export const CLOCK_SKEW_TOLERANCE_MS = 15 * 60 * 1000;

export function assessClockSkew(
  terminalTime: Date,
  serverReceiptTime: Date,
): ClockSkewAssessment {
  const skewMs = terminalTime.getTime() - serverReceiptTime.getTime();
  const abs = Math.abs(skewMs);

  if (!Number.isFinite(terminalTime.getTime())) {
    return { skewMs: 0, flagged: true, reason: 'terminal-time-invalid', trustedTime: serverReceiptTime };
  }
  // The 1970 and next-year cases from the PRD.
  if (terminalTime.getUTCFullYear() < 2015) {
    return { skewMs, flagged: true, reason: 'terminal-clock-unset', trustedTime: serverReceiptTime };
  }
  if (skewMs > 24 * 3600 * 1000) {
    return { skewMs, flagged: true, reason: 'terminal-clock-ahead', trustedTime: serverReceiptTime };
  }
  if (abs > CLOCK_SKEW_TOLERANCE_MS) {
    // Behind by more than the tolerance is usually a genuinely stale clock, but
    // it can also be a bill queued through a long offline window, so the
    // offline queue stamps its own enqueue time and we keep both.
    return { skewMs, flagged: true, reason: 'terminal-clock-skewed', trustedTime: serverReceiptTime };
  }
  return { skewMs, flagged: false, reason: null, trustedTime: terminalTime };
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/** Calendar-month arithmetic that clamps (31 Jan + 1 month = 28/29 Feb). */
export function addMonthsToDateKey(dateKey: string, months: number): string {
  const y = Number(dateKey.slice(0, 4));
  const m = Number(dateKey.slice(5, 7));
  const d = Number(dateKey.slice(8, 10));
  const total = (y * 12 + (m - 1)) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return key(ny, nm, Math.min(d, lastDay));
}

export function daysBetweenDateKeys(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}
