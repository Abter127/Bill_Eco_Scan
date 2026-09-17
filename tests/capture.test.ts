import { describe, expect, it } from 'vitest';
import { submitCapture, processCapture, applyCorrection, quotaDecision } from '../src/services/capture.js';
import { StaticOcrAdapter } from '../src/services/ocr/fixture-adapter.js';
import { assessDuplicate, type DedupeCandidate } from '../src/core/dedupe.js';
import * as billsRepo from '../src/db/repo/bills.js';
import * as registry from '../src/db/repo/registry.js';
import { makeWorld, ocrFromReceipt, ocrLines, ocrResult, TEST_GSTIN } from './helpers.js';

const NOW = new Date('2026-09-17T14:12:00Z');

async function capture(
  w: ReturnType<typeof makeWorld>,
  result: ReturnType<typeof ocrResult>,
  imageRef = 'img/1.jpg',
) {
  const c = submitCapture(w.db, w.accountId, imageRef);
  return processCapture(w.db, c.id, new StaticOcrAdapter(result), { now: NOW });
}

describe('J2 — the photo is usable before extraction finishes (E8)', () => {
  it('stores and returns the capture before any OCR runs', () => {
    const w = makeWorld();
    const c = submitCapture(w.db, w.accountId, 'img/receipt.jpg');
    expect(c.state).toBe('queued');
    expect(c.imageRef).toBe('img/receipt.jpg');
  });
});

