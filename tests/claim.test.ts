import { describe, expect, it } from 'vitest';
import { ingestBill } from '../src/services/issuance.js';
import { claimBill, resolveClaimToken, retroactiveClaim, shareBillCopy, reassignProfile } from '../src/services/claim.js';
import { billPayloadSchema } from '../src/core/schema.js';
import { newIdempotencyKey } from '../src/core/ids.js';
import * as billsRepo from '../src/db/repo/bills.js';
import * as claimsRepo from '../src/db/repo/claims.js';
import * as people from '../src/db/repo/people.js';
import { sweepHoldWindows } from '../src/services/jobs.js';
import { makeWorld } from './helpers.js';

const NOW = new Date('2026-09-17T14:12:00Z');

function issue(world: ReturnType<typeof makeWorld>, over: Record<string, unknown> = {}, now = NOW) {
  const result = ingestBill(
    world.db,
    { terminalId: world.terminalId, outletId: world.outletId, merchantId: world.merchantId, now },
    billPayloadSchema.parse({
      idempotencyKey: newIdempotencyKey(),
      outletId: world.outletId,
      terminalId: world.terminalId,
      terminalTime: now.toISOString(),
      documentNumber: 'INV/2026/0417',
      documentDateKey: '2026-09-17',
      grandTotalMinor: 95500,
      lines: [{ lineNo: 0, description: 'Basmati Rice 5kg', qty: 1, lineTotalMinor: 95500 }],
      ...over,
    }),
  );
  return result;
}

describe('E2 — the expired token must never be a dead end (#1 to bite)', () => {
  it('resolves an expired token to an identifying page, not a 404', () => {
    const w = makeWorld();
    const issued = issue(w);
    const later = new Date(NOW.getTime() + 20 * 60_000); // TTL is 15 minutes

    const r = resolveClaimToken(w.db, issued.claimTokenSecret!, { now: later });
    expect(r.kind).toBe('expired');
    expect(r.identity?.amount).toContain('955');
    expect(r.identity?.merchantDisplayName).toBe('Sharma General Store');
    expect(r.identity?.documentDateKey).toBe('2026-09-17');
    expect(r.nextAction).toBe('retroactive_claim');
  });

  it('offers a route forward even for a token we never issued', () => {
    const w = makeWorld();
    const r = resolveClaimToken(w.db, 'not-a-real-token');
    expect(r.kind).toBe('unknown');
    expect(r.nextAction).toBe('retroactive_claim');
    expect(r.message).toMatch(/photo/i);
  });

  it('shows the bill immediately on a live token, with no account', () => {
    const w = makeWorld();
    const issued = issue(w);
    const r = resolveClaimToken(w.db, issued.claimTokenSecret!, { now: NOW });

    expect(r.kind).toBe('valid');
    expect(r.view?.totals.grandTotal).toContain('955');
    expect(r.view?.lines).toHaveLength(1);
    expect(r.nextAction).toBe('claim');
  });
});

describe('E2 — two devices claim simultaneously', () => {
  it('is atomic first-claim-wins, and the loser gets a path not an error', () => {
    const w = makeWorld();
    const issued = issue(w);
    const a = people.createAccount(w.db, { phoneE164: '+919800000002' }).account.id;
    const b = people.createAccount(w.db, { phoneE164: '+919800000003' }).account.id;

    const first = claimBill(w.db, { secret: issued.claimTokenSecret!, accountId: a, now: NOW });
    const second = claimBill(w.db, { secret: issued.claimTokenSecret!, accountId: b, now: NOW });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe('already_claimed');
      expect(second.nextAction).toBe('dispute');
      expect(second.message).not.toMatch(/error/i);
    }

    expect(billsRepo.getBill(w.db, issued.billId!)!.ownerAccountId).toBe(a);
  });

  it('never lets 20 concurrent claimants produce two owners', () => {
    const w = makeWorld();
    const issued = issue(w);
    const accounts = Array.from({ length: 20 }, (_, i) =>
      people.createAccount(w.db, { phoneE164: `+9198000001${String(i).padStart(2, '0')}` }).account.id);

    const results = accounts.map((id) =>
      claimBill(w.db, { secret: issued.claimTokenSecret!, accountId: id, now: NOW }));

    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });
});

