import type { SensitivityClass } from './schema.js';

/**
 * Sensitivity classification (T-04).
 *
 * Pharmacy, clinic and diagnostic bills get a stricter class: suppressed from
 * notification previews, excluded from shared profiles by default, and out of
 * all analytics and training sets.
 *
 * Open decision §9.04 is "which categories, and who maintains it". That is
 * answered here as data with an owner and a version rather than as scattered
 * `if (category === 'pharmacy')` checks, so the list can be changed by the
 * people accountable for it without touching the code paths that enforce it.
 */

export interface SensitivityPolicy {
  version: string;
  /** Named owner. An unmaintained list is the failure mode, not a wrong list. */
  maintainer: string;
  categories: readonly string[];
  /** Merchant-name substrings that override a mis-declared category. */
  nameHints: readonly RegExp[];
}

export const SENSITIVITY_POLICY: SensitivityPolicy = {
  version: '2026-09-01',
  maintainer: 'privacy-office',
  categories: [
    'pharmacy',
    'chemist',
    'clinic',
    'hospital',
    'diagnostic_lab',
    'pathology',
    'imaging_centre',
    'dental',
    'optician',
    'mental_health',
    'de_addiction',
    'fertility',
    'maternity',
    'physiotherapy',
    'veterinary',
    'medical_equipment',
  ],
  nameHints: [
    /\bPHARMAC(?:Y|IES)\b/i,
    /\bCHEMIST\b/i,
    /\bMEDIC(?:AL|OS|ALS)\b/i,
    /\bDRUG\s*(?:HOUSE|STORE)\b/i,
    /\bDIAGNOSTIC/i,
    /\bPATHOLOG/i,
    /\bCLINIC\b/i,
    /\bHOSPITAL\b/i,
    /\bNURSING\s*HOME\b/i,
    /\bSCAN\s*CENTR?E\b/i,
    /\bIVF\b/i,
    /\bDE\s*-?\s*ADDICTION\b/i,
  ],
};

export function classifySensitivity(
  merchantCategory: string | null,
  merchantName: string | null,
  policy: SensitivityPolicy = SENSITIVITY_POLICY,
): { sensitivityClass: SensitivityClass; reason: string | null; policyVersion: string } {
  if (merchantCategory && policy.categories.includes(merchantCategory)) {
    return {
      sensitivityClass: 'sensitive',
      reason: `merchant category "${merchantCategory}" is in the sensitive list`,
      policyVersion: policy.version,
    };
  }
  if (merchantName) {
    const hit = policy.nameHints.find((p) => p.test(merchantName));
    if (hit) {
      return {
        sensitivityClass: 'sensitive',
        reason: `merchant name matches a sensitive-category pattern (${hit.source})`,
        policyVersion: policy.version,
      };
    }
  }
  return { sensitivityClass: 'standard', reason: null, policyVersion: policy.version };
}

/**
 * E6's highest-likelihood privacy incident: "Your bill from City Diagnostics
 * Lab is ready" on a lock screen someone else can see.
 *
 * Sensitive-class bills get a preview with no merchant name and no amount. The
 * information is not withheld — it is one unlock away — it is simply not
 * broadcast to a room.
 */
export interface NotificationPreview {
  title: string;
  body: string;
  /** False when the merchant name must not appear anywhere in the payload. */
  includesMerchantName: boolean;
  suppressed: boolean;
}

export function notificationPreview(args: {
  sensitivityClass: SensitivityClass;
  merchantDisplayName: string;
  amountLabel: string;
  kind: 'bill_ready' | 'warranty_expiring' | 'return_window_closing';
}): NotificationPreview {
  if (args.sensitivityClass === 'sensitive') {
    const body =
      args.kind === 'bill_ready'
        ? 'A new bill has been added to your history.'
        : args.kind === 'warranty_expiring'
          ? 'A warranty in your history is ending soon.'
          : 'A return window in your history is closing soon.';
    return { title: 'Billing Hub', body, includesMerchantName: false, suppressed: true };
  }

  switch (args.kind) {
    case 'bill_ready':
      return {
        title: args.merchantDisplayName,
        body: `Your bill for ${args.amountLabel} is ready.`,
        includesMerchantName: true,
        suppressed: false,
      };
    case 'warranty_expiring':
      return {
        title: args.merchantDisplayName,
        body: 'Warranty on this purchase ends soon.',
        includesMerchantName: true,
        suppressed: false,
      };
    case 'return_window_closing':
      return {
        title: args.merchantDisplayName,
        body: 'The return window on this purchase closes soon.',
        includesMerchantName: true,
        suppressed: false,
      };
  }
}

/** E6 "shared or family profile": sensitive bills are excluded by default. */
export function includeInSharedProfile(
  sensitivityClass: SensitivityClass,
  explicitlySharedBillIds: ReadonlySet<string>,
  billId: string,
): boolean {
  if (sensitivityClass === 'standard') return true;
  return explicitlySharedBillIds.has(billId);
}

/** T-04: out of all analytics and training sets. No exceptions, no sampling. */
export function includeInAnalytics(sensitivityClass: SensitivityClass): boolean {
  return sensitivityClass === 'standard';
}

export function includeInTrainingSet(sensitivityClass: SensitivityClass): boolean {
  return sensitivityClass === 'standard';
}

/** E6: biometric lock is optional on the app, mandatory on the sensitive view. */
export function requiresBiometricUnlock(
  sensitivityClass: SensitivityClass,
  appLockEnabled: boolean,
): boolean {
  return sensitivityClass === 'sensitive' || appLockEnabled;
}
