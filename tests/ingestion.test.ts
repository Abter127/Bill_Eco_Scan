import { describe, expect, it } from 'vitest';
import { parseEscPosStream, splitOnCutBoundaries } from '../src/core/escpos.js';
import { classifyDocument } from '../src/core/classify.js';
import { extractBillFromText } from '../src/core/extract.js';
import { ingestBill, ingestPrintStream } from '../src/services/issuance.js';
import { billPayloadSchema } from '../src/core/schema.js';
import * as billsRepo from '../src/db/repo/bills.js';
import * as ledgers from '../src/db/repo/ledgers.js';
import { newIdempotencyKey } from '../src/core/ids.js';
import {
  CUT, escposKot, escposQuote, escposReceipt, escposShiftReport, escposTestPrint,
  makeWorld, TEST_GSTIN,
} from './helpers.js';

const NOW = new Date('2026-09-17T14:12:00Z');

function ctx(world: ReturnType<typeof makeWorld>, now = NOW) {
  return { terminalId: world.terminalId, outletId: world.outletId, merchantId: world.merchantId, now };
}

function payload(over: Partial<Record<string, unknown>> = {}) {
  return billPayloadSchema.parse({
    idempotencyKey: newIdempotencyKey(),
    outletId: 'set-by-ctx',
    terminalId: 'set-by-ctx',
    terminalTime: NOW.toISOString(),
    documentNumber: 'INV/2026/0417',
    documentDateKey: '2026-09-17',
    grandTotalMinor: 95500,
    lines: [{ lineNo: 0, description: 'Basmati Rice 5kg', qty: 1, lineTotalMinor: 95500 }],
    ...over,
  });
}

describe('ESC/POS framing (M-01, E1 two terminals one printer)', () => {
  it('frames documents on cut boundaries', () => {
    const stream = Buffer.concat([escposReceipt({ total: 100 }), escposReceipt({ total: 200 })]);
    expect(splitOnCutBoundaries(stream)).toHaveLength(2);
    expect(parseEscPosStream(stream).every((f) => f.structurallyValid)).toBe(true);
  });

  it('rejects an interleaved fragment rather than guessing a repair', () => {
    // Two tills writing into one spool: a second job's initialise lands inside
    // the first document, before its cut.
    const first = escposReceipt({ total: 100, noCut: true });
    const second = escposReceipt({ total: 200, merchantName: 'Other Till' });
    const spliced = Buffer.concat([first, second]);

    const fragments = parseEscPosStream(spliced);
    expect(fragments).toHaveLength(1);
    expect(fragments[0]!.structurallyValid).toBe(false);
    expect(fragments[0]!.validationErrors).toContain('interleaved-print-jobs');
  });

  it('marks a fragment with no cut as invalid', () => {
    const fragments = parseEscPosStream(escposReceipt({ total: 100, noCut: true }));
    expect(fragments[0]!.validationErrors).toContain('no-cut-boundary');
  });

  it('survives a truncated stream without throwing', () => {
    const truncated = escposReceipt({ total: 100 }).subarray(0, 40);
    expect(() => parseEscPosStream(truncated)).not.toThrow();
  });

  it('handles a Devanagari slip without mojibake (E3 multi-script)', () => {
    const bytes = Buffer.concat([
      Buffer.from('@', 'utf8'),
      Buffer.from('शर्मा जनरल स्टोर\nGSTIN: ' + TEST_GSTIN + '\nTAX INVOICE\nBill No: INV/9\n', 'utf8'),
      Buffer.from('चावल                              620.00\nGRAND TOTAL                       620.00\n', 'utf8'),
      CUT,
    ]);
    const fragment = parseEscPosStream(bytes)[0]!;
    expect(fragment.lines.join('\n')).toContain('शर्मा');
    expect(fragment.lines.join('\n')).not.toContain('�');
  });
});

