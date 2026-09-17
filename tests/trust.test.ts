import { describe, expect, it } from 'vitest';
import {
  assertNoCustomerIdentity, ConsentBoundaryViolation, toMerchantVisible,
  buildReturnVerification, fieldsForScope, isGrantActive, CONSENT_NOTICE,
} from '../src/core/consent.js';
import {
  classifySensitivity, notificationPreview, includeInAnalytics,
  includeInTrainingSet, includeInSharedProfile, requiresBiometricUnlock,
} from '../src/core/sensitivity.js';
import { ingestBill } from '../src/services/issuance.js';
import { claimBill } from '../src/services/claim.js';
import { sendBillNotification } from '../src/services/notifications.js';
import { consoleSummary, merchantBills, auditMerchantSurfaces } from '../src/services/metrics.js';
import { fileRequest, listRequests, buildAccessPackage, eraseAccount, consentNotice, SLA_DAYS, DISCLOSURE_PROCESS } from '../src/services/dpdp.js';
import { createExport } from '../src/services/exports.js';
import { billPayloadSchema } from '../src/core/schema.js';
import { newIdempotencyKey } from '../src/core/ids.js';
import * as billsRepo from '../src/db/repo/bills.js';
import * as ledgers from '../src/db/repo/ledgers.js';
import * as people from '../src/db/repo/people.js';
import { makeWorld } from './helpers.js';

const NOW = new Date('2026-09-17T14:12:00Z');

function issue(w: ReturnType<typeof makeWorld>, over: Record<string, unknown> = {}) {
  return ingestBill(
    w.db,
    { terminalId: w.terminalId, outletId: w.outletId, merchantId: w.merchantId, now: NOW },
    billPayloadSchema.parse({
      idempotencyKey: newIdempotencyKey(),
      outletId: w.outletId, terminalId: w.terminalId, terminalTime: NOW.toISOString(),
      documentNumber: `INV/${Math.random().toString(36).slice(2, 8)}`,
      documentDateKey: '2026-09-17', grandTotalMinor: 95500,
      lines: [{ lineNo: 0, description: 'Item', qty: 1, lineTotalMinor: 95500 }],
      ...over,
    }),
  );
}

describe('T-01 / M-04 — a merchant can produce no list of people', () => {
  it('rejects any identity field on a merchant-visible object', () => {
    expect(() => assertNoCustomerIdentity({ ownerAccountId: 'a' })).toThrow(ConsentBoundaryViolation);
    expect(() => assertNoCustomerIdentity({ phone: '+919800000001' })).toThrow(ConsentBoundaryViolation);
    expect(() => assertNoCustomerIdentity({ nested: { email: 'x@y.z' } })).toThrow(ConsentBoundaryViolation);
    // A claim *timestamp* plus a till log is a re-identification vector, so the
    // boundary is the boolean, not the time.
    expect(() => assertNoCustomerIdentity({ claimedAt: '2026-09-17' })).toThrow(ConsentBoundaryViolation);
  });

  it('projects a claimed bill down to a boolean', () => {
    const w = makeWorld();
    const bill = issue(w);
    claimBill(w.db, { secret: bill.claimTokenSecret!, accountId: w.accountId, now: NOW });

    const projection = toMerchantVisible(billsRepo.getBill(w.db, bill.billId!)!);
    expect(projection.claimed).toBe(true);
    expect(Object.keys(projection)).not.toContain('ownerAccountId');
    expect(Object.keys(projection)).not.toContain('claimedAt');
    expect(JSON.stringify(projection)).not.toContain(w.accountId);
  });

  it('passes an audit of every merchant-facing surface', () => {
    const w = makeWorld();
    for (let i = 0; i < 3; i++) {
      const bill = issue(w);
      if (i === 0) claimBill(w.db, { secret: bill.claimTokenSecret!, accountId: w.accountId, now: NOW });
    }

    const audit = auditMerchantSurfaces(w.db, w.outletId, '2026-09-01', '2026-09-30');
    expect(audit.passes).toBe(true);
    expect(audit.identityFieldsFound).toEqual([]);
    expect(audit.surfacesChecked.length).toBeGreaterThan(1);
  });

  it('never leaks an account id through the console summary', () => {
    const w = makeWorld();
    const bill = issue(w);
    claimBill(w.db, { secret: bill.claimTokenSecret!, accountId: w.accountId, now: NOW });

    const summary = consoleSummary(w.db, w.outletId, '2026-09-01', '2026-09-30', NOW);
    const bills = merchantBills(w.db, w.outletId, '2026-09-01', '2026-09-30');
    expect(JSON.stringify({ summary, bills })).not.toContain(w.accountId);
  });
});

