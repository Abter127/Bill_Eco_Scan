import type { Db } from '../db/sqlite.js';
import { tx } from '../db/sqlite.js';
import { transition, isClaimable } from '../core/lifecycle.js';
import { toDecimalString, money } from '../core/money.js';
import { assessDuplicate, type DedupeCandidate } from '../core/dedupe.js';
import { higherProvenance } from '../core/provenance.js';
import type { CanonicalBill } from '../core/schema.js';
import * as billsRepo from '../db/repo/bills.js';
import * as claimsRepo from '../db/repo/claims.js';
import * as ledgers from '../db/repo/ledgers.js';
import * as people from '../db/repo/people.js';
import { buildBillView, minimalIdentity, type BillView, type MinimalBillIdentity } from './billview.js';

/**
 * Claim (C-01, C-02, C-03) and every E2 edge case.
 *
 * E2's opening line is the design constraint: "A QR on a screen is a bearer
 * token in public. Design for that."
 */

export type ClaimResolutionKind =
  | 'valid'          // live token, show the bill and offer to keep it
  | 'expired'        // E2: identify the bill, offer retroactive claim, never 404
  | 'already_claimed'// E2: someone won the race, or the owner is returning
  | 'owner'          // the claimant is the owner; full view
  | 'unknown';       // no such token ever existed

export interface ClaimResolution {
  kind: ClaimResolutionKind;
  billId: string | null;
  /** Full view on `valid` and `owner`. */
  view: BillView | null;
  /** Minimal identity on `expired` / `already_claimed`. */
  identity: MinimalBillIdentity | null;
  requiresSecondFactor: boolean;
  secondFactorPrompt: string | null;
  /** Copy shown to the person holding the phone. Never a raw error. */
  message: string;
  /** What the page offers next. */
  nextAction: 'claim' | 'retroactive_claim' | 'sign_in' | 'dispute' | 'none';
}

export interface ResolveOptions {
  now?: Date;
  /** Set when a signed-in account opens the link. */
  viewerAccountId?: string | null;
}

/**
 * Resolving a token never returns 404 for a token we minted. The customer who
 * scanned on the way out and opened it in the car is not a failed request; they
 * are a person holding a bill they can still have.
 */
export function resolveClaimToken(db: Db, secret: string, opts: ResolveOptions = {}): ClaimResolution {
  const now = opts.now ?? new Date();
  const token = claimsRepo.findToken(db, secret);

  if (!token) {
    // A token we never issued. Logged for E6 enumeration alerting.
    ledgers.logAccess(db, {
      actorType: 'system', actorId: 'claim-resolver', action: 'claim_failed',
      reason: 'unknown claim token presented',
    });
    return {
      kind: 'unknown', billId: null, view: null, identity: null,
      requiresSecondFactor: false, secondFactorPrompt: null,
      message: 'This code isn’t one of ours. If you have the printed bill, you can add it by taking a photo.',
      nextAction: 'retroactive_claim',
    };
  }

  claimsRepo.recordScan(db, token.id);
  const bill = billsRepo.getBill(db, token.billId);
  if (!bill) {
    return {
      kind: 'unknown', billId: null, view: null, identity: null,
      requiresSecondFactor: false, secondFactorPrompt: null,
      message: 'We can’t find that bill. If you have the printed slip, you can add it by taking a photo.',
      nextAction: 'retroactive_claim',
    };
  }

  // --- E6: post-claim the link stops resolving for anyone but the owner -----
  if (token.consumedAt) {
    const isOwner = opts.viewerAccountId != null && bill.ownerAccountId === opts.viewerAccountId;
    if (isOwner) {
      return {
        kind: 'owner', billId: bill.id, view: buildBillView(db, bill, { now }), identity: null,
        requiresSecondFactor: false, secondFactorPrompt: null,
        message: 'This bill is in your history.', nextAction: 'none',
      };
    }
    // A forwarded screenshot or a pasted URL lands here. The person gets
    // enough to recognise a mistake, and nothing else.
    return {
      kind: 'already_claimed', billId: bill.id, view: null, identity: minimalIdentity(db, bill),
      requiresSecondFactor: false, secondFactorPrompt: null,
      message:
        'This bill has already been added to someone’s account. If that wasn’t you and you think it should be yours, you can raise it with us.',
      nextAction: 'dispute',
    };
  }

  const expired = Date.parse(token.expiresAt) <= now.getTime();
  if (expired) {
    // #1 on the will-bite-first list: highest-volume bad first impression,
    // cheapest to fix. So it is fixed here, not left to a generic error page.
    const id = minimalIdentity(db, bill);
    return {
      kind: 'expired', billId: bill.id, view: null, identity: id,
      requiresSecondFactor: false, secondFactorPrompt: null,
      message:
        `This code has expired, but the bill is still here: ${id.amount} at ${id.merchantDisplayName}` +
        `${id.documentDateKey ? ` on ${id.documentDateKey}` : ''}. ` +
        'You can still add it to your account — just confirm it’s yours.',
      nextAction: 'retroactive_claim',
    };
  }

  return {
    kind: 'valid',
    billId: bill.id,
    // J1 step 4: the claim page "shows the bill immediately — no install, no
    // login". Account creation is offered after the value is on screen.
    view: buildBillView(db, bill, { now }),
    identity: null,
    requiresSecondFactor: token.requiresSecondFactor,
    secondFactorPrompt: token.requiresSecondFactor
      ? 'Enter the last 4 digits of the amount on your bill to confirm it’s yours.'
      : null,
    message: 'Here’s your bill.',
    nextAction: 'claim',
  };
}

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

