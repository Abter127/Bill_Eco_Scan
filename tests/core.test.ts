import { describe, expect, it } from 'vitest';
import {
  addMoney, CurrencyMixError, formatMoney, isSpend, money, parseAmountToMinor,
  sumByCurrency, toDecimalString,
} from '../src/core/money.js';
import {
  addMonthsToDateKey, assessClockSkew, financialYearOf, financialYearFromLabel,
  localDateKey, resolveAmbiguousDate,
} from '../src/core/time.js';
import { gstinCheckDigit, isValidGstin, findGstin, panFromGstin } from '../src/core/gstin.js';
import { contentFingerprint } from '../src/core/fingerprint.js';
import { canTransition, countsAsSpend, isClaimable } from '../src/core/lifecycle.js';
import { applyConfidenceGate, gateFor, recordCorrection, hasUserEditedAmount } from '../src/core/confidence.js';
import { applyScreenDetection, higherProvenance, canBeTaxEvidence } from '../src/core/provenance.js';
import { parseSearchQuery, rankScore, shouldShowSearch } from '../src/core/search.js';
import { CLAIM_TOKEN_BYTES, newClaimTokenSecret } from '../src/core/ids.js';
import { TEST_GSTIN } from './helpers.js';

describe('money (E7 non-INR, E1 zero and negative)', () => {
  it('parses Indian amount formats into integer paise', () => {
    expect(parseAmountToMinor('1,234.50')).toBe(123450);
    expect(parseAmountToMinor('₹1234.5')).toBe(123450);
    expect(parseAmountToMinor('Rs. 620')).toBe(62000);
    expect(parseAmountToMinor('(120.00)')).toBe(-12000);
    expect(parseAmountToMinor('-0.50')).toBe(-50);
    expect(parseAmountToMinor('1,234')).toBe(123400);
    expect(parseAmountToMinor('not a number')).toBeNull();
  });

  it('never rounds through a float', () => {
    // 0.1 + 0.2 in paise is exact; in floats it is not.
    expect(addMoney(money(10), money(20)).minor).toBe(30);
    expect(toDecimalString(money(95500))).toBe('955.00');
    expect(toDecimalString(money(-50))).toBe('-0.50');
  });

  it('refuses to total across currencies', () => {
    expect(() => addMoney(money(100, 'INR'), money(100, 'AED'))).toThrow(CurrencyMixError);
  });

  it('buckets a mixed-currency history instead of adding it up', () => {
    const buckets = sumByCurrency([money(100, 'INR'), money(250, 'INR'), money(90, 'AED')]);
    expect(buckets).toEqual([
      { minor: 90, currency: 'AED' },
      { minor: 350, currency: 'INR' },
    ]);
  });

  it('treats a refund slip as a valid document but never as spend', () => {
    expect(isSpend(money(-12000))).toBe(false);
    expect(isSpend(money(0))).toBe(false);
    expect(isSpend(money(1))).toBe(true);
  });

  it('honours currencies with different minor units', () => {
    expect(parseAmountToMinor('100', 'JPY')).toBe(100);
    expect(formatMoney(money(100, 'JPY'), 'en-US')).toContain('100');
  });
});

describe('financial year (E7: India runs April-March)', () => {
  it('puts January in the previous financial year', () => {
    expect(financialYearOf('2026-01-15').label).toBe('2025-26');
    expect(financialYearOf('2026-03-31').label).toBe('2025-26');
  });

  it('starts a new financial year on 1 April', () => {
    const fy = financialYearOf('2026-04-01');
    expect(fy.label).toBe('2026-27');
    expect(fy.startDateKey).toBe('2026-04-01');
    expect(fy.endDateKey).toBe('2027-03-31');
  });

  it('round-trips a label', () => {
    expect(financialYearFromLabel('2026-27')?.startDateKey).toBe('2026-04-01');
    expect(financialYearFromLabel('2026-99')).toBeNull();
  });

  it('keeps an 11:58pm bill in its own day, in IST (E7 midnight boundary)', () => {
    // 18:29 UTC is 23:59 IST on the same day; 18:31 UTC is the next day.
    expect(localDateKey(new Date('2026-09-17T18:29:00Z'))).toBe('2026-09-17');
    expect(localDateKey(new Date('2026-09-17T18:31:00Z'))).toBe('2026-09-18');
  });
});