describe('document classification (M-05, #2 on the bite-first list)', () => {
  const classOf = (bytes: Buffer) => classifyDocument(parseEscPosStream(bytes)[0]!.lines);

  it('never lets a kitchen order ticket become a customer bill', () => {
    const r = classOf(escposKot());
    expect(r.streamClass).toBe('kitchen_order_ticket');
    expect(r.quarantine).toBe(true);
  });

  it('quarantines a quotation even though it has totals and a GSTIN', () => {
    const r = classOf(escposQuote());
    expect(r.streamClass).toBe('quote');
    expect(r.quarantine).toBe(true);
  });

  it('quarantines shift reports and test prints', () => {
    expect(classOf(escposShiftReport()).streamClass).toBe('shift_report');
    expect(classOf(escposTestPrint()).streamClass).toBe('test_print');
  });

  it('accepts an ordinary tax invoice', () => {
    const r = classOf(escposReceipt({ total: 95500 / 100 }));
    expect(r.streamClass).toBe('bill');
    expect(r.quarantine).toBe(false);
  });

  it('classifies a slip with no money at all as a kitchen ticket', () => {
    const r = classifyDocument(['Table 4', 'Chicken Biryani', 'Raita', 'Served by Anil']);
    expect(r.quarantine).toBe(true);
  });

  it('returns unknown, never "probably a bill", when evidence is thin', () => {
    const r = classifyDocument(['Total    120.00', 'xx', 'yy']);
    expect(r.streamClass).toBe('unknown');
    expect(r.quarantine).toBe(true);
  });

  it('recognises a reprint marker', () => {
    const r = classOf(escposReceipt({ total: 955, banner: 'DUPLICATE COPY' }));
    expect(r.streamClass).toBe('reprint');
  });
});

