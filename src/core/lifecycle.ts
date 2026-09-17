import type { BillState } from './schema.js';

/**
 * Bill lifecycle (C-02).
 *
 *   issued -> unclaimed -> claim_pending -> claimed
 *                    \-> orphaned -> purged
 *
 * Three properties the rest of the system depends on:
 *
 *  - `claimed` is terminal with respect to ownership. E5: when a merchant
 *    leaves the platform "every claimed bill stays fully readable and
 *    exportable forever". Nothing in this table can take a claimed bill away.
 *
 *  - `cancelled` is a *state*, not a deletion (E1 "sale voided seconds after
 *    printing"). A cancelled bill stays in history and leaves expense totals.
 *
 *  - `orphaned` is still claimable. C-03 retroactive claim is the recovery path
 *    for "print succeeded, capture failed" and for every customer who scanned
 *    nothing at the counter, so the hold window gates *purge*, not claiming.
 */

export interface TransitionContext {
  /** Set when the transition is driven by a linked cancellation document. */
  viaDocument?: boolean;
  /** Set when the hold window has elapsed. */
  holdWindowElapsed?: boolean;
}

export interface TransitionResult {
  ok: boolean;
  state: BillState;
  reason: string;
}

type Guard = (ctx: TransitionContext) => string | null;

const ALWAYS: Guard = () => null;

const TRANSITIONS: Record<BillState, Partial<Record<BillState, Guard>>> = {
  issued: {
    unclaimed: ALWAYS,          // claim token minted and on the display/slip
    cancelled: ALWAYS,          // voided before anyone scanned
    claim_pending: ALWAYS,      // scanned before the state was flushed
  },
  unclaimed: {
    claim_pending: ALWAYS,
    claimed: ALWAYS,            // retroactive claim skips the pending step
    orphaned: (ctx) =>
      ctx.holdWindowElapsed ? null : 'hold window has not elapsed',
    cancelled: ALWAYS,
  },
  claim_pending: {
    claimed: ALWAYS,
    unclaimed: ALWAYS,          // abandoned mid-signup; token may be re-offered
    cancelled: ALWAYS,
  },
  claimed: {
    // Ownership never reverts. Reassignment between profiles of the same
    // account (C-04) is not a lifecycle transition — the bill stays `claimed`.
    cancelled: (ctx) =>
      ctx.viaDocument ? null : 'a claimed bill is only cancelled by a linked void document',
  },
  orphaned: {
    // Still reachable: the customer photographs the printed slip weeks later.
    claimed: ALWAYS,
    claim_pending: ALWAYS,
    purged: (ctx) => (ctx.holdWindowElapsed ? null : 'hold window has not elapsed'),
    cancelled: ALWAYS,
  },
  cancelled: {},
  purged: {},
};

export function canTransition(
  from: BillState,
  to: BillState,
  ctx: TransitionContext = {},
): TransitionResult {
  if (from === to) return { ok: true, state: to, reason: 'no-op' };
  const guard = TRANSITIONS[from]?.[to];
  if (!guard) {
    return { ok: false, state: from, reason: `illegal transition ${from} -> ${to}` };
  }
  const blocked = guard(ctx);
  if (blocked) return { ok: false, state: from, reason: blocked };
  return { ok: true, state: to, reason: `${from} -> ${to}` };
}

export function transition(
  from: BillState,
  to: BillState,
  ctx: TransitionContext = {},
): BillState {
  const r = canTransition(from, to, ctx);
  if (!r.ok) throw new Error(`lifecycle: ${r.reason}`);
  return r.state;
}

/** States whose bills a customer can still take ownership of. */
export const CLAIMABLE_STATES: readonly BillState[] = ['issued', 'unclaimed', 'claim_pending', 'orphaned'];

export function isClaimable(state: BillState): boolean {
  return CLAIMABLE_STATES.includes(state);
}

/** A cancelled bill is readable and in history — it is simply not spend. */
export function countsAsSpend(state: BillState): boolean {
  return state !== 'cancelled' && state !== 'purged';
}

/**
 * Open decision §9.01. 90 days is the defensible default: longer improves
 * retroactive claim, worsens the privacy story and the storage bill. It is
 * configuration, not a constant buried in a query, so it can be moved once.
 */
export const DEFAULT_HOLD_WINDOW_DAYS = 90;

/**
 * Purge does not delete the merchant's statutory copy — E2 "account deleted
 * while unclaimed bills reference it" and the retention carve-out disclosed in
 * the consent notice. It de-identifies the customer link and drops the payload
 * the customer never claimed.
 */
export interface PurgePlan {
  deIdentifyCustomerLink: boolean;
  dropCustomerVisiblePayload: boolean;
  retainMerchantStatutoryCopy: boolean;
  retainedFields: string[];
}

export function purgePlanFor(state: BillState): PurgePlan {
  return {
    deIdentifyCustomerLink: true,
    dropCustomerVisiblePayload: state !== 'claimed',
    retainMerchantStatutoryCopy: true,
    retainedFields: [
      'merchantId', 'outletId', 'documentNumber', 'financialYear',
      'documentDateKey', 'grandTotalMinor', 'currency', 'taxTotalMinor',
    ],
  };
}