describe('ambiguous dates (E3, #6 on the bite-first list)', () => {
  it('refuses to pick between March and April for 03/04/2026', () => {
    const r = resolveAmbiguousDate('03/04/2026');
    expect(r.ambiguous).toBe(true);
    expect(r.dateKey).toBeNull();
    expect(r.candidates).toEqual(['2026-04-03', '2026-03-04']);
  });

  it('resolves when only one reading is a real date', () => {
    const r = resolveAmbiguousDate('25/12/2026');
    expect(r.ambiguous).toBe(false);
    expect(r.dateKey).toBe('2026-12-25');
  });

  it('uses the capture date to eliminate an impossible reading', () => {
    // Photographed on 10 March: the bill cannot be from 3 October.
    const r = resolveAmbiguousDate('03/10/2026', { captureDate: new Date('2026-03-10T12:00:00Z') });
    expect(r.ambiguous).toBe(false);
    // DMY reads 3 October, MDY reads 10 March. Only the latter precedes capture.
    expect(r.dateKey).toBe('2026-03-10');
    expect(r.order).toBe('MDY');
    expect(r.reason).toBe('disambiguated-by-capture-date');
  });

  it('treats a textual month and an ISO date as unambiguous', () => {
    expect(resolveAmbiguousDate('03-Apr-2026').dateKey).toBe('2026-04-03');
    expect(resolveAmbiguousDate('2026-04-03').dateKey).toBe('2026-04-03');
  });

  it('rejects an impossible date rather than coercing it', () => {
    expect(resolveAmbiguousDate('32/13/2026').dateKey).toBeNull();
    expect(resolveAmbiguousDate('32/13/2026').ambiguous).toBe(false);
  });

  it('never returns a date it did not verify', () => {
    for (const raw of ['', 'yesterday', '99/99/99']) {
      expect(resolveAmbiguousDate(raw).dateKey).toBeNull();
    }
  });
});

describe('clock skew (E7: terminal clocks lie)', () => {
  const server = new Date('2026-09-17T14:00:00Z');

  it('accepts a terminal clock within tolerance and trusts terminal time', () => {
    const a = assessClockSkew(new Date('2026-09-17T13:58:00Z'), server);
    expect(a.flagged).toBe(false);
    expect(a.trustedTime.toISOString()).toBe('2026-09-17T13:58:00.000Z');
  });

  it('flags a 1970 clock and falls back to server time', () => {
    const a = assessClockSkew(new Date('1970-01-01T00:00:00Z'), server);
    expect(a.flagged).toBe(true);
    expect(a.reason).toBe('terminal-clock-unset');
    expect(a.trustedTime).toEqual(server);
  });

  it('flags a clock set to next year', () => {
    const a = assessClockSkew(new Date('2027-09-17T14:00:00Z'), server);
    expect(a.flagged).toBe(true);
    expect(a.reason).toBe('terminal-clock-ahead');
    expect(a.trustedTime).toEqual(server);
  });
});

describe('GSTIN is the merchant identity (E3)', () => {
  it('validates the check digit', () => {
    expect(isValidGstin(TEST_GSTIN)).toBe(true);
    expect(gstinCheckDigit(TEST_GSTIN.slice(0, 14))).toBe(TEST_GSTIN[14]);
  });

  it('rejects a well-formed GSTIN with a wrong check digit', () => {
    const wrong = `${TEST_GSTIN.slice(0, 14)}${TEST_GSTIN[14] === 'A' ? 'B' : 'A'}`;
    expect(isValidGstin(wrong)).toBe(false);
  });

  it('rejects an invalid state code', () => {
    expect(isValidGstin(`99${TEST_GSTIN.slice(2)}`)).toBe(false);
  });

  it('finds a GSTIN inside receipt text', () => {
    expect(findGstin(`GSTIN : ${TEST_GSTIN}\nThank you`)).toBe(TEST_GSTIN);
    expect(panFromGstin(TEST_GSTIN)).toBe('AAPFU0939F');
  });
});

