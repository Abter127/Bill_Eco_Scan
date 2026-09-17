import { describe, expect, it } from 'vitest';
import { ingestBill } from '../src/services/issuance.js';
import {
  applyCreditNote, voidBill, amendBill, recordExchange, groupVisit,
  recordWarrantyReplacement, orphanAmendmentAlerts,
} from '../src/services/amendments.js';
import { claimBill } from '../src/services/claim.js';
import { createExport } from '../src/services/exports.js';
import { buildBillView } from '../src/services/billview.js';
import { billPayloadSchema } from '../src/core/schema.js';
import { newIdempotencyKey } from '../src/core/ids.js';
import { warrantyState, returnWindowState } from '../src/core/warranty.js';
import * as billsRepo from '../src/db/repo/bills.js';
import * as ledgers from '../src/db/repo/ledgers.js';
import * as registry from '../src/db/repo/registry.js';
import { makeWorld } from './helpers.js';

const NOW = new Date('2026-09-17T14:12:00Z');

function issue(w: ReturnType<typeof makeWorld>, over: Record<string, unknown> = {}) {
  return ingestBill(
    w.db,
    { terminalId: w.terminalId, outletId: w.outletId, merchantId: w.merchantId, now: NOW },
    billPayloadSchema.parse({
      idempotencyKey: newIdempotencyKey(),
      outletId: w.outletId, terminalId: w.terminalId,
      terminalTime: NOW.toISOString(),
      documentNumber: 'INV/2026/0417', documentDateKey: '2026-09-17',
      grandTotalMinor: 150000,
      lines: [
        { lineNo: 0, description: 'Electric kettle', qty: 1, lineTotalMinor: 100000, warrantyMonths: 12, serialNumber: 'KT-991' },
        { lineNo: 1, description: 'Steel tiffin', qty: 2, lineTotalMinor: 50000 },
      ],
      ...over,
    }),
  );
}

describe('E4 — a partial return voids warranty only on the returned lines', () => {
  it('records a credit note as its own document and leaves the rest running', () => {
    const w = makeWorld();
    const bill = issue(w);

    const result = applyCreditNote(w.db, {
      originalBillId: bill.billId!,
      documentNumber: 'CN/2026/1',
      outletId: w.outletId,
      returnedLines: [{ lineNo: 0, qty: 1 }],
      amountMinor: 100000,
      now: NOW,
    });

    expect(result.status).toBe('applied');
    expect(result.billState).toBe('partially_returned');
    expect(result.voidedWarrantyLineNos).toEqual([0]);

    const updated = billsRepo.getBill(w.db, bill.billId!)!;
    // The original bill is untouched as a document: its total still stands.
    expect(updated.grandTotalMinor).toBe(150000);
    expect(updated.lines[0]!.returnedQty).toBe(1);
    expect(updated.lines[1]!.returnedQty).toBe(0);

    // Warranty is void on the returned line only.
    const merchant = registry.getMerchant(w.db, w.merchantId)!;
    const returned = warrantyState(
      { line: updated.lines[0]!, documentDateKey: updated.documentDateKey, merchantCategory: merchant.category },
      NOW,
    );
    expect(returned.voided).toBe(true);

    // And the return window on the rest keeps running.
    const view = buildBillView(w.db, updated, { now: NOW });
    expect(view.returnWindow.open).toBe(true);
  });

  it('marks the bill fully returned when every line comes back', () => {
    const w = makeWorld();
    const bill = issue(w);
    const r = applyCreditNote(w.db, {
      originalBillId: bill.billId!, documentNumber: 'CN/2026/2', outletId: w.outletId,
      returnedLines: [{ lineNo: 0, qty: 1 }, { lineNo: 1, qty: 2 }],
      amountMinor: 150000, now: NOW,
    });
    expect(r.billState).toBe('fully_returned');
    expect(buildBillView(w.db, billsRepo.getBill(w.db, bill.billId!)!, { now: NOW }).returnWindow.open).toBe(false);
  });

  it('never counts the credit note as spend (E1)', () => {
    const w = makeWorld();
    const bill = issue(w);
    const r = applyCreditNote(w.db, {
      originalBillId: bill.billId!, documentNumber: 'CN/2026/3', outletId: w.outletId,
      returnedLines: [], amountMinor: 150000, now: NOW,
    });
    const note = billsRepo.getBill(w.db, r.creditNoteId)!;
    expect(note.grandTotalMinor).toBeLessThan(0);
    expect(buildBillView(w.db, note, { now: NOW }).countsAsSpend).toBe(false);
  });
});