describe('E3 — not a receipt at all', () => {
  it('rejects with a specific reason and never creates a ghost bill', async () => {
    const w = makeWorld();
    const r = await capture(w, ocrResult({
      lines: ocrLines([['PANEER TIKKA 320', 0.9], ['DAL MAKHANI 280', 0.9]]),
      isReceipt: false,
      rejectReason: 'this looks like a menu, not a bill',
    }));

    expect(r.state).toBe('rejected');
    expect(r.billId).toBeNull();
    expect(r.rejectReason).toContain('menu');
    expect(r.rejectReason).toMatch(/enter the details yourself/i);
    expect(w.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM bills').get()!.n).toBe(0);
  });

  it('rejects when no amount can be read anywhere', async () => {
    const w = makeWorld();
    const r = await capture(w, ocrResult({
      lines: ocrLines([['Sharma General Store', 0.9], ['illegible', 0.3], ['illegible', 0.3]]),
    }));
    expect(r.state).toBe('rejected');
    expect(r.rejectReason).toMatch(/could not read an amount/i);
  });
});

describe('E3 — a photo of a screen is never an original', () => {
  it('downgrades provenance and marks the record as not a tax invoice', async () => {
    const w = makeWorld();
    const r = await capture(w, ocrResult({
      lines: ocrFromReceipt({ total: 955 }),
      screenDetected: true,
    }));

    const bill = billsRepo.getBill(w.db, r.billId!)!;
    expect(bill.provenance).toBe('photo_screen');
    expect(bill.notATaxInvoice).toBe(true);
    expect(bill.expensable).toBe(false);
    expect(r.warnings.join(' ')).toMatch(/photograph of a display/i);
  });
});

describe('E3 — a handwritten kacha bill', () => {
  it('is accepted as a low-provenance record, labelled not a tax invoice', async () => {
    const w = makeWorld({ gstin: null });
    const r = await capture(w, ocrResult({
      lines: ocrLines([
        ['Gupta Kirana', 0.8],
        ['Aata 5kg     250', 0.7],
        ['Total        250', 0.75],
      ]),
    }));

    const bill = billsRepo.getBill(w.db, r.billId!)!;
    expect(bill.documentType).toBe('kacha');
    expect(bill.notATaxInvoice).toBe(true);
    expect(bill.grandTotalMinor).toBe(25000);
  });
});

describe('E3 — multi-script and multi-document photos', () => {
  it('warns about a mixed-script bill rather than failing silently', async () => {
    const w = makeWorld();
    const r = await capture(w, ocrResult({
      lines: ocrFromReceipt({ total: 955 }),
      scripts: ['Latn', 'Deva'],
    }));
    expect(r.warnings.join(' ')).toMatch(/mixes scripts/i);
    expect(r.billId).not.toBeNull();
  });

  it('splits two documents in one photo into separate captures', async () => {
    const w = makeWorld();
    const r = await capture(w, ocrResult({
      lines: ocrFromReceipt({ total: 955 }),
      documentCount: 2,
    }));
    expect(r.additionalCaptureIds).toHaveLength(1);
    expect(r.warnings.join(' ')).toMatch(/2 documents/);
  });

  it('warns when the middle of a long receipt is missing', async () => {
    const w = makeWorld();
    const r = await capture(w, ocrResult({
      lines: ocrFromReceipt({ total: 955 }),
      stitch: { segments: 3, missingMiddle: true, overlapConfidence: 0.4 },
    }));
    expect(r.warnings.join(' ')).toMatch(/middle of this receipt is missing/i);
  });
});

describe('E3 — handwriting over printed text', () => {
  it('keeps the printed value and puts the annotation in front of the user', async () => {
    const w = makeWorld();
    const r = await capture(w, ocrResult({
      lines: ocrFromReceipt({ total: 955 }),
      annotations: [{ note: '900 /-', printedValue: '955.00' }],
    }));

    const bill = billsRepo.getBill(w.db, r.billId!)!;
    expect(bill.grandTotalMinor).toBe(95500); // the printed value stands
    const annotation = bill.fields.find((f) => f.fieldPath === 'annotation');
    expect(annotation?.flagged).toBe(true);
    expect(annotation?.note).toContain('900 /-');
    expect(r.warnings.join(' ')).toMatch(/handwriting/i);
  });
});

describe('E3 — low confidence is flagged, never quietly accepted', () => {
  it('flags a total read at low confidence and marks it blocking', async () => {
    const w = makeWorld();
    const r = await capture(w, ocrResult({
      lines: ocrFromReceipt({ total: 955 }, 0.55),
    }));

    expect(r.state).toBe('needs_review');
    const flagged = r.view!.flaggedFields.map((f) => f.fieldPath);
    expect(flagged).toContain('grandTotalMinor');
    expect(r.view!.blockingFieldCount).toBeGreaterThan(0);
  });

  it('does not flag a cleanly read bill whose lines reconcile', async () => {
    const w = makeWorld();
    const r = await capture(w, ocrResult({
      lines: ocrFromReceipt({ items: [{ name: 'Basmati Rice 5kg', amount: 955 }], total: 955 }, 0.995),
    }));
    expect(r.view!.flaggedFields).toHaveLength(0);
    expect(r.state).toBe('done');
  });

  it('flags the line sum when the items do not reconcile to the total (E1)', async () => {
    const w = makeWorld();
    // One item at 620 against a printed total of 955: a real mismatch.
    const r = await capture(w, ocrResult({
      lines: ocrFromReceipt({ items: [{ name: 'Basmati Rice 5kg', amount: 620 }], total: 955 }, 0.995),
    }));
    expect(r.view!.flaggedFields.map((f) => f.fieldPath)).toContain('lineSumMinor');
    expect(r.view!.totals.grandTotal).toContain('955'); // printed total still wins
    expect(r.view!.warnings.join(' ')).toMatch(/do not add up/i);
  });
});

describe('E3 — dedupe: a false merge is worse than a missed duplicate (#4)', () => {
  const base: DedupeCandidate = {
    id: 'a', merchantId: 'm1', documentType: 'tax_invoice', documentNumber: null,
    financialYear: '2026-27', documentDateKey: '2026-09-17',
    documentTimeMs: Date.parse('2026-09-17T14:00:00Z'),
    grandTotalMinor: 50000, currency: 'INR', contentFingerprint: 'fa',
    provenance: 'photo_ocr', lineCount: 1,
  };

  it('asks rather than merging when neither side has a document number', () => {
    const d = assessDuplicate(base, { ...base, id: 'b', contentFingerprint: 'fb' });
    expect(d.verdict).toBe('ask');
  });

  it('merges only on a matching document number', () => {
    const d = assessDuplicate(
      { ...base, documentNumber: 'INV/7' },
      { ...base, id: 'b', documentNumber: 'INV/7', contentFingerprint: 'fb', provenance: 'print_stream' },
    );
    expect(d.verdict).toBe('merge');
    expect(d.canonicalId).toBe('b'); // the shop's own record stays canonical
  });

  it('treats different document numbers as two purchases, not a duplicate', () => {
    const d = assessDuplicate(
      { ...base, documentNumber: 'INV/7' },
      { ...base, id: 'b', documentNumber: 'INV/8', contentFingerprint: 'fb' },
    );
    expect(d.verdict).toBe('distinct');
  });

  it('does not merge the same number across financial years (E7)', () => {
    const d = assessDuplicate(
      { ...base, documentNumber: 'INV/1', financialYear: '2025-26' },
      { ...base, id: 'b', documentNumber: 'INV/1', financialYear: '2026-27', contentFingerprint: 'fb' },
    );
    expect(d.verdict).toBe('distinct');
  });

  it('never merges a credit note into the bill it refunds', () => {
    const d = assessDuplicate(base, { ...base, id: 'b', documentType: 'credit_note' });
    expect(d.verdict).toBe('distinct');
  });

  it('asks when the number matches but the totals differ', () => {
    const d = assessDuplicate(
      { ...base, documentNumber: 'INV/7' },
      { ...base, id: 'b', documentNumber: 'INV/7', grandTotalMinor: 60000, contentFingerprint: 'fb' },
    );
    expect(d.verdict).toBe('ask');
  });

  it('defaults the ask-prompt to keeping both', async () => {
    const w = makeWorld();
    // Same shop, day and amount; no document number on either.
    const spec = { total: 500, billNumber: null as null, items: [{ name: 'Kettle', amount: 500 }] };
    await capture(w, ocrResult({ lines: ocrFromReceipt(spec) }), 'img/a.jpg');
    const second = await capture(
      w,
      ocrResult({ lines: ocrFromReceipt({ ...spec, items: [{ name: 'Table lamp', amount: 500 }] }) }),
      'img/b.jpg',
    );

    expect(second.state).toBe('needs_review');
    expect(second.duplicatePrompt?.defaultChoice).toBe('keep_both');
    expect(second.duplicatePrompt?.choices[1]!.description).toMatch(/Nothing is deleted/i);
  });
});

describe('E3 — merchant resolution is by GSTIN, never by name', () => {
  it('does not split one merchant into two on a trade-name mismatch', async () => {
    const w = makeWorld();
    const before = w.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM merchants').get()!.n;

    // The slip prints the trade name; our record holds the legal name.
    const r = await capture(w, ocrResult({
      lines: ocrFromReceipt({ merchantName: 'SHARMA GEN STORE (SEC 17)', gstin: TEST_GSTIN, total: 300 }),
    }));

    expect(w.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM merchants').get()!.n).toBe(before);
    expect(billsRepo.getBill(w.db, r.billId!)!.merchantId).toBe(w.merchantId);
  });

  it('creates an unverified merchant when there is no GSTIN to resolve on', async () => {
    const w = makeWorld();
    const r = await capture(w, ocrResult({
      lines: ocrLines([['Gupta Kirana', 0.9], ['Aata 5kg   250', 0.9], ['Total      250', 0.9]]),
    }));
    const bill = billsRepo.getBill(w.db, r.billId!)!;
    expect(bill.merchantId).not.toBe(w.merchantId);
    expect(registry.getMerchant(w.db, bill.merchantId)!.verifiedBadge).toBe(false);
    expect(r.warnings.join(' ')).toMatch(/don’t know this shop yet/i);
  });
});

describe('J2 step 4 — corrections never overwrite provenance', () => {
  it('keeps the original extraction and marks the field as user-corrected', async () => {
    const w = makeWorld();
    const r = await capture(w, ocrResult({ lines: ocrFromReceipt({ total: 955 }, 0.6) }));

    const corrected = applyCorrection(w.db, r.billId!, w.accountId, 'grandTotalMinor', '90000', NOW);
    expect(corrected.ok).toBe(true);

    const bill = billsRepo.getBill(w.db, r.billId!)!;
    expect(bill.grandTotalMinor).toBe(90000);
    expect(bill.fields.some((f) => f.source === 'extracted' && f.fieldPath === 'grandTotalMinor')).toBe(true);
    expect(corrected.view!.userEditedAmounts).toBe(true);
  });

  it('clears the ambiguous-date flag and restarts the countdown on correction', async () => {
    const w = makeWorld();
    const r = await capture(w, ocrResult({ lines: ocrFromReceipt({ total: 955, dateText: '03/04/2026' }) }));

    expect(billsRepo.getBill(w.db, r.billId!)!.documentDateAmbiguous).toBe(true);
    applyCorrection(w.db, r.billId!, w.accountId, 'documentDateKey', '2026-04-03', NOW);

    const bill = billsRepo.getBill(w.db, r.billId!)!;
    expect(bill.documentDateAmbiguous).toBe(false);
    expect(bill.documentDateKey).toBe('2026-04-03');
    expect(bill.financialYear).toBe('2026-27');
  });

  it('refuses a correction from someone who does not own the bill', async () => {
    const w = makeWorld();
    const r = await capture(w, ocrResult({ lines: ocrFromReceipt({ total: 955 }) }));
    expect(applyCorrection(w.db, r.billId!, 'someone-else', 'grandTotalMinor', '1', NOW).ok).toBe(false);
  });
});

describe('E7 — storage quota never costs someone a receipt', () => {
  it('accepts the capture at every quota level', () => {
    for (const ratio of [0.1, 0.85, 0.99, 1.5]) {
      const d = quotaDecision(ratio * 1000, 1000);
      expect(d.accept).toBe(true);
    }
  });

  it('warns early and degrades to compression rather than refusing', () => {
    expect(quotaDecision(850, 1000).warnUser).toBe(true);
    expect(quotaDecision(850, 1000).compress).toBe(false);
    expect(quotaDecision(980, 1000).compress).toBe(true);
    expect(quotaDecision(980, 1000).message).toMatch(/still being kept/i);
  });
});