describe('T-01 — scoped grants', () => {
  it('gives a merchant verifying a return nothing but the verdict', () => {
    const w = makeWorld();
    const bill = issue(w);
    claimBill(w.db, { secret: bill.claimTokenSecret!, accountId: w.accountId, now: NOW });

    const verification = buildReturnVerification(
      billsRepo.getBill(w.db, bill.billId!)!, w.merchantId, true,
    );
    expect(verification.authentic).toBe(true);
    expect(JSON.stringify(verification)).not.toContain(w.accountId);
    expect(fieldsForScope('return_verification')).not.toContain('merchantId.customer');
  });

  it('expires and revokes, because a grant with no end is not a grant', () => {
    const w = makeWorld();
    const bill = issue(w);
    claimBill(w.db, { secret: bill.claimTokenSecret!, accountId: w.accountId, now: NOW });

    const grant = ledgers.createGrant(w.db, {
      billId: bill.billId!, accountId: w.accountId,
      grantedToMerchantId: w.merchantId, scope: 'warranty_claim', ttlMs: 60_000,
    }, NOW);

    expect(isGrantActive(grant, NOW)).toBe(true);
    expect(ledgers.activeGrants(w.db, bill.billId!, NOW)).toHaveLength(1);

    // Expiry alone ends it, with nothing to remember to do.
    const later = new Date(NOW.getTime() + 61_000);
    expect(isGrantActive(grant, later)).toBe(false);
    expect(ledgers.activeGrants(w.db, bill.billId!, later)).toHaveLength(0);

    // And it can be revoked before then.
    ledgers.revokeGrant(w.db, grant.id);
    expect(ledgers.activeGrants(w.db, bill.billId!, NOW)).toHaveLength(0);
  });
});

