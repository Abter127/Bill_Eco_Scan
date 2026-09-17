import type { FieldConfidence } from './schema.js';

/**
 * The confidence gate (R-01).
 *
 * The acceptance criterion: "A faded creased receipt is either correct or
 * visibly flagged — never wrong and confident."
 *
 * The success metric that forces per-field gates: extraction accuracy is
 * tracked *on the total*, not per document, because "95% document accuracy with
 * 5% total-amount error is a broken product wearing a good number". So the
 * total carries a far stricter gate than an item description — getting a
 * description slightly wrong costs a search hit; getting the total wrong costs
 * a warranty claim or a tax filing.
 */

export interface FieldGate {
  /** Minimum confidence to render as final. */
  gate: number;
  /** A field the user must resolve before the bill is treated as complete. */
  blocking: boolean;
  label: string;
}

/** Exact paths first, then prefix rules for repeated structures. */
const EXACT_GATES: Record<string, FieldGate> = {
  grandTotalMinor: { gate: 0.985, blocking: true, label: 'Total' },
  documentDateKey: { gate: 0.95, blocking: true, label: 'Date' },
  gstin: { gate: 0.97, blocking: false, label: 'GSTIN' },
  documentNumber: { gate: 0.93, blocking: false, label: 'Bill number' },
  taxTotalMinor: { gate: 0.95, blocking: false, label: 'Tax' },
  subtotalMinor: { gate: 0.93, blocking: false, label: 'Subtotal' },
  merchantName: { gate: 0.85, blocking: false, label: 'Shop' },
  paymentMethod: { gate: 0.8, blocking: false, label: 'Paid by' },
};

const PREFIX_GATES: Array<[RegExp, FieldGate]> = [
  [/^lines\.\d+\.lineTotalMinor$/, { gate: 0.95, blocking: false, label: 'Item amount' }],
  [/^lines\.\d+\.serialNumber$/, { gate: 0.97, blocking: false, label: 'Serial number' }],
  [/^lines\.\d+\.qty$/, { gate: 0.9, blocking: false, label: 'Quantity' }],
  [/^lines\.\d+\.description$/, { gate: 0.82, blocking: false, label: 'Item' }],
  [/^lines\.\d+\./, { gate: 0.85, blocking: false, label: 'Item detail' }],
];

const FALLBACK: FieldGate = { gate: 0.9, blocking: false, label: 'Field' };

export function gateFor(fieldPath: string): FieldGate {
  const exact = EXACT_GATES[fieldPath];
  if (exact) return exact;
  for (const [pattern, gate] of PREFIX_GATES) {
    if (pattern.test(fieldPath)) return gate;
  }
  return FALLBACK;
}

export interface GateOutcome {
  fields: FieldConfidence[];
  /** Fields rendered highlighted and tappable (J2 step 3). */
  flagged: FieldConfidence[];
  /** Flagged fields the user must resolve before the bill is "final". */
  blocking: FieldConfidence[];
  /** True when nothing needs the user's attention. */
  clean: boolean;
}

/**
 * Applies per-field gates. `printed` and `user` sources are not guesses and are
 * never flagged; `derived` is always flagged regardless of arithmetic certainty
 * because the user must see that we computed rather than read it (E3).
 */
export function applyConfidenceGate(fields: FieldConfidence[]): GateOutcome {
  const out = fields.map((f) => {
    if (f.source === 'printed' || f.source === 'user') {
      return { ...f, flagged: false };
    }
    if (f.source === 'derived') {
      return { ...f, flagged: true };
    }
    const { gate } = gateFor(f.fieldPath);
    return { ...f, flagged: (f.confidence ?? 0) < gate };
  });

  const flagged = out.filter((f) => f.flagged);
  const blocking = flagged.filter((f) => gateFor(f.fieldPath).blocking);
  return { fields: out, flagged, blocking, clean: flagged.length === 0 };
}

/**
 * A correction is recorded as a new field entry with source `user`. The
 * original extraction is never overwritten (J2 step 4, E6 "user edits an
 * extracted amount upward") — exports carry both, so an inflated reimbursement
 * claim is visible to whoever receives it.
 */
export function recordCorrection(
  existing: FieldConfidence[],
  fieldPath: string,
  newValue: string,
  /**
   * The value on the bill before this correction. Passed in because a bill that
   * arrived structured (from the agent or a connector) has no extraction row to
   * read the previous value from, and losing it would hide the edit.
   */
  currentValue: string | null = null,
): FieldConfidence[] {
  const prior = existing.find((f) => f.fieldPath === fieldPath && f.source !== 'user');
  const originalValue = prior?.originalValue ?? currentValue;
  const kept = existing.filter((f) => !(f.fieldPath === fieldPath && f.source === 'user'));
  return [
    ...kept,
    {
      fieldPath,
      source: 'user',
      confidence: null,
      originalValue,
      flagged: false,
      note:
        originalValue !== null && originalValue !== newValue
          ? `corrected by the account holder from "${originalValue}"`
          : 'entered by the account holder',
    },
  ];
}

/**
 * True when any amount on this bill was changed by the user (export flag, E6).
 *
 * A `user` source on an amount *is* the edit — whether we can also show what it
 * used to be is a separate question, and requiring the old value here would let
 * the flag drop off structured bills that never had an extraction row.
 */
export function hasUserEditedAmount(fields: FieldConfidence[]): boolean {
  return fields.some(
    (f) =>
      f.source === 'user' &&
      /(?:grandTotalMinor|taxTotalMinor|subtotalMinor|lineTotalMinor)$/.test(f.fieldPath),
  );
}