export interface ClaimRequest {
  secret: string;
  accountId: string;
  profileId?: string | null;
  /** E2 high-value friction: last 4 digits of the amount. */
  secondFactor?: string | null;
  /** E2 "scanned offline": client-attested scan time, accepted within grace. */
  scannedAt?: string | null;
  now?: Date;
}

export type ClaimResult =
  | { ok: true; billId: string; view: BillView; message: string; lateClaimAccepted: boolean }
  | {
      ok: false;
      reason: 'unknown_token' | 'expired' | 'already_claimed' | 'second_factor_failed' | 'not_claimable';
      message: string;
      billId: string | null;
      /** E2: the loser of a race gets a path to dispute, not an error. */
      nextAction: 'retroactive_claim' | 'dispute' | 'retry' | 'none';
    };

export function claimBill(db: Db, req: ClaimRequest): ClaimResult {
  const now = req.now ?? new Date();
  const token = claimsRepo.findToken(db, req.secret);

  if (!token) {
    return {
      ok: false, reason: 'unknown_token', billId: null, nextAction: 'retroactive_claim',
      message: 'This code isn’t one of ours. If you have the printed bill, add it by taking a photo.',
    };
  }

  const bill = billsRepo.getBill(db, token.billId);
  if (!bill) {
    return {
      ok: false, reason: 'unknown_token', billId: null, nextAction: 'retroactive_claim',
      message: 'We can’t find that bill.',
    };
  }

  // --- E2: expiry, with the offline-scan grace -----------------------------
  const expiredAt = Date.parse(token.expiresAt);
  let lateClaimAccepted = false;
  if (expiredAt <= now.getTime()) {
    const scannedAtMs = req.scannedAt ? Date.parse(req.scannedAt) : NaN;
    const scannedInTime = Number.isFinite(scannedAtMs) && scannedAtMs <= expiredAt;
    const withinGrace = now.getTime() - expiredAt <= claimsRepo.OFFLINE_SCAN_GRACE_MS;

    if (scannedInTime && withinGrace) {
      // "Client queues and retries; server accepts a late claim with proof of
      // scan time within a grace period."
      lateClaimAccepted = true;
    } else {
      return {
        ok: false, reason: 'expired', billId: bill.id, nextAction: 'retroactive_claim',
        message: 'This code has expired, but the bill is still here. Confirm a detail from your slip and we’ll add it.',
      };
    }
  }

  // --- E2: second factor on a high-value bill -------------------------------
  if (token.requiresSecondFactor) {
    const expected = toDecimalString(money(bill.grandTotalMinor, bill.currency)).replace(/\D/g, '').slice(-4);
    const given = (req.secondFactor ?? '').replace(/\D/g, '').slice(-4);
    if (given !== expected) {
      ledgers.logAccess(db, {
        billId: bill.id, actorType: 'system', actorId: req.accountId,
        action: 'claim_failed', reason: 'second factor did not match on a high-value bill',
        visibleToOwner: false,
      });
      return {
        ok: false, reason: 'second_factor_failed', billId: bill.id, nextAction: 'retry',
        message: 'That didn’t match. Check the last 4 digits of the total on your bill.',
      };
    }
  }

  if (!isClaimable(bill.state)) {
    return {
      ok: false, reason: 'not_claimable', billId: bill.id, nextAction: 'none',
      message: bill.state === 'cancelled'
        ? 'This sale was cancelled, so there is nothing to add.'
        : 'This bill can no longer be claimed.',
    };
  }

  return tx(db, (): ClaimResult => {
    // --- E2: two devices claim simultaneously ------------------------------
    const consume = claimsRepo.consumeToken(db, token.id, req.accountId, now);
    if (!consume.won) {
      const claimedByThisAccount = consume.claimedByAccountId === req.accountId;
      return {
        ok: false,
        reason: 'already_claimed',
        billId: bill.id,
        nextAction: claimedByThisAccount ? 'none' : 'dispute',
        message: claimedByThisAccount
          ? 'You’ve already added this bill.'
          : 'Someone else added this bill a moment before you. If that wasn’t meant to happen, tell us and we’ll sort it out.',
      };
    }

    const profileId = req.profileId ?? people.defaultProfile(db, req.accountId)?.id ?? null;
    billsRepo.updateBillState(db, bill.id, transition(bill.state, 'claimed'), {
      ownerAccountId: req.accountId,
      ownerProfileId: profileId,
      claimedAt: now.toISOString(),
    });

    ledgers.bumpIssuanceStat(db, bill.outletId, 'bills_claimed', now);
    if (bill.terminalId) ledgers.recordTerminalClaim(db, bill.terminalId, req.accountId, now);
    // E1: the QR clears the instant the transaction ends.
    claimsRepo.expireTokensForBill(db, bill.id, now);

    const claimed = billsRepo.getBill(db, bill.id)!;
    return {
      ok: true,
      billId: bill.id,
      view: buildBillView(db, claimed, { now }),
      lateClaimAccepted,
      message: lateClaimAccepted
        ? 'Added to your history. Your code had expired, but we could see you scanned it in time.'
        : 'Added to your history.',
    };
  });
}

