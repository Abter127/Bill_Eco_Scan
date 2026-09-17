import { higherProvenance, provenanceRank } from './provenance.js';
import type { DocumentType, Provenance } from './schema.js';

/**
 * Dedupe (E3, and #4 on the will-bite-first list).
 *
 * The asymmetry that decides every rule here:
 *
 *   "The dangerous dedupe failure isn't a missed duplicate, it's a false merge."
 *
 * A missed duplicate is a tidiness problem the user can fix in two taps. A
 * false merge quietly deletes a purchase they actually made, and they find out
 * at a service centre eleven months later. So the bar for merging automatically
 * is a matching document number; everything softer than that produces `ask`.
 */

export interface DedupeCandidate {
  id: string;
  merchantId: string;
  documentType: DocumentType;
  documentNumber: string | null;
  financialYear: string | null;
  documentDateKey: string | null;
  /** Milliseconds since epoch of the document's own time, where known. */
  documentTimeMs: number | null;
  grandTotalMinor: number;
  currency: string;
  contentFingerprint: string;
  provenance: Provenance;
  lineCount: number;
}

export type DedupeVerdict = 'merge' | 'ask' | 'distinct';

export interface DedupeDecision {
  verdict: DedupeVerdict;
  reason: string;
  /** For `merge`, which record stays canonical and which becomes an attachment. */
  canonicalId?: string;
  attachmentId?: string;
  canonicalProvenance?: Provenance;
  /** Confidence in the *sameness*, surfaced in the "is this the same bill?" prompt. */
  similarity: number;
}

/** Same purchase arriving twice is minutes apart, not hours. */
export const SAME_PURCHASE_WINDOW_MS = 15 * 60 * 1000;

function normalizeDocNumber(n: string | null): string | null {
  if (!n) return null;
  const s = n.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length === 0 ? null : s;
}

function pickCanonical(a: DedupeCandidate, b: DedupeCandidate): DedupeDecision {
  const winner = provenanceRank(a.provenance) >= provenanceRank(b.provenance) ? a : b;
  const loser = winner === a ? b : a;
  return {
    verdict: 'merge',
    reason: '',
    canonicalId: winner.id,
    attachmentId: loser.id,
    canonicalProvenance: higherProvenance(a.provenance, b.provenance),
    similarity: 1,
  };
}