describe('E4 — a credit note that arrives before its bill', () => {
  it('is parked and reconciles when the original turns up', () => {
    const w = makeWorld();

    const parked = applyCreditNote(w.db, {
      merchantId: w.merchantId,
      originalDocumentNumber: 'INV/2026/0417',
      documentNumber: 'CN/2026/9',
      outletId: w.outletId,
      returnedLines: [{ lineNo: 0, qty: 1 }],
      amountMinor: 100000,
      now: NOW,
    });
    expect(parked.status).toBe('parked');
    expect(ledgers.parkedLinksFor(w.db, w.merchantId, 'INV/2026/0417')).toHaveLength(1);

    // The original finally arrives from the agent's queue.
    const bill = issue(w);
    expect(bill.warnings.join(' ')).toMatch(/reconciled a previously parked/i);
    expect(ledgers.parkedLinksFor(w.db, w.merchantId, 'INV/2026/0417')).toHaveLength(0);
    expect(ledgers.linksTo(w.db, bill.billId!).map((l) => l.relation)).toContain('credit_note_for');
  });

  it('alerts when a parked amendment never finds its original', () => {
    const w = makeWorld();
    applyCreditNote(w.db, {
      merchantId: w.merchantId, originalDocumentNumber: 'INV/NEVER',
      documentNumber: 'CN/2026/10', outletId: w.outletId,
      returnedLines: [], amountMinor: 5000,
      now: new Date(NOW.getTime() - 10 * 86_400_000),
    });

    const alerts = orphanAmendmentAlerts(w.db, 3, NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.awaitingDocumentNumber).toBe('INV/NEVER');
    expect(alerts[0]!.message).toMatch(/waiting/i);
  });

  it('applies a credit note to a bill nobody ever claimed', () => {
    const w = makeWorld();
    const bill = issue(w);
    const r = applyCreditNote(w.db, {
      originalBillId: bill.billId!, documentNumber: 'CN/2026/11', outletId: w.outletId,
      returnedLines: [{ lineNo: 1, qty: 1 }], amountMinor: 25000, now: NOW,
    });
    expect(r.status).toBe('applied');
    // A later claimant sees the corrected history, not a surprise.
    expect(billsRepo.getBill(w.db, r.creditNoteId)!.state).toBe('unclaimed');
  });
});

describe('E1 — a sale voided seconds after printing', () => {
  it('cancels via a linked document and keeps the bill in history', () => {
    const w = makeWorld();
    const bill = issue(w);
    claimBill(w.db, { secret: bill.claimTokenSecret!, accountId: w.accountId, now: NOW });

    const result = voidBill(w.db, bill.billId!, 'VOID/1', NOW);
    const original = billsRepo.getBill(w.db, bill.billId!)!;

    expect(original.state).toBe('cancelled');
    expect(original.ownerAccountId).toBe(w.accountId); // still in their history
    expect(billsRepo.getBill(w.db, result.voidDocumentId)!.documentType).toBe('void');
    expect(ledgers.linksTo(w.db, bill.billId!).map((l) => l.relation)).toContain('cancels');
    expect(buildBillView(w.db, original, { now: NOW }).countsAsSpend).toBe(false);
  });
});

describe('E1 — the amount changed after printing', () => {
  it('records an amendment beside the original rather than changing the number', () => {
    const w = makeWorld();
    const bill = issue(w);
    const r = amendBill(w.db, bill.billId!, 'AMD/1', 140000, NOW);

    expect(billsRepo.getBill(w.db, bill.billId!)!.grandTotalMinor).toBe(150000);
    expect(billsRepo.getBill(w.db, r.amendmentId)!.grandTotalMinor).toBe(140000);

    const view = buildBillView(w.db, billsRepo.getBill(w.db, bill.billId!)!, { now: NOW });
    expect(view.links.map((l) => l.relation)).toContain('amends');
  });
});

describe('E4 — exchange, different outlet, and warranty replacement', () => {
  it('links an exchange so history reads as one event', () => {
    const w = makeWorld();
    const original = issue(w);
    const replacement = issue(w, { documentNumber: 'INV/2026/0418' });

    const r = recordExchange(w.db, original.billId!, replacement.billId!, NOW);
    expect(billsRepo.getBill(w.db, replacement.billId!)!.billGroupId)
      .toBe(billsRepo.getBill(w.db, original.billId!)!.billGroupId);
    expect(r.newWarrantyStartDateKey).toBe('2026-09-17');
  });

  it('notes a return processed at a different outlet', () => {
    const w = makeWorld();
    const bill = issue(w);
    const otherOutlet = registry.createOutlet(w.db, w.merchantId, 'Noida Sector 18', 'Noida');

    const r = applyCreditNote(w.db, {
      originalBillId: bill.billId!, documentNumber: 'CN/OUT', outletId: otherOutlet.id,
      returnedLines: [{ lineNo: 1, qty: 1 }], amountMinor: 25000, now: NOW,
    });
    expect(r.warnings.join(' ')).toMatch(/different outlet/i);
    expect(billsRepo.getBill(w.db, r.creditNoteId)!.outletId).toBe(otherOutlet.id);
    expect(billsRepo.getBill(w.db, bill.billId!)!.outletId).toBe(w.outletId);
  });

  it('records a warranty replacement with its rule and source shown (§9.03)', () => {
    const w = makeWorld();
    const bill = issue(w);
    const r = recordWarrantyReplacement(w.db, bill.billId!, 0, 'KT-1042', '2026-11-01', 12);

    expect(r.rule).toBe('continue');              // the documented default
    expect(r.warrantyStartDateKey).toBe('2026-09-17');
    expect(r.sourceLabel).toMatch(/Default rule/i);
    expect(billsRepo.getBill(w.db, bill.billId!)!.lines[0]!.serialNumber).toBe('KT-1042');

    const restart = recordWarrantyReplacement(w.db, bill.billId!, 0, 'KT-1043', '2026-11-01', 12, 'restart');
    expect(restart.warrantyStartDateKey).toBe('2026-11-01');
  });
});

