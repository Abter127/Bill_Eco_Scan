/**
 * GSTIN is the merchant's identity (E3). The trade name printed on the slip is
 * only a display string — "Sharma General Store" and "SHARMA ENTERPRISES PVT
 * LTD" are one merchant, and resolving on the name would split them into two.
 */

const BASE36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/;

/** State codes 01-38 plus 97 (other territory) and 99 (centre). */
function validStateCode(code: string): boolean {
  const n = Number(code);
  return (n >= 1 && n <= 38) || n === 97 || n === 99;
}

/**
 * The GSTIN check digit: base-36 weighted sum with alternating factors 1 and 2,
 * where each product contributes quotient + remainder mod 36.
 */
export function gstinCheckDigit(first14: string): string | null {
  if (first14.length !== 14) return null;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = BASE36.indexOf(first14[i]!);
    if (v < 0) return null;
    const factor = i % 2 === 0 ? 1 : 2;
    const product = v * factor;
    sum += Math.floor(product / 36) + (product % 36);
  }
  return BASE36[(36 - (sum % 36)) % 36]!;
}

export function isValidGstin(raw: string): boolean {
  const g = raw.trim().toUpperCase();
  if (!GSTIN_PATTERN.test(g)) return false;
  if (!validStateCode(g.slice(0, 2))) return false;
  return gstinCheckDigit(g.slice(0, 14)) === g[14];
}

/** PAN sits inside the GSTIN at positions 3-12 — the stable entity identifier. */
export function panFromGstin(raw: string): string | null {
  const g = raw.trim().toUpperCase();
  if (!GSTIN_PATTERN.test(g)) return null;
  return g.slice(2, 12);
}

export function stateCodeFromGstin(raw: string): string | null {
  const g = raw.trim().toUpperCase();
  if (!GSTIN_PATTERN.test(g)) return null;
  return g.slice(0, 2);
}

/** Finds the first structurally valid GSTIN in receipt text. */
export function findGstin(text: string): string | null {
  const candidates = text.toUpperCase().match(/\b[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9]\b/g);
  if (!candidates) return null;
  return candidates.find(isValidGstin) ?? candidates[0] ?? null;
}
