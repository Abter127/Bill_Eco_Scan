import { addMonthsToDateKey, daysBetweenDateKeys, localDateKey } from './time.js';
import type { BillLine } from './schema.js';

/**
 * Return windows (R-04) and warranty (R-05).
 *
 * Both are countdowns the customer acts on, so two rules matter more than the
 * arithmetic:
 *
 *  - The source is always shown. A countdown whose origin the customer cannot
 *    see is a number they will not argue with at a returns desk, and R-04 says
 *    explicitly "sourced from the merchant's stated policy, with the source
 *    shown".
 *
 *  - Neither is ever driven by terminal time alone (E7). A till with a wrong
 *    clock would otherwise void a warranty months early, silently.
 */

export type PolicySource = 'merchant_policy' | 'category_default' | 'manufacturer' | 'user_override' | 'none';

export interface SourcedValue<T> {
  value: T;
  source: PolicySource;
  /** Verbatim string rendered next to the countdown. */
  sourceLabel: string;
}

// ---------------------------------------------------------------------------
// Return window
// ---------------------------------------------------------------------------

export interface ReturnWindowInput {
  /** Document date. Never the terminal timestamp when it was flagged (E7). */
  documentDateKey: string | null;
  /** Merchant's stated policy, in days. Null when they publish none. */
  merchantReturnWindowDays: number | null;
  merchantReturnPolicySource: string | null;
  /** Set once any line has been returned — the window keeps running (E4). */
  fullyReturned?: boolean;
  cancelled?: boolean;
}

export interface ReturnWindowState {
  applicable: boolean;
  open: boolean;
  expiresDateKey: string | null;
  daysRemaining: number | null;
  source: PolicySource;
  sourceLabel: string;
  /** Rendered under the countdown when we cannot compute one. */
  note: string | null;
}

export function returnWindowState(
  input: ReturnWindowInput,
  now: Date,
  timeZone?: string,
): ReturnWindowState {
  const todayKey = localDateKey(now, timeZone);

  if (input.cancelled) {
    return {
      applicable: false, open: false, expiresDateKey: null, daysRemaining: null,
      source: 'none', sourceLabel: '', note: 'This bill was cancelled.',
    };
  }
  if (input.merchantReturnWindowDays === null) {
    return {
      applicable: false, open: false, expiresDateKey: null, daysRemaining: null,
      source: 'none', sourceLabel: '',
      note: 'This shop has not published a return window. Ask at the counter.',
    };
  }
  if (!input.documentDateKey) {
    // An unresolved date (E3) must not produce a confident countdown.
    return {
      applicable: true, open: false, expiresDateKey: null, daysRemaining: null,
      source: 'merchant_policy',
      sourceLabel: input.merchantReturnPolicySource ?? 'Shop’s stated return policy',
      note: 'We could not read the bill date, so the return window is not being counted. Confirm the date to start it.',
    };
  }

  const expiresDateKey = addMonthsToDateKey(input.documentDateKey, 0);
  const expiry = shiftDays(expiresDateKey, input.merchantReturnWindowDays);
  const daysRemaining = daysBetweenDateKeys(todayKey, expiry);

  return {
    applicable: true,
    open: daysRemaining >= 0 && !input.fullyReturned,
    expiresDateKey: expiry,
    daysRemaining,
    source: 'merchant_policy',
    sourceLabel:
      input.merchantReturnPolicySource ??
      `Shop’s stated return policy: ${input.merchantReturnWindowDays} days`,
    note: input.fullyReturned ? 'All items on this bill have been returned.' : null,
  };
}