describe('E1 — one shop, two legal entities', () => {
  it('groups a restaurant and bar bill into one visit', () => {
    const w = makeWorld({ category: 'restaurant' });
    const food = issue(w, { documentNumber: 'REST/1', grandTotalMinor: 120000 });
    const bar = issue(w, { documentNumber: 'BAR/1', grandTotalMinor: 80000 });

    const r = groupVisit(w.db, [food.billId!, bar.billId!]);
    expect(billsRepo.getBill(w.db, bar.billId!)!.billGroupId).toBe(r.groupId);
    // They remain two separate tax documents.
    expect(billsRepo.getBill(w.db, food.billId!)!.documentNumber).toBe('REST/1');
    expect(billsRepo.getBill(w.db, bar.billId!)!.documentNumber).toBe('BAR/1');
  });
});

describe('E4 — a return after the bill was exported', () => {
  it('flags the export instead of diverging silently', async () => {
    const w = makeWorld();
    const bill = issue(w);
    claimBill(w.db, { secret: bill.claimTokenSecret!, accountId: w.accountId, now: NOW });

    await createExport(w.db, {
      accountId: w.accountId, format: 'csv', financialYear: '2026-27', now: NOW,
      outDir: '/tmp/billing-hub-test-exports',
    });

    const r = applyCreditNote(w.db, {
      originalBillId: bill.billId!, documentNumber: 'CN/LATE', outletId: w.outletId,
      returnedLines: [{ lineNo: 0, qty: 1 }], amountMinor: 100000, now: NOW,
    });

    expect(r.exportsFlagged).toBe(1);
    expect(r.warnings.join(' ')).toMatch(/already in 1 export/i);
  });
});

describe('E4 — annotations survive amendments', () => {
  it('keeps a note attached through a credit note and an amendment', () => {
    const w = makeWorld();
    const bill = issue(w);
    const original = billsRepo.getBill(w.db, bill.billId!)!;
    ledgers.addAnnotation(w.db, original.billGroupId, w.accountId, 'note', 'For the office kitchen');

    applyCreditNote(w.db, {
      originalBillId: bill.billId!, documentNumber: 'CN/ANN', outletId: w.outletId,
      returnedLines: [{ lineNo: 1, qty: 1 }], amountMinor: 25000, now: NOW,
    });
    amendBill(w.db, bill.billId!, 'AMD/ANN', 145000, NOW);

    const view = buildBillView(w.db, billsRepo.getBill(w.db, bill.billId!)!, { now: NOW });
    expect(view.annotations.map((a) => a.value)).toContain('For the office kitchen');
  });
});

describe('R-04 — the return countdown always shows its source', () => {
  it('counts down from the merchant policy and names it', () => {
    const state = returnWindowState(
      {
        documentDateKey: '2026-09-15',
        merchantReturnWindowDays: 7,
        merchantReturnPolicySource: 'Shop’s stated return policy: 7 days with the bill',
      },
      NOW,
    );
    expect(state.open).toBe(true);
    expect(state.daysRemaining).toBe(5);
    expect(state.expiresDateKey).toBe('2026-09-22');
    expect(state.sourceLabel).toContain('7 days');
  });

  it('says so plainly when the shop publishes no window', () => {
    const state = returnWindowState(
      { documentDateKey: '2026-09-15', merchantReturnWindowDays: null, merchantReturnPolicySource: null },
      NOW,
    );
    expect(state.applicable).toBe(false);
    expect(state.note).toMatch(/has not published a return window/i);
  });

  it('refuses to count down from a date it could not read (E3)', () => {
    const state = returnWindowState(
      { documentDateKey: null, merchantReturnWindowDays: 7, merchantReturnPolicySource: null },
      NOW,
    );
    expect(state.open).toBe(false);
    expect(state.daysRemaining).toBeNull();
    expect(state.note).toMatch(/could not read the bill date/i);
  });
});