describe('extraction (R-01, E1 line sums)', () => {
  const linesOf = (bytes: Buffer) => parseEscPosStream(bytes)[0]!.lines;

  it('pulls the whole bill out of a realistic slip', () => {
    const e = extractBillFromText(
      linesOf(escposReceipt({
        items: [
          { name: 'Basmati Rice 5kg', qty: 1, rate: 620, amount: 620 },
          { name: 'Toor Dal 1kg', qty: 2, rate: 145, amount: 290 },
        ],
        subtotal: 910,
        taxLines: [{ label: 'CGST 2.5%', amount: 22.75 }, { label: 'SGST 2.5%', amount: 22.75 }],
        roundOff: -0.5, total: 955,
      })),
      { source: 'printed', captureDate: NOW },
    );

    expect(e.gstin).toBe(TEST_GSTIN);
    expect(e.documentNumber).toBe('INV/2026/0417');
    expect(e.documentDateKey).toBe('2026-09-17');
    expect(e.grandTotalMinor).toBe(95500);
    expect(e.taxTotalMinor).toBe(4550);
    expect(e.paymentMethod).toBe('upi');
    expect(e.lines).toHaveLength(2);
    expect(e.lineSumMinor).toBe(91000);
    expect(e.sumDiscrepancyFlagged).toBe(false);
  });

  it('reads a four-or-more digit amount whole (regression: 2205 read as 205)', () => {
    // An ungrouped total is normal on a thermal slip. A grouping-only pattern
    // matches the last three digits when anchored to the end of the line, which
    // turned 2205.00 into 205.00 and 38500.00 into 500.00 — wrong, and
    // confident, which is the failure E3 exists to prevent.
    for (const [printed, expected] of [
      [2205, 220500], [38500, 3850000], [955.5, 95550], [123456.78, 12345678], [7, 700],
    ] as Array<[number, number]>) {
      const e = extractBillFromText(
        linesOf(escposReceipt({ items: [{ name: 'Widget', amount: printed }], total: printed })),
        { source: 'printed', captureDate: NOW },
      );
      expect(e.grandTotalMinor).toBe(expected);
      expect(e.lines[0]!.lineTotalMinor).toBe(expected);
      expect(e.sumDiscrepancyFlagged).toBe(false);
    }
  });

  it('still reads Indian grouped amounts', () => {
    const e = extractBillFromText(
      ['TAX INVOICE', 'Bill No: INV/1', 'Date: 17/09/2026', 'GRAND TOTAL           1,23,456.78'],
      { source: 'printed', captureDate: NOW },
    );
    expect(e.grandTotalMinor).toBe(12345678);
  });

  it('does not count a "2 x 145.00" continuation line as a second item', () => {
    const e = extractBillFromText(
      linesOf(escposReceipt({
        items: [{ name: 'Toor Dal 1kg', qty: 2, rate: 145, amount: 290 }],
        total: 290,
      })),
      { source: 'printed', captureDate: NOW },
    );
    expect(e.lines).toHaveLength(1);
    expect(e.lines[0]!.qty).toBe(2);
    expect(e.lines[0]!.unitPriceMinor).toBe(14500);
    expect(e.lineSumMinor).toBe(29000);
  });

  it('flags a line-sum mismatch and keeps the printed total canonical (E1)', () => {
    const e = extractBillFromText(
      linesOf(escposReceipt({
        items: [{ name: 'Rice', amount: 620 }, { name: 'Dal', amount: 290 }],
        total: 900, // the till applied an unprinted discount
      })),
      { source: 'printed', captureDate: NOW },
    );
    expect(e.grandTotalMinor).toBe(90000);   // printed total wins
    expect(e.lineSumMinor).toBe(91000);      // both are kept
    expect(e.sumDiscrepancyFlagged).toBe(true);
    expect(e.fields.find((f) => f.fieldPath === 'lineSumMinor')?.note)
      .toContain('printed total is canonical');
  });

  it('derives a total when it is illegible and never presents it as read (E3)', () => {
    const e = extractBillFromText(
      [
        { text: `GSTIN: ${TEST_GSTIN}`, confidence: 0.99 },
        { text: 'Bill No: INV/7', confidence: 0.95 },
        { text: 'Date: 17/09/2026', confidence: 0.95 },
        { text: 'Rice                     620.00', confidence: 0.96 },
        { text: 'Dal                      290.00', confidence: 0.96 },
      ],
      { source: 'extracted', captureDate: NOW },
    );
    expect(e.grandTotalDerived).toBe(true);
    expect(e.grandTotalMinor).toBe(91000);
    const field = e.fields.find((f) => f.fieldPath === 'grandTotalMinor' && f.source === 'derived');
    expect(field?.flagged).toBe(true);
    expect(field?.note).toContain('not legible');
  });

  it('treats a handwritten kacha bill as low-provenance with no GSTIN (E3)', () => {
    const e = extractBillFromText(
      ['Gupta Kirana', 'Aata 5kg        250', 'Total           250'],
      { source: 'extracted', captureDate: NOW },
    );
    expect(e.looksHandwritten).toBe(true);
    expect(e.gstin).toBeNull();
    expect(e.grandTotalMinor).toBe(25000);
  });

  it('flags an ambiguous printed date instead of silently picking one', () => {
    const e = extractBillFromText(
      linesOf(escposReceipt({ total: 100, dateText: '03/04/2026' })),
      { source: 'printed' },
    );
    expect(e.documentDateAmbiguous).toBe(true);
    expect(e.documentDateKey).toBeNull();
    expect(e.fields.find((f) => f.fieldPath === 'documentDateKey')?.flagged).toBe(true);
  });
});