describe('content fingerprint (E1 reprint, #3 on the bite-first list)', () => {
  const base = {
    merchantId: 'm1', outletId: 'o1', documentNumber: 'INV/1',
    documentDateKey: '2026-09-17', grandTotalMinor: 95500, currency: 'INR',
    lines: [{ description: 'Basmati Rice 5kg', qty: 1, lineTotalMinor: 62000 }],
  };

  it('is stable across whitespace and case differences in the same document', () => {
    expect(contentFingerprint(base)).toBe(
      contentFingerprint({ ...base, lines: [{ description: 'BASMATI  RICE 5KG', qty: 1, lineTotalMinor: 62000 }] }),
    );
  });

  it('differs when the document number differs', () => {
    expect(contentFingerprint(base)).not.toBe(contentFingerprint({ ...base, documentNumber: 'INV/2' }));
  });

  it('differs when the total differs', () => {
    expect(contentFingerprint(base)).not.toBe(contentFingerprint({ ...base, grandTotalMinor: 95501 }));
  });
});

describe('lifecycle (C-02)', () => {
  it('lets an orphaned bill still be claimed', () => {
    expect(isClaimable('orphaned')).toBe(true);
    expect(canTransition('orphaned', 'claimed').ok).toBe(true);
  });

  it('never lets a claimed bill be un-owned', () => {
    expect(canTransition('claimed', 'unclaimed').ok).toBe(false);
    expect(canTransition('claimed', 'orphaned').ok).toBe(false);
    expect(canTransition('claimed', 'purged').ok).toBe(false);
  });

  it('only cancels a claimed bill via a linked document', () => {
    expect(canTransition('claimed', 'cancelled').ok).toBe(false);
    expect(canTransition('claimed', 'cancelled', { viaDocument: true }).ok).toBe(true);
  });

  it('will not orphan before the hold window elapses', () => {
    expect(canTransition('unclaimed', 'orphaned').ok).toBe(false);
    expect(canTransition('unclaimed', 'orphaned', { holdWindowElapsed: true }).ok).toBe(true);
  });

  it('keeps a cancelled bill in history but out of spend (E1)', () => {
    expect(countsAsSpend('cancelled')).toBe(false);
    expect(countsAsSpend('claimed')).toBe(true);
  });
});

describe('confidence gate (R-01)', () => {
  it('holds the total to a stricter bar than an item description', () => {
    expect(gateFor('grandTotalMinor').gate).toBeGreaterThan(gateFor('lines.0.description').gate);
    expect(gateFor('grandTotalMinor').blocking).toBe(true);
  });

  it('flags a total read at 0.96 but accepts a description at 0.96', () => {
    const out = applyConfidenceGate([
      { fieldPath: 'grandTotalMinor', source: 'extracted', confidence: 0.96, originalValue: '955', flagged: false, note: null },
      { fieldPath: 'lines.0.description', source: 'extracted', confidence: 0.96, originalValue: 'Rice', flagged: false, note: null },
    ]);
    expect(out.flagged.map((f) => f.fieldPath)).toEqual(['grandTotalMinor']);
    expect(out.blocking).toHaveLength(1);
  });

  it('never flags a printed field and always flags a derived one', () => {
    const out = applyConfidenceGate([
      { fieldPath: 'grandTotalMinor', source: 'printed', confidence: null, originalValue: '955', flagged: false, note: null },
      { fieldPath: 'subtotalMinor', source: 'derived', confidence: 1, originalValue: null, flagged: false, note: null },
    ]);
    expect(out.flagged.map((f) => f.fieldPath)).toEqual(['subtotalMinor']);
  });

  it('keeps the original extraction when a user corrects a field (E6)', () => {
    const original = [{
      fieldPath: 'grandTotalMinor', source: 'extracted' as const, confidence: 0.4,
      originalValue: '955', flagged: true, note: null,
    }];
    const corrected = recordCorrection(original, 'grandTotalMinor', '1955');
    expect(corrected.some((f) => f.source === 'extracted' && f.originalValue === '955')).toBe(true);
    expect(corrected.find((f) => f.source === 'user')?.note).toContain('955');
    expect(hasUserEditedAmount(corrected)).toBe(true);
  });
});

