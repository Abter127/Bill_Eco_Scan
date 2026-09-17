import type { CanonicalBill } from './schema.js';

/**
 * The consent boundary (T-01) and the acceptance criterion behind M-04:
 *
 *   "A full-permission admin can produce no list of people who shopped there."
 *
 * E6 states the commercial version of the same rule: a merchant asking for
 * customer data as a condition of onboarding is "the most-requested feature,
 * and the one that ends the company", and the defence is to "write it into the
 * product, not the policy — if the schema can't express it, sales can't sell
 * it."
 *
 * So this module is not a permission check. It is a *projection type*. There is
 * no code path that hands a merchant a `CanonicalBill`; merchant-facing code
 * takes `MerchantVisibleBill`, which has nowhere to put an identity. The
 * runtime guard below exists only to catch a future careless spread.
 */

/**
 * Everything a merchant may see about a bill they issued, by default:
 * the bill itself, and whether it was claimed. Nothing about *who*.
 */
export interface MerchantVisibleBill {
  id: string;
  outletId: string;
  terminalId: string | null;
  documentType: string;
  documentNumber: string | null;
  financialYear: string | null;
  documentDateKey: string | null;
  currency: string;
  subtotalMinor: number | null;
  taxTotalMinor: number | null;
  grandTotalMinor: number;
  paymentMethod: string | null;
  state: string;
  /** The boolean, and only the boolean. */
  claimed: boolean;
  lineCount: number;
  provenance: string;
}

/** Field names that must never reach a merchant-facing surface. */
const FORBIDDEN_FIELDS = [
  'ownerAccountId', 'ownerProfileId', 'accountId', 'profileId',
  'phone', 'phoneNumber', 'msisdn', 'email', 'emailAddress',
  'name', 'customerName', 'fullName', 'deviceId', 'ipAddress',
  'claimedAt', 'claimTokenHash', 'buyerGstin',
];

export class ConsentBoundaryViolation extends Error {
  constructor(readonly field: string) {
    super(
      `consent boundary: "${field}" cannot appear on a merchant-visible projection. ` +
      `Merchant default visibility is the bill it issued plus a claimed boolean (T-01).`,
    );
    this.name = 'ConsentBoundaryViolation';
  }
}

/**
 * Defence in depth. The type already prevents this; the guard catches the case
 * where someone reaches for `{ ...bill, ...projection }` in a hurry.
 *
 * `claimedAt` is forbidden as well as `ownerAccountId`: a claim *timestamp*
 * plus a till log is a re-identification vector, which is why T-01 says the
 * boolean and not the time.
 */
export function assertNoCustomerIdentity(obj: Record<string, unknown>, path = ''): void {
  for (const [key, value] of Object.entries(obj)) {
    if (FORBIDDEN_FIELDS.includes(key)) throw new ConsentBoundaryViolation(path ? `${path}.${key}` : key);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      assertNoCustomerIdentity(value as Record<string, unknown>, path ? `${path}.${key}` : key);
    }
  }
}

export function toMerchantVisible(bill: CanonicalBill): MerchantVisibleBill {
  const projection: MerchantVisibleBill = {
    id: bill.id,
    outletId: bill.outletId,
    terminalId: bill.terminalId,
    documentType: bill.documentType,
    documentNumber: bill.documentNumber,
    financialYear: bill.financialYear,
    documentDateKey: bill.documentDateKey,
    currency: bill.currency,
    subtotalMinor: bill.subtotalMinor,
    taxTotalMinor: bill.taxTotalMinor,
    grandTotalMinor: bill.grandTotalMinor,
    paymentMethod: bill.paymentMethod,
    state: bill.state,
    claimed: bill.state === 'claimed',
    lineCount: bill.lines.length,
    provenance: bill.provenance,
  };
  assertNoCustomerIdentity(projection as unknown as Record<string, unknown>);
  return projection;
}

// ---------------------------------------------------------------------------
// Scoped grants — "anything more is a scoped, expiring, revocable grant"
// ---------------------------------------------------------------------------

export const GRANT_SCOPES = [
  'return_verification',   // J4: merchant scans to verify authenticity, nothing else
  'warranty_claim',        // service centre needs bill + serial + date
  'expense_reimbursement', // employer needs the document, not the history
] as const;
export type GrantScope = (typeof GRANT_SCOPES)[number];

