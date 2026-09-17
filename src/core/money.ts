/**
 * Money is always integer minor units (paise for INR) plus an explicit currency.
 *
 * Two PRD rules are enforced here rather than at the call sites, because call
 * sites forget:
 *   E7 "Non-INR bill"      -> currency travels with every amount; a total that
 *                             mixes currencies is a throw, not a rounding note.
 *   E1 "Zero and negative"  -> negative documents are valid but are never spend.
 */

export interface Money {
  readonly minor: number;
  readonly currency: string;
}

export class CurrencyMixError extends Error {
  constructor(readonly currencies: string[]) {
    super(`refusing to total across currencies: ${currencies.join(', ')}`);
    this.name = 'CurrencyMixError';
  }
}

const MINOR_DIGITS: Record<string, number> = {
  INR: 2, USD: 2, EUR: 2, GBP: 2, AED: 2, SGD: 2, JPY: 0, KWD: 3, BHD: 3, OMR: 3,
};

export function minorDigits(currency: string): number {
  return MINOR_DIGITS[currency.toUpperCase()] ?? 2;
}

export function money(minor: number, currency = 'INR'): Money {
  if (!Number.isInteger(minor)) {
    throw new TypeError(`money() needs integer minor units, got ${minor}`);
  }
  if (!Number.isSafeInteger(minor)) {
    throw new RangeError(`amount out of safe integer range: ${minor}`);
  }
  return Object.freeze({ minor, currency: currency.toUpperCase() });
}

export function zero(currency = 'INR'): Money {
  return money(0, currency);
}

function assertSameCurrency(items: readonly Money[]): string {
  const seen = [...new Set(items.map((m) => m.currency))];
  if (seen.length > 1) throw new CurrencyMixError(seen);
  return seen[0] ?? 'INR';
}

export function addMoney(...items: Money[]): Money {
  if (items.length === 0) return zero();
  return money(
    items.reduce((acc, m) => acc + m.minor, 0),
    assertSameCurrency(items),
  );
}

export function subMoney(a: Money, b: Money): Money {
  return money(a.minor - b.minor, assertSameCurrency([a, b]));
}

/**
 * Totalling a mixed-currency history is a legitimate request; silently adding
 * the numbers is not. Callers get one bucket per currency and decide how to
 * present it (the PRD forbids implicit FX).
 */
export function sumByCurrency(items: readonly Money[]): Money[] {
  const buckets = new Map<string, number>();
  for (const m of items) buckets.set(m.currency, (buckets.get(m.currency) ?? 0) + m.minor);
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, minor]) => money(minor, currency));
}

/** A refund slip is a real document but it is not spend. Never net it into one. */
export function isSpend(m: Money): boolean {
  return m.minor > 0;
}

export function spendOnly(items: readonly Money[]): Money[] {
  return items.filter(isSpend);
}

/** Parses "1,234.50", "₹1234.5", "(120.00)" (negative), "1 234,50" -> minor units. */
export function parseAmountToMinor(raw: string, currency = 'INR'): number | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (s === '') return null;

  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[₹$€£]|INR|Rs\.?|RUPEES/gi, '').trim();
  if (/^-/.test(s)) {
    negative = true;
    s = s.slice(1).trim();
  }
  if (/-$/.test(s)) {
    negative = true;
    s = s.slice(0, -1).trim();
  }
  s = s.replace(/\s/g, '');

  // Decide which separator is the decimal mark by looking at the last one.
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let decimalSep: string | null = null;
  if (lastDot >= 0 || lastComma >= 0) {
    const cand = lastDot > lastComma ? '.' : ',';
    const tail = s.length - s.lastIndexOf(cand) - 1;
    // A 3-digit tail on the only separator is a thousands group (1,234 / 1.234).
    const onlyOne = (lastDot >= 0) !== (lastComma >= 0) && s.split(cand).length === 2;
    if (!(onlyOne && tail === 3)) decimalSep = cand;
  }

  let intPart = s;
  let fracPart = '';
  if (decimalSep) {
    const at = s.lastIndexOf(decimalSep);
    intPart = s.slice(0, at);
    fracPart = s.slice(at + 1);
  }
  intPart = intPart.replace(/[.,]/g, '');
  if (!/^\d*$/.test(intPart) || !/^\d*$/.test(fracPart)) return null;
  if (intPart === '' && fracPart === '') return null;

  const digits = minorDigits(currency);
  const frac = (fracPart + '0'.repeat(digits)).slice(0, digits);
  const magnitude = Number(intPart || '0') * 10 ** digits + Number(frac || '0');
  if (!Number.isSafeInteger(magnitude)) return null;
  return negative ? -magnitude : magnitude;
}

export function formatMoney(m: Money, locale = 'en-IN'): string {
  const digits = minorDigits(m.currency);
  const value = m.minor / 10 ** digits;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: m.currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/** Plain decimal string for exports — never a locale-grouped number in a CSV. */
export function toDecimalString(m: Money): string {
  const digits = minorDigits(m.currency);
  const sign = m.minor < 0 ? '-' : '';
  const abs = Math.abs(m.minor).toString().padStart(digits + 1, '0');
  if (digits === 0) return `${sign}${abs}`;
  return `${sign}${abs.slice(0, -digits)}.${abs.slice(-digits)}`;
}