describe('provenance (R-03, E3)', () => {
  it('downgrades a photographed screen and never calls it an original', () => {
    const r = applyScreenDetection('photo_ocr', true);
    expect(r.provenance).toBe('photo_screen');
    expect(r.downgraded).toBe(true);
    expect(canBeTaxEvidence('photo_screen', true)).toBe(false);
  });

  it('keeps the shop’s own record canonical over a photo of it', () => {
    expect(higherProvenance('print_stream', 'photo_ocr')).toBe('print_stream');
    expect(higherProvenance('photo_ocr', 'irp')).toBe('irp');
  });

  it('refuses tax evidence without a GSTIN', () => {
    expect(canBeTaxEvidence('print_stream', false)).toBe(false);
    expect(canBeTaxEvidence('print_stream', true)).toBe(true);
  });
});

describe('search (R-02, journey J3)', () => {
  const now = new Date('2026-09-17T12:00:00Z');

  it('understands a half-memory: item, rough month, approximate amount', () => {
    const q = parseSearchQuery('kettle around 2000 in march', { now });
    expect(q.terms).toContain('kettle');
    expect(q.amount?.minMinor).toBeLessThan(200000);
    expect(q.amount?.maxMinor).toBeGreaterThan(200000);
    expect(q.dates?.fromKey).toBe('2026-03-01');
    expect(q.dates?.toKey).toBe('2026-03-31');
  });

  it('reads a bare month as the most recent one, never a future one', () => {
    // In September, "december" means last December.
    expect(parseSearchQuery('december', { now }).dates?.fromKey).toBe('2025-12-01');
    expect(parseSearchQuery('august', { now }).dates?.fromKey).toBe('2026-08-01');
  });

  it('handles under / over / between', () => {
    expect(parseSearchQuery('under 500', { now }).amount).toEqual({ minMinor: 0, maxMinor: 50000, label: 'under ₹500' });
    expect(parseSearchQuery('between 1000 and 2000', { now }).amount?.minMinor).toBe(100000);
    expect(parseSearchQuery('over 1000', { now }).amount?.minMinor).toBe(100000);
  });

  it('extracts a payment method', () => {
    expect(parseSearchQuery('paid by upi last month', { now }).paymentMethodHint).toBe('upi');
  });

  it('ranks a recent item match above an old perfect text match', () => {
    const recentItem = rankScore(
      { textScore: 0.6, itemMatch: true, merchantMatch: false, documentDateKey: '2026-09-01', amountInRange: false },
      '2026-09-17',
    );
    const oldPerfect = rankScore(
      { textScore: 1, itemMatch: false, merchantMatch: true, documentDateKey: '2023-09-01', amountInRange: false },
      '2026-09-17',
    );
    expect(recentItem).toBeGreaterThan(oldPerfect);
  });

  it('hides search over a list short enough to read (E8)', () => {
    expect(shouldShowSearch(3)).toBe(false);
    expect(shouldShowSearch(50)).toBe(true);
  });
});

describe('claim token entropy (E6)', () => {
  it('exceeds the 128-bit floor', () => {
    expect(CLAIM_TOKEN_BYTES * 8).toBeGreaterThanOrEqual(128);
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 500 }, () => newClaimTokenSecret()));
    expect(seen.size).toBe(500);
  });
});

describe('date arithmetic clamps rather than overflows', () => {
  it('adds a month to 31 January without landing in March', () => {
    expect(addMonthsToDateKey('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsToDateKey('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonthsToDateKey('2026-09-17', 12)).toBe('2027-09-17');
  });
});