function shiftDays(dateKey: string, days: number): string {
  const ms = Date.parse(`${dateKey}T00:00:00Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Warranty
// ---------------------------------------------------------------------------

/** Category defaults, overridable per SKU and per bill (R-05). */
export const CATEGORY_WARRANTY_MONTHS: Record<string, number> = {
  electronics: 12,
  large_appliance: 24,
  small_appliance: 12,
  mobile: 12,
  computer: 12,
  furniture: 12,
  footwear: 3,
  apparel: 0,
  grocery: 0,
  pharmacy: 0,
  restaurant: 0,
  fuel: 0,
};

export interface WarrantyInput {
  line: BillLine;
  documentDateKey: string | null;
  merchantCategory: string | null;
  /** Per-SKU duration from the merchant or the manufacturer. */
  skuWarrantyMonths?: number | null;
  userOverrideMonths?: number | null;
  /** Set when a credit note has returned this line (E4). */
  returnedQty?: number;
}

export interface WarrantyState {
  applicable: boolean;
  months: number | null;
  startDateKey: string | null;
  endDateKey: string | null;
  daysRemaining: number | null;
  /** Voided because the line was returned (E4 partial return). */
  voided: boolean;
  source: PolicySource;
  sourceLabel: string;
  note: string | null;
}

export function warrantyState(input: WarrantyInput, now: Date, timeZone?: string): WarrantyState {
  const returned = (input.returnedQty ?? input.line.returnedQty ?? 0) >= input.line.qty;

  let months: number | null = null;
  let source: PolicySource = 'none';
  let sourceLabel = '';

  if (input.userOverrideMonths != null) {
    months = input.userOverrideMonths;
    source = 'user_override';
    sourceLabel = 'You set this warranty length';
  } else if (input.line.warrantyMonths != null) {
    months = input.line.warrantyMonths;
    source = 'manufacturer';
    sourceLabel = 'Printed on the bill';
  } else if (input.skuWarrantyMonths != null) {
    months = input.skuWarrantyMonths;
    source = 'manufacturer';
    sourceLabel = 'Manufacturer’s stated warranty for this product';
  } else if (input.merchantCategory && CATEGORY_WARRANTY_MONTHS[input.merchantCategory] != null) {
    months = CATEGORY_WARRANTY_MONTHS[input.merchantCategory]!;
    source = 'category_default';
    sourceLabel = `Typical warranty for ${input.merchantCategory.replace(/_/g, ' ')} — edit if yours differs`;
  }

  if (months === null || months === 0) {
    return {
      applicable: false, months, startDateKey: input.documentDateKey, endDateKey: null,
      daysRemaining: null, voided: returned, source, sourceLabel,
      note: months === 0 ? 'No warranty applies to this kind of purchase.' : null,
    };
  }
  if (!input.documentDateKey) {
    return {
      applicable: true, months, startDateKey: null, endDateKey: null, daysRemaining: null,
      voided: returned, source, sourceLabel,
      note: 'We could not read the bill date, so the warranty countdown has not started. Confirm the date.',
    };
  }

  const endDateKey = addMonthsToDateKey(input.documentDateKey, months);
  const daysRemaining = daysBetweenDateKeys(localDateKey(now, timeZone), endDateKey);

  return {
    applicable: true,
    months,
    startDateKey: input.documentDateKey,
    endDateKey,
    daysRemaining,
    voided: returned,
    source,
    sourceLabel,
    note: returned ? 'This item was returned, so its warranty no longer applies.' : null,
  };
}

/**
 * Open decision §9.03 — "Does warranty restart on replacement?" It varies by
 * manufacturer, so we pick a default, show its source, and allow an override
 * rather than pretending there is one answer.
 */
export type ReplacementWarrantyRule = 'restart' | 'continue';

export const DEFAULT_REPLACEMENT_RULE: ReplacementWarrantyRule = 'continue';

export interface ReplacementWarranty {
  rule: ReplacementWarrantyRule;
  startDateKey: string;
  endDateKey: string;
  sourceLabel: string;
  overridable: true;
}

export function warrantyAfterReplacement(
  originalStartDateKey: string,
  replacementDateKey: string,
  months: number,
  rule: ReplacementWarrantyRule = DEFAULT_REPLACEMENT_RULE,
  sourceLabel = 'Default rule — most manufacturers continue the original warranty. Change this if your manufacturer restarts it.',
): ReplacementWarranty {
  const startDateKey = rule === 'restart' ? replacementDateKey : originalStartDateKey;
  return {
    rule,
    startDateKey,
    endDateKey: addMonthsToDateKey(startDateKey, months),
    sourceLabel,
    overridable: true,
  };
}

/**
 * R-05's acceptance criterion: "Eleven months after an appliance purchase, the
 * user is told unprompted that warranty ends next month." This is what the
 * scheduled job asks for.
 */
export const WARRANTY_REMINDER_DAYS = [30, 7] as const;

export function shouldRemindWarranty(state: WarrantyState, alreadySentDays: number[] = []): number | null {
  if (!state.applicable || state.voided || state.daysRemaining === null) return null;
  for (const d of WARRANTY_REMINDER_DAYS) {
    if (state.daysRemaining <= d && state.daysRemaining >= 0 && !alreadySentDays.includes(d)) {
      return d;
    }
  }
  return null;
}