describe('issuance (M-03 idempotency, E1 reprint)', () => {
  it('stores a bill and issues a claim token', () => {
    const w = makeWorld();
    const r = ingestBill(w.db, ctx(w), payload());
    expect(r.outcome).toBe('created');
    expect(r.claimTokenSecret).toBeTruthy();
    expect(r.paper).toBe('print');

    const bill = billsRepo.getBill(w.db, r.billId!)!;
    expect(bill.state).toBe('unclaimed');
    expect(bill.financialYear).toBe('2026-27');
  });

  it('treats a reprint as the same bill and issues no second token', () => {
    const w = makeWorld();
    const first = ingestBill(w.db, ctx(w), payload());
    // Same content, different idempotency key — the cashier hit reprint.
    const second = ingestBill(w.db, ctx(w, new Date(NOW.getTime() + 90_000)), payload());

    expect(second.outcome).toBe('duplicate_reprint');
    expect(second.billId).toBe(first.billId);
    expect(second.claimTokenSecret).toBeUndefined();
  });

  it('replays an idempotency key without creating a second bill (M-03)', () => {
    const w = makeWorld();
    const p = payload();
    const first = ingestBill(w.db, ctx(w), p);
    const replay = ingestBill(w.db, ctx(w), p);

    expect(replay.billId).toBe(first.billId);
    expect(replay.reason).toContain('replayed');
    // Crucially: a replay never hands back the bearer credential again.
    expect(replay.claimTokenSecret).toBeUndefined();
  });

  it('reconciles a four-hour replay storm with zero duplicates', () => {
    const w = makeWorld();
    const queued = Array.from({ length: 40 }, (_, i) =>
      payload({ documentNumber: `INV/2026/${1000 + i}`, grandTotalMinor: 10000 + i }));

    for (const p of queued) ingestBill(w.db, ctx(w), p);
    for (const p of queued) ingestBill(w.db, ctx(w), p); // the whole queue replays
    for (const p of queued) ingestBill(w.db, ctx(w), p); // and again

    const count = w.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM bills').get()!.n;
    expect(count).toBe(40);
  });

  it('never suppresses the claim token because the printer failed (E1)', () => {
    const w = makeWorld();
    const r = ingestBill(w.db, { ...ctx(w), printerFailed: true }, payload());
    expect(r.outcome).toBe('created');
    expect(r.claimTokenSecret).toBeTruthy();
    expect(r.warnings.join(' ')).toContain('issued regardless');
  });

  it('flags a terminal clock set to next year but still stores the bill (E7)', () => {
    const w = makeWorld();
    const r = ingestBill(w.db, ctx(w), payload({ terminalTime: '2027-09-17T14:12:00.000Z' }));
    expect(r.outcome).toBe('created');
    expect(r.warnings.join(' ')).toContain('terminal clock');
    expect(billsRepo.getBill(w.db, r.billId!)!.clockSkewFlagged).toBe(true);
  });

  it('allows the same invoice number in a different financial year (E7)', () => {
    const w = makeWorld();
    const a = ingestBill(w.db, ctx(w), payload({ documentNumber: 'INV/1', documentDateKey: '2026-03-31' }));
    const b = ingestBill(w.db, ctx(w), payload({ documentNumber: 'INV/1', documentDateKey: '2026-04-01' }));
    expect(a.outcome).toBe('created');
    expect(b.outcome).toBe('created');
    expect(a.billId).not.toBe(b.billId);
  });

  it('accepts a zero-value bill and a negative one (E1)', () => {
    const w = makeWorld();
    expect(ingestBill(w.db, ctx(w), payload({
      documentNumber: 'INV/FREE', grandTotalMinor: 0,
      lines: [{ lineNo: 0, description: 'Warranty replacement unit', qty: 1, lineTotalMinor: 0 }],
    })).outcome).toBe('created');

    expect(ingestBill(w.db, ctx(w), payload({
      documentNumber: 'CN/1', documentType: 'credit_note', grandTotalMinor: -12000, lines: [],
    })).outcome).toBe('linked_document');
  });
});

describe('print-stream ingestion end to end', () => {
  it('quarantines kitchen tickets and ingests the bill from one spool', () => {
    const w = makeWorld({ category: 'restaurant' });
    const spool = Buffer.concat([
      escposKot(),
      escposReceipt({ total: 955, billNumber: 'INV/2026/0417' }),
      escposShiftReport(),
    ]);

    const result = ingestPrintStream(w.db, ctx(w), spool);
    expect(result.fragmentsSeen).toBe(3);
    expect(result.quarantined).toBe(2);
    expect(result.results.filter((r) => r.outcome === 'created')).toHaveLength(1);

    const quarantined = ledgers.listQuarantine(w.db, w.outletId);
    expect(quarantined.map((q) => q.streamClass).sort()).toEqual(['kitchen_order_ticket', 'shift_report']);

    // The acceptance criterion, stated as a query: no kitchen ticket is a bill.
    const bills = w.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM bills').get()!.n;
    expect(bills).toBe(1);
  });

  it('never creates a bill from a structurally invalid fragment', () => {
    const w = makeWorld();
    const spliced = Buffer.concat([
      escposReceipt({ total: 100, noCut: true }),
      escposReceipt({ total: 200, merchantName: 'Other Till' }),
    ]);
    const result = ingestPrintStream(w.db, ctx(w), spliced);
    expect(result.results.every((r) => r.outcome === 'quarantined')).toBe(true);
    expect(w.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM bills').get()!.n).toBe(0);
  });
});