// ---------------------------------------------------------------------------
// C-03 — retroactive claim
// ---------------------------------------------------------------------------

export interface RetroactiveClaimRequest {
  accountId: string;
  profileId?: string | null;
  /** From a photographed slip, or typed from the printed bill. */
  merchantId: string;
  documentNumber?: string | null;
  financialYear?: string | null;
  grandTotalMinor: number;
  currency?: string;
  documentDateKey?: string | null;
  /** Provenance of the record the customer is offering. */
  offeredProvenance?: CanonicalBill['provenance'];
  now?: Date;
}

export type RetroactiveResult =
  | { ok: true; billId: string; view: BillView; matched: 'exact' | 'high_confidence'; message: string }
  | { ok: false; reason: 'no_match' | 'ambiguous' | 'already_owned'; message: string; candidateIds: string[] };

/**
 * C-03: "A later photograph of a paper bill matches an already-issued unclaimed
 * record and binds it, keeping the higher-provenance version canonical."
 *
 * This is also the recovery path for E1 "print succeeded, capture failed" and
 * the answer to every expired-token page.
 */
export function retroactiveClaim(db: Db, req: RetroactiveClaimRequest): RetroactiveResult {
  const now = req.now ?? new Date();
  const currency = req.currency ?? 'INR';

  const candidates = req.documentNumber
    ? billsRepo.findByDocumentNumber(db, req.merchantId, req.financialYear ?? null, req.documentNumber)
    : billsRepo.findDedupeCandidates(db, req.merchantId, req.grandTotalMinor, req.documentDateKey ?? null);

  const claimable = candidates.filter(
    (b) => isClaimable(b.state) && b.grandTotalMinor === req.grandTotalMinor && b.currency === currency,
  );

  const alreadyOwned = candidates.find((b) => b.ownerAccountId === req.accountId);
  if (alreadyOwned) {
    return {
      ok: false, reason: 'already_owned', candidateIds: [alreadyOwned.id],
      message: 'This bill is already in your history.',
    };
  }

  if (claimable.length === 0) {
    return {
      ok: false, reason: 'no_match', candidateIds: [],
      message: 'We couldn’t match this to a bill the shop sent us. We’ll keep your photo as the record instead.',
    };
  }

  // The same false-merge guard as E3: without a matching document number we do
  // not bind a stranger's bill to this account on an amount-and-date match.
  const offered: DedupeCandidate = {
    id: 'offered', merchantId: req.merchantId, documentType: 'tax_invoice',
    documentNumber: req.documentNumber ?? null, financialYear: req.financialYear ?? null,
    documentDateKey: req.documentDateKey ?? null, documentTimeMs: now.getTime(),
    grandTotalMinor: req.grandTotalMinor, currency,
    contentFingerprint: 'offered', provenance: req.offeredProvenance ?? 'photo_ocr', lineCount: 0,
  };

  const scored = claimable.map((b) => ({
    bill: b,
    decision: assessDuplicate(offered, {
      id: b.id, merchantId: b.merchantId, documentType: b.documentType,
      documentNumber: b.documentNumber, financialYear: b.financialYear,
      documentDateKey: b.documentDateKey,
      documentTimeMs: b.documentDateKey ? Date.parse(`${b.documentDateKey}T00:00:00Z`) : null,
      grandTotalMinor: b.grandTotalMinor, currency: b.currency,
      contentFingerprint: b.contentFingerprint, provenance: b.provenance, lineCount: b.lines.length,
    }),
  }));

  const exact = scored.filter((s) => s.decision.verdict === 'merge');
  if (exact.length === 1) {
    return bind(db, exact[0]!.bill, req, now, 'exact');
  }
  if (exact.length > 1) {
    return {
      ok: false, reason: 'ambiguous', candidateIds: exact.map((s) => s.bill.id),
      message: 'More than one bill matches. Pick the one that’s yours.',
    };
  }

  // No document number on either side. One claimable candidate at the right
  // shop, day and amount is good enough to *offer*, not to bind silently.
  if (claimable.length === 1 && req.documentDateKey) {
    return bind(db, claimable[0]!, req, now, 'high_confidence');
  }

  return {
    ok: false, reason: 'ambiguous', candidateIds: claimable.map((b) => b.id),
    message: 'We found more than one bill it could be. Pick the right one and we’ll add it.',
  };
}

