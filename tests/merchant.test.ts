import { describe, expect, it } from 'vitest';
import { ingestBill } from '../src/services/issuance.js';
import { claimBill } from '../src/services/claim.js';
import { consoleSummary, velocityAnomalies, coercionSignals, CLAIM_RATE_TARGET } from '../src/services/metrics.js';
import { buildBillView } from '../src/services/billview.js';
import { billPayloadSchema } from '../src/core/schema.js';
import { newIdempotencyKey } from '../src/core/ids.js';
import * as registry from '../src/db/repo/registry.js';
import * as ledgers from '../src/db/repo/ledgers.js';
import * as billsRepo from '../src/db/repo/bills.js';
import * as people from '../src/db/repo/people.js';
import { makeWorld, TEST_GSTIN_2 } from './helpers.js';

const NOW = new Date('2026-09-17T14:12:00Z');

function issue(w: ReturnType<typeof makeWorld>, i: number, over: Record<string, unknown> = {}) {
  return ingestBill(
    w.db,
    { terminalId: w.terminalId, outletId: w.outletId, merchantId: w.merchantId, now: NOW },
    billPayloadSchema.parse({
      idempotencyKey: newIdempotencyKey(),
      outletId: w.outletId, terminalId: w.terminalId, terminalTime: NOW.toISOString(),
      documentNumber: `INV/${i}`, documentDateKey: '2026-09-17',
      grandTotalMinor: 10000 + i,
      lines: [{ lineNo: 0, description: `Item ${i}`, qty: 1, lineTotalMinor: 10000 + i }],
      ...over,
    }),
  );
}

describe('E5 — a merchant who cannot see why bills go unclaimed churns in week two', () => {
  it('explains a low claim rate with a benchmark and a concrete fix', () => {
    const w = makeWorld();
    for (let i = 0; i < 50; i++) issue(w, i);

    const summary = consoleSummary(w.db, w.outletId, '2026-09-01', '2026-09-30', NOW);
    expect(summary.billsIssued).toBe(50);
    expect(summary.claimRate).toBe(0);

    const note = summary.coaching.find((c) => c.title.match(/being kept/i))!;
    expect(note.severity).toBe('critical');
    expect(note.action).toMatch(/QR|code/i);          // the usual culprit: placement
    expect(note.benchmark).toMatch(/30/);             // a benchmark, not just a number
  });

  it('tells a brand-new merchant what to do on day one (E8)', () => {
    const w = makeWorld();
    const summary = consoleSummary(w.db, w.outletId, '2026-09-01', '2026-09-30', NOW);
    expect(summary.coaching[0]!.title).toMatch(/No bills captured yet/i);
    expect(summary.coaching[0]!.action).toMatch(/Print one bill/i);
  });

  it('congratulates rather than nags once the rate is healthy', () => {
    const w = makeWorld();
    for (let i = 0; i < 10; i++) {
      const bill = issue(w, i);
      if (i < 5) {
        const account = people.createAccount(w.db, { phoneE164: `+91980000${2000 + i}` }).account.id;
        claimBill(w.db, { secret: bill.claimTokenSecret!, accountId: account, now: NOW });
      }
    }
    const summary = consoleSummary(w.db, w.outletId, '2026-09-01', '2026-09-30', NOW);
    expect(summary.claimRate).toBeGreaterThanOrEqual(CLAIM_RATE_TARGET);
    expect(summary.coaching[0]!.severity).toBe('info');
  });
});

describe('E1 / M-04 — a capture gap is visible to the merchant', () => {
  it('flags a till that has stopped reporting', () => {
    const w = makeWorld();
    registry.recordHeartbeat(w.db, w.terminalId, new Date(NOW.getTime() - 45 * 60_000).toISOString());

    const summary = consoleSummary(w.db, w.outletId, '2026-09-01', '2026-09-30', NOW);
    const gap = summary.captureGaps[0]!;
    expect(gap.severity).toBe('down');

    const note = summary.coaching.find((c) => c.title.includes('Till 1'))!;
    expect(note.action).toMatch(/agent is running/i);
    // The customer's recovery path is named, not left implicit.
    expect(note.action).toMatch(/photographing the printed slip/i);
  });

  it('reports a till that has never reported at all', () => {
    const w = makeWorld();
    expect(consoleSummary(w.db, w.outletId, '2026-09-01', '2026-09-30', NOW).captureGaps[0]!.severity)
      .toBe('down');
  });

  it('is quiet when the till is healthy', () => {
    const w = makeWorld();
    registry.recordHeartbeat(w.db, w.terminalId, new Date(NOW.getTime() - 60_000).toISOString());
    expect(consoleSummary(w.db, w.outletId, '2026-09-01', '2026-09-30', NOW).captureGaps[0]!.severity)
      .toBe('ok');
  });
});

