import { sha256Hex } from './ids.js';

/**
 * E1 "Reprint": fingerprint *content*, not print events.
 *
 * A cashier reprinting a smudged slip sends a byte-identical stream a minute
 * later. If we keyed on the print event we would issue a second bill and a
 * second claim token for one purchase — which happens hourly in every shop and
 * is #3 on the PRD's "will bite first" list.
 *
 * The fingerprint deliberately excludes: print timestamp, the REPRINT banner,
 * copy markers, and any sequence counter the POS bumps per print. It includes
 * everything that identifies the *transaction*.
 */
export interface FingerprintInput {
  merchantId: string;
  outletId: string;
  documentNumber: string | null;
  /** Local date key of the document, not of the print. */
  documentDateKey: string | null;
  grandTotalMinor: number;
  currency: string;
  lines: Array<{ description: string; qty: number; lineTotalMinor: number }>;
}

const FIELD_SEPARATOR = String.fromCharCode(0);

function normalizeText(s: string): string {
  return s
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

export function contentFingerprint(input: FingerprintInput): string {
  const canonical = [
    input.merchantId,
    input.outletId,
    input.documentNumber ? normalizeText(input.documentNumber) : '',
    input.documentDateKey ?? '',
    String(input.grandTotalMinor),
    input.currency.toUpperCase(),
    input.lines
      .map((l) => `${normalizeText(l.description)}|${l.qty}|${l.lineTotalMinor}`)
      .join(';'),
  ].join(FIELD_SEPARATOR);
  return sha256Hex(canonical);
}

/**
 * Reprints are only the same document when they arrive close together. Two
 * genuinely separate purchases of the same thing at the same shop on the same
 * day (E3) are usually minutes or hours apart and carry different document
 * numbers — which is why documentNumber is inside the fingerprint and why the
 * window is short.
 */
export const REPRINT_WINDOW_MS = 30 * 60 * 1000;

export function isWithinReprintWindow(firstSeen: Date, now: Date): boolean {
  return now.getTime() - firstSeen.getTime() <= REPRINT_WINDOW_MS;
}