describe('T-04 / E6 — the lock-screen preview is the likeliest privacy incident', () => {
  it('suppresses the merchant name for a diagnostics lab', () => {
    const preview = notificationPreview({
      sensitivityClass: 'sensitive',
      merchantDisplayName: 'City Diagnostics Lab',
      amountLabel: '₹2,400.00',
      kind: 'bill_ready',
    });
    expect(preview.suppressed).toBe(true);
    expect(preview.includesMerchantName).toBe(false);
    expect(`${preview.title} ${preview.body}`).not.toMatch(/Diagnostics|2,400/);
  });

  it('shows the shop name for an ordinary bill', () => {
    const preview = notificationPreview({
      sensitivityClass: 'standard',
      merchantDisplayName: 'Sharma General Store',
      amountLabel: '₹955.00',
      kind: 'bill_ready',
    });
    expect(preview.title).toBe('Sharma General Store');
    expect(preview.suppressed).toBe(false);
  });

  it('classifies by category and by name, so a mis-declared category still lands', () => {
    expect(classifySensitivity('pharmacy', 'Anything').sensitivityClass).toBe('sensitive');
    expect(classifySensitivity('general', 'Apollo Pharmacy').sensitivityClass).toBe('sensitive');
    expect(classifySensitivity('general', 'City Diagnostics Centre').sensitivityClass).toBe('sensitive');
    expect(classifySensitivity('grocery', 'Sharma General Store').sensitivityClass).toBe('standard');
  });

  it('suppresses the preview end to end for a pharmacy bill', () => {
    const w = makeWorld({ category: 'pharmacy', legalName: 'CITY CHEMIST LLP', tradeName: 'City Chemist' });
    const bill = issue(w);
    claimBill(w.db, { secret: bill.claimTokenSecret!, accountId: w.accountId, now: NOW });

    const sent = sendBillNotification(w.db, w.accountId, bill.billId!, 'bill_ready')!;
    expect(sent.suppressedPreview).toBe(true);
    expect(`${sent.title} ${sent.body}`).not.toMatch(/Chemist/);
  });

  it('keeps sensitive bills out of analytics, training sets and shared views', () => {
    expect(includeInAnalytics('sensitive')).toBe(false);
    expect(includeInTrainingSet('sensitive')).toBe(false);
    expect(includeInSharedProfile('sensitive', new Set(), 'b1')).toBe(false);
    // Unless the owner shares that one bill explicitly.
    expect(includeInSharedProfile('sensitive', new Set(['b1']), 'b1')).toBe(true);
    expect(includeInSharedProfile('standard', new Set(), 'b1')).toBe(true);
  });

  it('makes the biometric lock mandatory on the sensitive view', () => {
    expect(requiresBiometricUnlock('sensitive', false)).toBe(true);
    expect(requiresBiometricUnlock('standard', false)).toBe(false);
    expect(requiresBiometricUnlock('standard', true)).toBe(true);
  });

  it('leaves a sensitive bill out of an export unless it is asked for', async () => {
    const w = makeWorld({ category: 'pharmacy', tradeName: 'City Chemist' });
    const bill = issue(w);
    claimBill(w.db, { secret: bill.claimTokenSecret!, accountId: w.accountId, now: NOW });

    const excluded = await createExport(w.db, {
      accountId: w.accountId, format: 'csv', financialYear: '2026-27', now: NOW,
      outDir: '/tmp/billing-hub-test-exports',
    });
    expect(excluded.billCount).toBe(0);
    expect(excluded.warnings.join(' ')).toMatch(/health-related bill/i);

    const included = await createExport(w.db, {
      accountId: w.accountId, format: 'csv', financialYear: '2026-27',
      includeSensitive: true, now: NOW, outDir: '/tmp/billing-hub-test-exports',
    });
    expect(included.billCount).toBe(1);
  });
});

describe('T-02 — every non-owner read is logged with a reason', () => {
  it('records the actor and reason, visible to the owner', () => {
    const w = makeWorld();
    const bill = issue(w);
    claimBill(w.db, { secret: bill.claimTokenSecret!, accountId: w.accountId, now: NOW });

    ledgers.logAccess(w.db, {
      billId: bill.billId!, accountId: w.accountId, actorType: 'support',
      actorId: 'agent-42', action: 'bill_viewed',
      reason: 'customer raised a ticket about a missing return window',
    });

    const entries = ledgers.accessLogForOwner(w.db, w.accountId);
    const support = entries.find((e) => e.actorType === 'support');
    expect(support?.actorId).toBe('agent-42');
    expect(support?.reason).toMatch(/ticket/);
  });

  it('logs automated jobs too', () => {
    const w = makeWorld();
    const bill = issue(w);
    claimBill(w.db, { secret: bill.claimTokenSecret!, accountId: w.accountId, now: NOW });
    buildAccessPackage(w.db, w.accountId, NOW);

    const actions = ledgers.accessLogForOwner(w.db, w.accountId).map((e) => e.action);
    expect(actions).toContain('access_package_generated');
  });
});