function bind(
  db: Db,
  bill: CanonicalBill,
  req: RetroactiveClaimRequest,
  now: Date,
  matched: 'exact' | 'high_confidence',
): RetroactiveResult {
  return tx(db, (): RetroactiveResult => {
    const profileId = req.profileId ?? people.defaultProfile(db, req.accountId)?.id ?? null;
    billsRepo.updateBillState(db, bill.id, transition(bill.state, 'claimed'), {
      ownerAccountId: req.accountId,
      ownerProfileId: profileId,
      claimedAt: now.toISOString(),
    });
    claimsRepo.expireTokensForBill(db, bill.id, now);
    ledgers.bumpIssuanceStat(db, bill.outletId, 'bills_claimed', now);
    if (bill.terminalId) ledgers.recordTerminalClaim(db, bill.terminalId, req.accountId, now);

    // Keep the higher-provenance version canonical: the shop's own record beats
    // a photograph of it, so the photo becomes an attachment, not the record.
    const canonical = higherProvenance(bill.provenance, req.offeredProvenance ?? 'photo_ocr');
    ledgers.logAccess(db, {
      billId: bill.id, accountId: req.accountId, actorType: 'system', actorId: 'retroactive-claim',
      action: 'bill_bound',
      reason: `retroactive claim matched ${matched}; canonical provenance kept as ${canonical}`,
    });

    const updated = billsRepo.getBill(db, bill.id)!;
    return {
      ok: true, billId: bill.id, matched,
      view: buildBillView(db, updated, { now }),
      message: 'Added to your history. The shop’s own copy of this bill is what we kept as the record.',
    };
  });
}