export function assessDuplicate(a: DedupeCandidate, b: DedupeCandidate): DedupeDecision {
  // --- hard separators -----------------------------------------------------
  if (a.id === b.id) {
    return { verdict: 'distinct', reason: 'same record', similarity: 1 };
  }
  if (a.merchantId !== b.merchantId) {
    return { verdict: 'distinct', reason: 'different merchant', similarity: 0 };
  }
  // A credit note is never a duplicate of the bill it refunds — it is a linked
  // document (E4). Merging them would erase the return from history.
  if (a.documentType !== b.documentType) {
    return { verdict: 'distinct', reason: 'different document types are linked, never merged', similarity: 0 };
  }
  if (a.currency !== b.currency) {
    return { verdict: 'distinct', reason: 'different currency', similarity: 0 };
  }

  // --- byte-identical content ---------------------------------------------
  // This is the reprint path: the same document captured twice, character for
  // character. Safe to merge on its own.
  if (a.contentFingerprint === b.contentFingerprint) {
    const d = pickCanonical(a, b);
    return { ...d, reason: 'identical content fingerprint' };
  }

  const aNum = normalizeDocNumber(a.documentNumber);
  const bNum = normalizeDocNumber(b.documentNumber);

  // --- document numbers present on both -----------------------------------
  if (aNum && bNum) {
    // E7: invoice numbers are unique per merchant *per financial year*. Two
    // records with the same number in different years are different documents.
    const sameYear =
      a.financialYear === null || b.financialYear === null || a.financialYear === b.financialYear;

    if (aNum !== bNum) {
      return {
        verdict: 'distinct',
        reason: 'different document numbers at the same merchant — two purchases, not one',
        similarity: 0.2,
      };
    }
    if (!sameYear) {
      return {
        verdict: 'distinct',
        reason: 'same document number in different financial years — sequences reset at year end',
        similarity: 0.3,
      };
    }
    if (a.grandTotalMinor !== b.grandTotalMinor) {
      // Same number, same year, different total: this is an amendment or a
      // mis-read, not a duplicate. Ask rather than pick.
      return {
        verdict: 'ask',
        reason: 'same document number but different totals — may be an amended bill or a mis-read amount',
        similarity: 0.6,
      };
    }
    const d = pickCanonical(a, b);
    return { ...d, reason: 'matching document number, merchant, financial year and total' };
  }

  // --- at least one document number missing --------------------------------
  // Everything below here is the false-merge danger zone. The PRD's rule is
  // "require the document number to match, or ask, before merging", so nothing
  // in this branch may return `merge`.
  if (a.grandTotalMinor !== b.grandTotalMinor) {
    return { verdict: 'distinct', reason: 'different totals', similarity: 0.1 };
  }

  const sameDay =
    a.documentDateKey !== null && a.documentDateKey === b.documentDateKey;
  if (!sameDay) {
    return { verdict: 'distinct', reason: 'different document dates', similarity: 0.2 };
  }

  const withinWindow =
    a.documentTimeMs !== null &&
    b.documentTimeMs !== null &&
    Math.abs(a.documentTimeMs - b.documentTimeMs) <= SAME_PURCHASE_WINDOW_MS;

  const oneSideHasNumber = Boolean(aNum) !== Boolean(bNum);

  // Same shop, same day, same amount, and one record knows its document number
  // while the other does not. Very likely the same purchase captured twice —
  // and also exactly what "bought the same thing twice" looks like.
  const similarity = withinWindow ? (oneSideHasNumber ? 0.85 : 0.75) : 0.55;

  return {
    verdict: 'ask',
    reason: withinWindow
      ? 'same shop, day, amount and within minutes of each other, but no document number to confirm it'
      : 'same shop, day and amount, but no document number and no close timestamp',
    similarity,
  };
}

/**
 * The prompt shown when the verdict is `ask`. Written so that the safe answer
 * (keep both) is the default — a user who taps through without reading keeps
 * their purchase.
 */
export interface DuplicatePrompt {
  question: string;
  detail: string;
  defaultChoice: 'keep_both';
  choices: Array<{ id: 'keep_both' | 'same_bill'; label: string; description: string }>;
}

export function duplicatePrompt(decision: DedupeDecision, merchantName: string): DuplicatePrompt {
  return {
    question: `Is this the same bill from ${merchantName}?`,
    detail: decision.reason,
    defaultChoice: 'keep_both',
    choices: [
      {
        id: 'keep_both',
        label: 'No — these are two separate purchases',
        description: 'Both bills stay in your history.',
      },
      {
        id: 'same_bill',
        label: 'Yes — it’s the same bill',
        description: 'We’ll keep one record and attach the other photo to it. Nothing is deleted.',
      },
    ],
  };
}

/**
 * What a merge actually does. Note that nothing is destroyed: the lower-
 * provenance record survives as an attachment carrying its own image, so a user
 * who merges by mistake can still see what they captured.
 */
export interface MergePlan {
  canonicalId: string;
  attachmentId: string;
  canonicalProvenance: Provenance;
  keepAttachmentImage: boolean;
  reversible: boolean;
}

export function planMerge(decision: DedupeDecision): MergePlan | null {
  if (decision.verdict !== 'merge' || !decision.canonicalId || !decision.attachmentId) return null;
  return {
    canonicalId: decision.canonicalId,
    attachmentId: decision.attachmentId,
    canonicalProvenance: decision.canonicalProvenance!,
    keepAttachmentImage: true,
    reversible: true,
  };
}