describe('T-03 — DPDP rights with SLA timers', () => {
  it('files a request with a deadline and reports it as overdue when it passes', () => {
    const w = makeWorld();
    const request = fileRequest(w.db, w.accountId, 'grievance', 'bill missing after a return', NOW);
    expect(request.state).toBe('received');

    const soon = listRequests(w.db, w.accountId, NOW)[0]!;
    expect(soon.overdue).toBe(false);
    expect(soon.hoursRemaining).toBe(SLA_DAYS.grievance * 24);

    const late = listRequests(w.db, w.accountId, new Date(NOW.getTime() + 8 * 86_400_000))[0]!;
    expect(late.overdue).toBe(true);
  });

  it('builds an access package containing bills, the audit log and the notice', () => {
    const w = makeWorld();
    const bill = issue(w);
    claimBill(w.db, { secret: bill.claimTokenSecret!, accountId: w.accountId, now: NOW });

    const pkg = buildAccessPackage(w.db, w.accountId, NOW);
    expect(pkg.bills).toHaveLength(1);
    expect(pkg.consentNotice).toBe(CONSENT_NOTICE);
    expect(pkg.retentionDisclosure).toMatch(/shop keeps its own copy/i);
  });

  it('de-identifies on erasure while the merchant statutory copy persists (E2)', () => {
    const w = makeWorld();
    const bill = issue(w);
    claimBill(w.db, { secret: bill.claimTokenSecret!, accountId: w.accountId, now: NOW });

    const result = eraseAccount(w.db, w.accountId);
    expect(result.billsDeIdentified).toBe(1);
    expect(result.merchantCopiesRetained).toBe(1);
    expect(result.disclosure).toMatch(/tax law requires/i);

    const after = billsRepo.getBill(w.db, bill.billId!)!;
    expect(after.ownerAccountId).toBeNull();
    // The document itself survives for the merchant's statutory copy.
    expect(after.grandTotalMinor).toBe(95500);
    expect(after.documentNumber).not.toBeNull();
    expect(people.getAccount(w.db, w.accountId)!.phoneE164).toBeNull();
  });

  it('publishes an itemised, plain-language consent notice', () => {
    const notice = consentNotice();
    expect(notice.items.length).toBeGreaterThanOrEqual(4);
    for (const item of notice.items) {
      expect(item.purpose.length).toBeGreaterThan(0);
      expect(item.retention.length).toBeGreaterThan(0);
    }
    // Each purpose has its own retention rather than one blanket statement.
    expect(new Set(notice.items.map((i) => i.retention)).size).toBeGreaterThan(1);
    expect(notice.optionalCount).toBeGreaterThan(0);
  });

  it('documents the disclosure process before the first request (E6)', () => {
    expect(DISCLOSURE_PROCESS.length).toBeGreaterThanOrEqual(5);
    expect(DISCLOSURE_PROCESS.join(' ')).toMatch(/narrow/i);
    expect(DISCLOSURE_PROCESS.join(' ')).toMatch(/notify the owner/i);
  });
});

describe('T-05 — format preference is the customer’s, never the merchant’s', () => {
  it('prints paper by default and only suppresses on a stored preference', () => {
    const w = makeWorld();
    expect(issue(w).paper).toBe('print');

    const suppressed = ingestBill(
      w.db,
      { terminalId: w.terminalId, outletId: w.outletId, merchantId: w.merchantId, now: NOW },
      billPayloadSchema.parse({
        idempotencyKey: newIdempotencyKey(), outletId: w.outletId, terminalId: w.terminalId,
        terminalTime: NOW.toISOString(), documentNumber: 'INV/DIGITAL',
        documentDateKey: '2026-09-17', grandTotalMinor: 100,
        lines: [{ lineNo: 0, description: 'X', qty: 1, lineTotalMinor: 100 }],
      }),
      undefined,
      { provenance: 'print_stream', formatPreference: 'digital' },
    );
    expect(suppressed.paper).toBe('suppress');
  });

  it('stores the preference on the account', () => {
    const w = makeWorld();
    expect(people.getAccount(w.db, w.accountId)!.formatPreference).toBe('paper');
    people.setFormatPreference(w.db, w.accountId, 'digital');
    expect(people.getAccount(w.db, w.accountId)!.formatPreference).toBe('digital');
  });
});