describe('E2 — scanned offline', () => {
  it('accepts a late claim with proof the scan happened in time', () => {
    const w = makeWorld();
    const issued = issue(w);
    const account = people.createAccount(w.db, { phoneE164: '+919800000004' }).account.id;

    const result = claimBill(w.db, {
      secret: issued.claimTokenSecret!,
      accountId: account,
      // Scanned inside the shop, delivered an hour later when signal returned.
      scannedAt: new Date(NOW.getTime() + 60_000).toISOString(),
      now: new Date(NOW.getTime() + 60 * 60_000),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.lateClaimAccepted).toBe(true);
  });

  it('refuses a late claim whose scan time is after expiry', () => {
    const w = makeWorld();
    const issued = issue(w);
    const account = people.createAccount(w.db, { phoneE164: '+919800000005' }).account.id;

    const result = claimBill(w.db, {
      secret: issued.claimTokenSecret!,
      accountId: account,
      scannedAt: new Date(NOW.getTime() + 30 * 60_000).toISOString(),
      now: new Date(NOW.getTime() + 31 * 60_000),
    });
    expect(result.ok).toBe(false);
  });

  it('refuses a late claim outside the grace period', () => {
    const w = makeWorld();
    const issued = issue(w);
    const account = people.createAccount(w.db, { phoneE164: '+919800000006' }).account.id;

    const result = claimBill(w.db, {
      secret: issued.claimTokenSecret!,
      accountId: account,
      scannedAt: new Date(NOW.getTime() + 60_000).toISOString(),
      now: new Date(NOW.getTime() + claimsRepo.OFFLINE_SCAN_GRACE_MS + 60 * 60_000),
    });
    expect(result.ok).toBe(false);
  });
});

describe('E2 — the person behind you in the queue', () => {
  it('asks for the last 4 digits of the amount on a high-value bill', () => {
    const w = makeWorld();
    // Rs 1,23,456.78 — its digits are "12345678", so the last four are "5678".
    const issued = issue(w, { grandTotalMinor: 1_23_456_78, documentNumber: 'INV/BIG' });
    expect(issued.requiresSecondFactor).toBe(true);

    const account = people.createAccount(w.db, { phoneE164: '+919800000007' }).account.id;

    const wrong = claimBill(w.db, {
      secret: issued.claimTokenSecret!, accountId: account, secondFactor: '1234', now: NOW,
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.reason).toBe('second_factor_failed');
    // A failed attempt must not burn the token — the real buyer is still here.
    expect(claimsRepo.findToken(w.db, issued.claimTokenSecret!)!.consumedAt).toBeNull();

    const right = claimBill(w.db, {
      secret: issued.claimTokenSecret!, accountId: account, secondFactor: '5678', now: NOW,
    });
    expect(right.ok).toBe(true);
  });

  it('does not add friction to an ordinary bill', () => {
    const w = makeWorld();
    expect(issue(w).requiresSecondFactor).toBe(false);
  });

  it('clears the token the moment the bill is claimed', () => {
    const w = makeWorld();
    const issued = issue(w);
    const account = people.createAccount(w.db, { phoneE164: '+919800000008' }).account.id;
    claimBill(w.db, { secret: issued.claimTokenSecret!, accountId: account, now: NOW });

    const token = claimsRepo.findToken(w.db, issued.claimTokenSecret!)!;
    expect(token.consumedAt).not.toBeNull();
  });
});

describe('E6 — a forwarded claim link stops resolving', () => {
  it('shows a stranger only that the bill is already saved', () => {
    const w = makeWorld();
    const issued = issue(w);
    const owner = people.createAccount(w.db, { phoneE164: '+919800000009' }).account.id;
    claimBill(w.db, { secret: issued.claimTokenSecret!, accountId: owner, now: NOW });

    const stranger = resolveClaimToken(w.db, issued.claimTokenSecret!, { viewerAccountId: null });
    expect(stranger.kind).toBe('already_claimed');
    expect(stranger.view).toBeNull();          // no items, no line detail
    expect(stranger.identity).not.toBeNull();  // enough to recognise a mistake
  });

  it('still resolves fully for the owner', () => {
    const w = makeWorld();
    const issued = issue(w);
    const owner = people.createAccount(w.db, { phoneE164: '+919800000010' }).account.id;
    claimBill(w.db, { secret: issued.claimTokenSecret!, accountId: owner, now: NOW });

    const r = resolveClaimToken(w.db, issued.claimTokenSecret!, { viewerAccountId: owner });
    expect(r.kind).toBe('owner');
    expect(r.view?.lines).toHaveLength(1);
  });
});

describe('C-03 — retroactive claim', () => {
  it('lets a walk-in claim yesterday’s bill from the printed slip', () => {
    const w = makeWorld();
    const issued = issue(w);
    const account = people.createAccount(w.db, { phoneE164: '+919800000011' }).account.id;

    const r = retroactiveClaim(w.db, {
      accountId: account,
      merchantId: w.merchantId,
      documentNumber: 'INV/2026/0417',
      financialYear: '2026-27',
      grandTotalMinor: 95500,
      documentDateKey: '2026-09-17',
    });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.matched).toBe('exact');
    expect(billsRepo.getBill(w.db, issued.billId!)!.ownerAccountId).toBe(account);
  });

  it('works after the hold window has orphaned the bill', () => {
    const w = makeWorld();
    const issued = issue(w);
    // 91 days later the sweep orphans it — but it stays claimable.
    sweepHoldWindows(w.db, new Date(NOW.getTime() + 91 * 86_400_000));
    expect(billsRepo.getBill(w.db, issued.billId!)!.state).toBe('orphaned');

    const account = people.createAccount(w.db, { phoneE164: '+919800000012' }).account.id;
    const r = retroactiveClaim(w.db, {
      accountId: account, merchantId: w.merchantId, documentNumber: 'INV/2026/0417',
      financialYear: '2026-27', grandTotalMinor: 95500, documentDateKey: '2026-09-17',
    });
    expect(r.ok).toBe(true);
    expect(billsRepo.getBill(w.db, issued.billId!)!.state).toBe('claimed');
  });

  it('refuses to guess between two candidates', () => {
    const w = makeWorld();
    // Two genuinely different purchases that happen to share shop, day and
    // amount, and neither carries a document number. Different contents, so
    // they are not reprints of each other.
    issue(w, {
      documentNumber: null, grandTotalMinor: 50000,
      lines: [{ lineNo: 0, description: 'Electric kettle', qty: 1, lineTotalMinor: 50000 }],
    });
    issue(w, {
      documentNumber: null, grandTotalMinor: 50000,
      lines: [{ lineNo: 0, description: 'Table lamp', qty: 1, lineTotalMinor: 50000 }],
    });

    const account = people.createAccount(w.db, { phoneE164: '+919800000013' }).account.id;
    const r = retroactiveClaim(w.db, {
      accountId: account, merchantId: w.merchantId, grandTotalMinor: 50000, documentDateKey: '2026-09-17',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('ambiguous');
  });

  it('keeps the shop’s own record canonical over the customer’s copy', () => {
    const w = makeWorld();
    const issued = issue(w);
    const account = people.createAccount(w.db, { phoneE164: '+919800000014' }).account.id;
    retroactiveClaim(w.db, {
      accountId: account, merchantId: w.merchantId, documentNumber: 'INV/2026/0417',
      financialYear: '2026-27', grandTotalMinor: 95500, documentDateKey: '2026-09-17',
      offeredProvenance: 'photo_ocr',
    });
    expect(billsRepo.getBill(w.db, issued.billId!)!.provenance).toBe('print_stream');
  });
});

describe('E1 — split payment across two people', () => {
  it('gives the second person a copy that cannot be double-expensed', () => {
    const w = makeWorld();
    const issued = issue(w);
    const owner = people.createAccount(w.db, { phoneE164: '+919800000015' }).account.id;
    const friend = people.createAccount(w.db, { phoneE164: '+919800000016' }).account.id;
    claimBill(w.db, { secret: issued.claimTokenSecret!, accountId: owner, now: NOW });

    const shared = shareBillCopy(w.db, issued.billId!, friend, NOW);
    const copy = billsRepo.getBill(w.db, shared.sharedBillId)!;

    expect(copy.ownerAccountId).toBe(friend);
    expect(copy.expensable).toBe(false);
    expect(billsRepo.getBill(w.db, issued.billId!)!.expensable).toBe(true);
    // Marked on both sides: they share a bill group.
    expect(copy.billGroupId).toBe(billsRepo.getBill(w.db, issued.billId!)!.billGroupId);
  });
});

describe('E2 — claimed to the wrong profile', () => {
  it('reassigns with an audit entry', () => {
    const w = makeWorld();
    const issued = issue(w);
    claimBill(w.db, { secret: issued.claimTokenSecret!, accountId: w.accountId, now: NOW });

    const business = people.createProfile(w.db, w.accountId, 'business', 'Acme Pvt Ltd', '27AAPFU0939F1ZV');
    const r = reassignProfile(w.db, issued.billId!, w.accountId, business.id);

    expect(r.ok).toBe(true);
    expect(billsRepo.getBill(w.db, issued.billId!)!.ownerProfileId).toBe(business.id);

    const log = w.db.prepare<[string], { action: string }>(
      'SELECT action FROM access_log WHERE bill_id = ?',
    ).all(issued.billId!);
    expect(log.map((l) => l.action)).toContain('profile_reassigned');
  });

  it('refuses to reassign a bill that is not yours', () => {
    const w = makeWorld();
    const issued = issue(w);
    claimBill(w.db, { secret: issued.claimTokenSecret!, accountId: w.accountId, now: NOW });
    const other = people.createAccount(w.db, { phoneE164: '+919800000017' }).account.id;

    expect(reassignProfile(w.db, issued.billId!, other, w.profileId).ok).toBe(false);
  });
});

describe('E2 — phone numbers are recycled', () => {
  it('never binds historical bills to a re-verified number', () => {
    const w = makeWorld();
    const issued = issue(w);
    claimBill(w.db, { secret: issued.claimTokenSecret!, accountId: w.accountId, now: NOW });

    const stranger = people.createAccount(w.db).account.id;
    // The stranger takes over the recycled number.
    const outcome = people.changePhone(w.db, stranger, '+919800000001');

    expect(outcome.historicalBillsRebound).toBe(false);
    expect(billsRepo.getBill(w.db, issued.billId!)!.ownerAccountId).toBe(w.accountId);
    // The number now resolves to the new account only.
    expect(people.findAccountByPhone(w.db, '+919800000001')?.id).toBe(stranger);
  });
});

describe('E2 — two accounts, one person', () => {
  it('merges without creating duplicate bills and flags possible duplicates', () => {
    const w = makeWorld();
    const a = issue(w, { documentNumber: 'INV/A' });
    const b = issue(w, { documentNumber: 'INV/B' });
    const second = people.createAccount(w.db, { phoneE164: '+919800000018' }).account.id;

    claimBill(w.db, { secret: a.claimTokenSecret!, accountId: w.accountId, now: NOW });
    claimBill(w.db, { secret: b.claimTokenSecret!, accountId: second, now: NOW });

    const outcome = people.mergeAccounts(w.db, w.accountId, second);
    expect(outcome.billsMoved).toBe(1);
    expect(billsRepo.countByOwner(w.db, w.accountId)).toBe(2);
    expect(people.getAccount(w.db, second)?.state).toBe('deleted');
  });
});