export interface ScopedGrant {
  id: string;
  billId: string;
  grantedToMerchantId: string | null;
  scope: GrantScope;
  /** Grants always expire. A grant with no expiry is not a grant. */
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  /** Fields the grant exposes beyond the merchant default. */
  fields: readonly string[];
}

const SCOPE_FIELDS: Record<GrantScope, readonly string[]> = {
  // J4: "merchant scans it to verify authenticity without receiving any other
  // data" — the answer is a yes/no plus the document's own identifiers.
  return_verification: ['id', 'documentNumber', 'documentDateKey', 'grandTotalMinor', 'currency', 'authentic'],
  warranty_claim: ['id', 'documentNumber', 'documentDateKey', 'grandTotalMinor', 'currency', 'lines.description', 'lines.serialNumber', 'imageRef'],
  expense_reimbursement: ['id', 'documentNumber', 'documentDateKey', 'grandTotalMinor', 'taxTotalMinor', 'currency', 'merchantId', 'imageRef', 'provenance', 'userEditedAmounts'],
};

export function fieldsForScope(scope: GrantScope): readonly string[] {
  return SCOPE_FIELDS[scope];
}

export function isGrantActive(grant: ScopedGrant, now: Date): boolean {
  if (grant.revokedAt) return false;
  return Date.parse(grant.expiresAt) > now.getTime();
}

/**
 * J4 step 2. The merchant gets an authenticity verdict and the document's own
 * identifiers — never the customer, never the rest of the history.
 */
export interface ReturnVerification {
  authentic: boolean;
  billId: string;
  documentNumber: string | null;
  documentDateKey: string | null;
  grandTotalMinor: number;
  currency: string;
  outletId: string;
  returnWindowOpen: boolean;
  /** Present so a different outlet can still verify it (E4). */
  merchantId: string;
  alreadyReturnedLineNos: number[];
}

export function buildReturnVerification(
  bill: CanonicalBill,
  merchantId: string,
  returnWindowOpen: boolean,
): ReturnVerification {
  const verification: ReturnVerification = {
    authentic: bill.state !== 'cancelled' && bill.state !== 'purged',
    billId: bill.id,
    documentNumber: bill.documentNumber,
    documentDateKey: bill.documentDateKey,
    grandTotalMinor: bill.grandTotalMinor,
    currency: bill.currency,
    outletId: bill.outletId,
    returnWindowOpen,
    merchantId,
    alreadyReturnedLineNos: bill.lines.filter((l) => l.returnedQty > 0).map((l) => l.lineNo),
  };
  assertNoCustomerIdentity(verification as unknown as Record<string, unknown>);
  return verification;
}

/**
 * T-03's "plain-language itemised consent notice". Itemised means one entry per
 * purpose with its own retention, not a wall of text with a single checkbox.
 */
export interface ConsentItem {
  id: string;
  purpose: string;
  whatWeStore: string;
  retention: string;
  optional: boolean;
}

export const CONSENT_NOTICE: readonly ConsentItem[] = [
  {
    id: 'bill_storage',
    purpose: 'Keeping your bills so you can find them later',
    whatWeStore: 'The bill itself: shop, date, items, amounts, tax, and the photo where you took one.',
    retention: 'Until you delete the bill or your account. Claimed bills stay readable even if the shop leaves.',
    optional: false,
  },
  {
    id: 'merchant_statutory_copy',
    purpose: 'The shop’s own copy of the bill they issued',
    whatWeStore: 'The shop keeps the bill they issued, with no link to you, for as long as tax law requires.',
    retention: 'Statutory retention period. Deleting your account removes the link to you, not their copy.',
    optional: false,
  },
  {
    id: 'claim_link',
    purpose: 'Letting you claim a bill by scanning the code at the counter',
    whatWeStore: 'A short-lived, single-use code. It is deleted once used or expired.',
    retention: '15 minutes.',
    optional: false,
  },
  {
    id: 'warranty_reminders',
    purpose: 'Telling you before a warranty or return window runs out',
    whatWeStore: 'Purchase dates and warranty lengths.',
    retention: 'While the bill is in your history.',
    optional: true,
  },
  {
    id: 'spend_categories',
    purpose: 'Grouping your spending by category',
    whatWeStore: 'A category label per bill. Health-related bills are excluded.',
    retention: 'While the bill is in your history.',
    optional: true,
  },
];