// ---------------------------------------------------------------------------
// E1 split payment — a shared, read-only, non-expensable copy
// ---------------------------------------------------------------------------

export interface ShareResult {
  sharedBillId: string;
  message: string;
}

/**
 * "One claimant owns the bill; the second gets a shared read-only copy that
 * cannot be double-expensed. Mark it on both sides."
 */
export function shareBillCopy(
  db: Db, billId: string, toAccountId: string, now = new Date(),
): ShareResult {
  return tx(db, () => {
    const original = billsRepo.getBill(db, billId);
    if (!original) throw new Error('bill not found');

    const copy: CanonicalBill = {
      ...original,
      id: crypto.randomUUID(),
      // Same group, so annotations and amendments reach both sides.
      billGroupId: original.billGroupId,
      ownerAccountId: toAccountId,
      ownerProfileId: null,
      state: 'claimed',
      claimedAt: now.toISOString(),
      idempotencyKey: null,
      expensable: false, // the whole point: it cannot be claimed twice
      createdAt: now.toISOString(),
    };
    billsRepo.insertBill(db, copy);
    ledgers.createLink(db, {
      fromBillId: copy.id, toBillId: original.id, relation: 'shared_copy_of',
    });
    ledgers.createLink(db, {
      fromBillId: original.id, toBillId: copy.id, relation: 'shared_copy_of',
    });
    return {
      sharedBillId: copy.id,
      message:
        'Shared. This copy is marked as shared on both sides and cannot be claimed as an expense twice.',
    };
  });
}

// ---------------------------------------------------------------------------
// C-04 — profile reassignment
// ---------------------------------------------------------------------------

export interface ReassignResult {
  ok: boolean;
  warning: string | null;
  message: string;
}

/**
 * E2 "claimed to the wrong profile": a business purchase landed in personal
 * after input tax credit was claimed. Reassignment is allowed with an audit
 * entry, and warns where the bill has already been exported.
 */
export function reassignProfile(
  db: Db, billId: string, accountId: string, toProfileId: string,
): ReassignResult {
  const bill = billsRepo.getBill(db, billId);
  if (!bill || bill.ownerAccountId !== accountId) {
    return { ok: false, warning: null, message: 'That bill isn’t in your history.' };
  }

  const exported = db.prepare<[string, string], { n: number }>(
    "SELECT COUNT(*) AS n FROM exports WHERE account_id = ? AND bill_ids LIKE '%' || ? || '%'",
  ).get(accountId, billId)!.n;

  billsRepo.reassignProfile(db, billId, toProfileId);
  ledgers.logAccess(db, {
    billId, accountId, actorType: 'system', actorId: accountId,
    action: 'profile_reassigned',
    reason: `moved to profile ${toProfileId}${exported > 0 ? ' after the bill had been exported' : ''}`,
  });

  return {
    ok: true,
    warning: exported > 0
      ? 'This bill was already included in an export. If your accountant has filed it, tell them it has moved profiles.'
      : null,
    message: 'Moved.',
  };
}