describe('E5 — staff claiming bills to their own account', () => {
  it('flags a single account taking a high share of one till’s bills', () => {
    const w = makeWorld();
    const staff = people.createAccount(w.db, { phoneE164: '+919800003000' }).account.id;

    for (let i = 0; i < 10; i++) {
      const bill = issue(w, i);
      const account = i < 6
        ? staff
        : people.createAccount(w.db, { phoneE164: `+91980000${4000 + i}` }).account.id;
      claimBill(w.db, { secret: bill.claimTokenSecret!, accountId: account, now: NOW });
    }

    const summary = consoleSummary(w.db, w.outletId, '2026-09-01', '2026-09-30', NOW);
    expect(summary.claimAnomalies).toHaveLength(1);
    expect(summary.claimAnomalies[0]!.share).toBeGreaterThan(0.5);
    // The merchant is told a pattern exists, never whose it is.
    expect(JSON.stringify(summary.claimAnomalies)).not.toContain(staff);
  });

  it('does not flag a normal spread of claimants', () => {
    const w = makeWorld();
    for (let i = 0; i < 12; i++) {
      const bill = issue(w, i);
      const account = people.createAccount(w.db, { phoneE164: `+91980000${5000 + i}` }).account.id;
      claimBill(w.db, { secret: bill.claimTokenSecret!, accountId: account, now: NOW });
    }
    expect(consoleSummary(w.db, w.outletId, '2026-09-01', '2026-09-30', NOW).claimAnomalies).toHaveLength(0);
  });
});

describe('E5 — a fake merchant onboarding', () => {
  it('refuses the verified badge without a valid GSTIN', () => {
    const w = makeWorld();
    const fake = registry.createMerchant(w.db, {
      gstin: '27AAAAA0000A1Z9', legalName: 'DEFINITELY REAL TRADERS',
    });
    expect(fake.gstinVerified).toBe(false);
    expect(fake.verifiedBadge).toBe(false);

    const real = registry.getMerchant(w.db, w.merchantId)!;
    expect(real.verifiedBadge).toBe(true);
  });

  it('surfaces the badge to the customer on the bill', () => {
    const w = makeWorld();
    const bill = issue(w, 1);
    expect(buildBillView(w.db, billsRepo.getBill(w.db, bill.billId!)!, { now: NOW }).merchant.verified).toBe(true);
  });

  it('flags a fresh merchant issuing many identical bills', () => {
    const w = makeWorld({ gstin: null });
    for (let i = 0; i < 30; i++) issue(w, i, { grandTotalMinor: 250000 });

    const anomalies = velocityAnomalies(w.db, '2026-09-01', '2026-09-30', NOW);
    const flagged = anomalies.find((a) => a.merchantId === w.merchantId)!;
    expect(flagged.suspicionScore).toBeGreaterThanOrEqual(0.4);
    expect(flagged.reasons.join(' ')).toMatch(/same total|not verified/i);
  });
});

describe('E5 — "scan or no paper" is a terms breach, not a feature', () => {
  it('flags an outlet suppressing far more paper than preference explains', () => {
    const w = makeWorld();
    for (let i = 0; i < 30; i++) {
      ledgers.bumpIssuanceStat(w.db, w.outletId, 'bills_issued', NOW);
      ledgers.bumpIssuanceStat(w.db, w.outletId, 'paper_suppressed', NOW);
    }
    const signals = coercionSignals(w.db, '2026-09-01', '2026-09-30');
    expect(signals).toHaveLength(1);
    expect(signals[0]!.message).toMatch(/breach of the merchant terms/i);
  });

  it('does not flag an outlet within the expected range', () => {
    const w = makeWorld();
    for (let i = 0; i < 30; i++) {
      ledgers.bumpIssuanceStat(w.db, w.outletId, 'bills_issued', NOW);
      ledgers.bumpIssuanceStat(w.db, w.outletId, i < 6 ? 'paper_suppressed' : 'paper_printed', NOW);
    }
    expect(coercionSignals(w.db, '2026-09-01', '2026-09-30')).toHaveLength(0);
  });
});

describe('E5 — shops close, the bills they issued must not', () => {
  it('keeps a departed merchant’s bills readable and says so on the bill', () => {
    const w = makeWorld();
    const bill = issue(w, 1);
    claimBill(w.db, { secret: bill.claimTokenSecret!, accountId: w.accountId, now: NOW });

    registry.markMerchantDeparted(w.db, w.merchantId);

    const view = buildBillView(w.db, billsRepo.getBill(w.db, bill.billId!)!, { now: NOW });
    expect(view.merchant.departed).toBe(true);
    expect(view.totals.grandTotal).toContain('100');
    expect(view.warnings.join(' ')).toMatch(/stays here and stays exportable/i);
  });

  it('keeps historical bills on their original GSTIN after re-registration', () => {
    const w = makeWorld();
    const bill = issue(w, 1);
    const successor = registry.createMerchant(w.db, {
      gstin: TEST_GSTIN_2, legalName: 'SHARMA TRADING LLP', tradeName: 'Sharma General Store',
    });
    registry.linkSuccessor(w.db, w.merchantId, successor.id);

    // Rewriting the GSTIN on an issued bill would falsify a tax document.
    expect(billsRepo.getBill(w.db, bill.billId!)!.merchantId).toBe(w.merchantId);
    // But the chain resolves forward for warranty and returns.
    expect(registry.resolveCurrentMerchant(w.db, w.merchantId)).toBe(successor.id);
  });

  it('closes an outlet rather than deleting it, and routes warranty upward', () => {
    const w = makeWorld();
    const bill = issue(w, 1);
    const { warrantyContactMerchantId } = registry.closeOutlet(w.db, w.outletId);

    expect(warrantyContactMerchantId).toBe(w.merchantId);
    expect(registry.getOutlet(w.db, w.outletId)!.state).toBe('closed');

    const view = buildBillView(w.db, billsRepo.getBill(w.db, bill.billId!)!, { now: NOW });
    expect(view.outlet.closed).toBe(true);
    expect(view.warnings.join(' ')).toMatch(/parent business/i);
  });
});
