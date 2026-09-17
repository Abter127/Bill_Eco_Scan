import type { Db } from '../db/sqlite.js';
import { nowIso, tx } from '../db/sqlite.js';
import { newId } from '../core/ids.js';
import { contentFingerprint, isWithinReprintWindow } from '../core/fingerprint.js';
import { assessClockSkew, financialYearOf, localDateKey } from '../core/time.js';
import { classifyDocument, documentTypeForStream } from '../core/classify.js';
import { parseEscPosStream } from '../core/escpos.js';
import { extractBillFromText } from '../core/extract.js';
import { classifySensitivity } from '../core/sensitivity.js';
import { DEFAULT_HOLD_WINDOW_DAYS } from '../core/lifecycle.js';
import { billPayloadSchema, type BillPayload, type CanonicalBill, type FieldConfidence } from '../core/schema.js';
import * as billsRepo from '../db/repo/bills.js';
import * as registry from '../db/repo/registry.js';
import * as claims from '../db/repo/claims.js';
import * as ledgers from '../db/repo/ledgers.js';

/**
 * Issuance (M-01, M-03, M-05) — the counter path.
 *
 * The cashier's moment that matters is "the four seconds between total and
 * tender. Anything you add here, you lose." So nothing in this path blocks the
 * sale: a rejection, a quarantine or a duplicate all return quickly and the
 * printer is never waiting on us.
 */

export interface IssuanceContext {
  terminalId: string;
  outletId: string;
  merchantId: string;
  now?: Date;
  /** E1: the printer jammed. We still issue the QR. */
  printerFailed?: boolean;
  /** M-03: the token was minted locally during an outage. */
  offlineSigned?: boolean;
}

export type IngestOutcome =
  | 'created'
  | 'duplicate_reprint'
  | 'quarantined'
  | 'rejected'
  | 'linked_document';

export interface IngestResult {
  outcome: IngestOutcome;
  billId: string | null;
  /** Present only on `created`. Returned exactly once. */
  claimTokenSecret?: string;
  claimTokenExpiresAt?: string;
  requiresSecondFactor?: boolean;
  reason: string;
  /** What the agent should do with paper (T-05). */
  paper: 'print' | 'suppress';
  warnings: string[];
}

/** Open decision §9.01 — configurable, defaulted, documented. */
export interface IssuanceConfig {
  holdWindowDays: number;
}

export const DEFAULT_ISSUANCE_CONFIG: IssuanceConfig = {
  holdWindowDays: DEFAULT_HOLD_WINDOW_DAYS,
};

// ---------------------------------------------------------------------------
// Entry point 1: raw print stream (M-01)
// ---------------------------------------------------------------------------

export interface PrintStreamResult {
  results: IngestResult[];
  fragmentsSeen: number;
  quarantined: number;
}

/**
 * Takes the bytes the POS sent to the printer. Frames them on cut boundaries,
 * classifies each fragment, and only then considers ingesting.
 */
export function ingestPrintStream(
  db: Db,
  ctx: IssuanceContext,
  bytes: Buffer,
  config: IssuanceConfig = DEFAULT_ISSUANCE_CONFIG,
): PrintStreamResult {
  const now = ctx.now ?? new Date();
  const fragments = parseEscPosStream(bytes);
  const results: IngestResult[] = [];
  let quarantined = 0;

  for (const fragment of fragments) {
    // E1 "two terminals, one printer": reject rather than guess a repair.
    if (!fragment.structurallyValid) {
      ledgers.quarantine(db, {
        terminalId: ctx.terminalId,
        outletId: ctx.outletId,
        streamClass: 'unknown',
        reason: fragment.validationErrors.join(', '),
        preview: fragment.lines.join('\n'),
      });
      ledgers.bumpIssuanceStat(db, ctx.outletId, 'quarantined', now);
      quarantined++;
      results.push({
        outcome: 'quarantined', billId: null, paper: 'print',
        reason: `fragment failed structural validation: ${fragment.validationErrors.join(', ')}`,
        warnings: fragment.validationErrors,
      });
      continue;
    }

    const classification = classifyDocument(fragment.lines);
    if (classification.quarantine) {
      ledgers.quarantine(db, {
        terminalId: ctx.terminalId,
        outletId: ctx.outletId,
        streamClass: classification.streamClass,
        reason: classification.reason,
        confidence: classification.confidence,
        preview: fragment.lines.join('\n'),
      });
      ledgers.bumpIssuanceStat(db, ctx.outletId, 'quarantined', now);
      quarantined++;
      results.push({
        outcome: 'quarantined', billId: null, paper: 'print',
        reason: `${classification.streamClass}: ${classification.reason}`,
        warnings: [],
      });
      continue;
    }

    const merchant = registry.getMerchant(db, ctx.merchantId);
    const extracted = extractBillFromText(fragment.lines, {
      source: 'printed',
      captureDate: now,
      merchantDateOrder: 'DMY',
    });

    if (extracted.grandTotalMinor === null) {
      ledgers.quarantine(db, {
        terminalId: ctx.terminalId, outletId: ctx.outletId,
        streamClass: 'unknown', reason: 'no total could be located on the slip',
        preview: fragment.lines.join('\n'),
      });
      quarantined++;
      results.push({
        outcome: 'quarantined', billId: null, paper: 'print',
        reason: 'no total could be located on the slip', warnings: [],
      });
      continue;
    }

    const subType = documentTypeForStream(fragment.lines);
    const payload: BillPayload = billPayloadSchema.parse({
      idempotencyKey: newId(),
      outletId: ctx.outletId,
      terminalId: ctx.terminalId,
      documentType: subType ?? (extracted.looksHandwritten ? 'kacha' : extracted.gstin ? 'tax_invoice' : 'bill_of_supply'),
      documentNumber: extracted.documentNumber,
      terminalTime: now.toISOString(),
      documentDateKey: extracted.documentDateKey,
      currency: extracted.currency,
      subtotalMinor: extracted.subtotalMinor,
      taxTotalMinor: extracted.taxTotalMinor,
      discountTotalMinor: extracted.discountTotalMinor,
      roundOffMinor: extracted.roundOffMinor,
      grandTotalMinor: extracted.grandTotalMinor,
      paymentMethod: extracted.paymentMethod,
      lines: extracted.lines,
    });

    results.push(
      ingestBill(db, ctx, payload, config, {
        provenance: 'print_stream',
        extraFields: extracted.fields,
        documentDateAmbiguous: extracted.documentDateAmbiguous,
        documentDateCandidates: extracted.documentDateCandidates,
        lineSumMinor: extracted.lineSumMinor,
        sumDiscrepancyMinor: extracted.sumDiscrepancyMinor,
        sumDiscrepancyFlagged: extracted.sumDiscrepancyFlagged,
        notATaxInvoice: extracted.looksHandwritten || !extracted.gstin,
        merchantCategory: merchant?.category ?? null,
        merchantName: merchant?.tradeName ?? merchant?.legalName ?? null,
        // A reprint marker means the same purchase; the fingerprint check below
        // is what actually resolves it, but we widen the window when the slip
        // tells us outright.
        declaredReprint: classification.streamClass === 'reprint',
      }),
    );
  }

  return { results, fragmentsSeen: fragments.length, quarantined };
}

// ---------------------------------------------------------------------------
// Entry point 2: structured payload (agent, merchant PWA, connectors)
// ---------------------------------------------------------------------------

export interface IngestOptions {
  provenance: CanonicalBill['provenance'];
  extraFields?: FieldConfidence[];
  documentDateAmbiguous?: boolean;
  documentDateCandidates?: string[];
  lineSumMinor?: number | null;
  sumDiscrepancyMinor?: number | null;
  sumDiscrepancyFlagged?: boolean;
  notATaxInvoice?: boolean;
  merchantCategory?: string | null;
  merchantName?: string | null;
  declaredReprint?: boolean;
  /** T-05: honoured where the counter knows the customer's preference. */
  formatPreference?: 'paper' | 'digital' | 'both';
  /**
   * M-03: a token the agent minted and displayed during an outage. Registering
   * it rather than issuing a new one is what makes the QR the customer already
   * scanned resolve once we reconnect.
   */
  offlineClaimToken?: { secret: string; issuedAt: string };
}

export function ingestBill(
  db: Db,
  ctx: IssuanceContext,
  rawPayload: BillPayload,
  config: IssuanceConfig = DEFAULT_ISSUANCE_CONFIG,
  opts: IngestOptions = { provenance: 'print_stream' },
): IngestResult {
  const payload = billPayloadSchema.parse(rawPayload);
  const now = ctx.now ?? new Date();
  const warnings: string[] = [];

  // --- M-03: idempotent replay -------------------------------------------
  // A four-hour outage replays the whole local queue. Every key that already
  // landed returns its original response, so the replay reconciles with zero
  // duplicates and zero losses.
  const existing = claims.findIdempotency(db, payload.idempotencyKey);
  if (existing) {
    return {
      ...(existing.response as IngestResult),
      reason: 'replayed: this idempotency key was already processed',
    };
  }

  // --- E7: clock skew ------------------------------------------------------
  const terminalTime = new Date(payload.terminalTime);
  const skew = assessClockSkew(terminalTime, now);
  if (skew.flagged) warnings.push(`terminal clock: ${skew.reason} (${Math.round(skew.skewMs / 1000)}s)`);

  const documentDateKey = payload.documentDateKey ?? localDateKey(skew.trustedTime);
  const financialYear = financialYearOf(documentDateKey).label;

  // --- E1: reprint detection by content, not print event -------------------
  const fingerprint = contentFingerprint({
    merchantId: ctx.merchantId,
    outletId: ctx.outletId,
    documentNumber: payload.documentNumber,
    documentDateKey,
    grandTotalMinor: payload.grandTotalMinor,
    currency: payload.currency,
    lines: payload.lines.map((l) => ({
      description: l.description, qty: l.qty, lineTotalMinor: l.lineTotalMinor,
    })),
  });

  const prior = billsRepo.findByFingerprint(db, ctx.merchantId, fingerprint);
  if (prior && (opts.declaredReprint || isWithinReprintWindow(new Date(prior.createdAt), now))) {
    // "A second identical stream within the window updates nothing and issues
    // no new claim token."
    const result: IngestResult = {
      outcome: 'duplicate_reprint',
      billId: prior.id,
      reason: 'identical content already captured; no new bill and no new claim token',
      paper: 'print',
      warnings,
    };
    claims.recordIdempotency(db, payload.idempotencyKey, prior.id, 'duplicate_reprint', result);
    registry.recordBillSeen(db, ctx.terminalId, now.toISOString());
    return result;
  }

  // --- E1: line totals versus the printed grand total -----------------------
  const lineSum = opts.lineSumMinor !== undefined
    ? opts.lineSumMinor
    : payload.lines.length > 0
      ? payload.lines.reduce((acc, l) => acc + l.lineTotalMinor, 0)
      : null;

  let sumDiscrepancy = opts.sumDiscrepancyMinor ?? null;
  let sumFlagged = opts.sumDiscrepancyFlagged ?? false;
  if (sumDiscrepancy === null && lineSum !== null) {
    const expected = lineSum + (payload.taxTotalMinor ?? 0)
      - (payload.discountTotalMinor ?? 0) + (payload.roundOffMinor ?? 0);
    sumDiscrepancy = payload.grandTotalMinor - expected;
    sumFlagged = sumDiscrepancy !== 0;
  }
  if (sumFlagged) {
    // Never silently reconcile: store both and treat the printed total as canonical.
    warnings.push(`line items do not reconcile to the printed total (difference ${sumDiscrepancy})`);
  }

  const merchant = registry.getMerchant(db, ctx.merchantId);
  const { sensitivityClass } = classifySensitivity(
    opts.merchantCategory ?? merchant?.category ?? null,
    opts.merchantName ?? merchant?.tradeName ?? merchant?.legalName ?? null,
  );

  const isLinkedDocument =
    payload.documentType === 'credit_note' ||
    payload.documentType === 'void' ||
    payload.documentType === 'amendment' ||
    payload.documentType === 'debit_note';

  const billId = newId();
  const holdExpiresAt = new Date(
    now.getTime() + config.holdWindowDays * 86_400_000,
  ).toISOString();

  const bill: CanonicalBill = {
    id: billId,
    billGroupId: billId, // replaced below when this document links to a group
    merchantId: ctx.merchantId,
    outletId: ctx.outletId,
    terminalId: ctx.terminalId,
    documentType: payload.documentType,
    documentNumber: payload.documentNumber,
    financialYear,
    documentDateKey,
    documentDateAmbiguous: opts.documentDateAmbiguous ?? false,
    documentDateCandidates: opts.documentDateCandidates ?? [],
    terminalTime: payload.terminalTime,
    serverReceiptTime: now.toISOString(),
    clockSkewMs: skew.skewMs,
    clockSkewFlagged: skew.flagged,
    currency: payload.currency,
    subtotalMinor: payload.subtotalMinor,
    taxTotalMinor: payload.taxTotalMinor,
    discountTotalMinor: payload.discountTotalMinor,
    roundOffMinor: payload.roundOffMinor,
    grandTotalMinor: payload.grandTotalMinor,
    lineSumMinor: lineSum,
    sumDiscrepancyMinor: sumDiscrepancy,
    sumDiscrepancyFlagged: sumFlagged,
    paymentMethod: payload.paymentMethod,
    buyerGstin: payload.buyerGstin,
    placeOfSupply: payload.placeOfSupply,
    provenance: opts.provenance,
    contentFingerprint: fingerprint,
    idempotencyKey: payload.idempotencyKey,
    state: 'issued',
    ownerAccountId: null,
    ownerProfileId: null,
    sensitivityClass,
    notATaxInvoice: opts.notATaxInvoice ?? payload.documentType === 'kacha',
    expensable: true,
    isSharedCopy: false,
    imageRef: null,
    rawSourceRef: payload.rawSourceRef,
    claimedAt: null,
    holdExpiresAt,
    createdAt: now.toISOString(),
    lines: payload.lines,
    fields: opts.extraFields ?? [],
  };

  const result = tx(db, (): IngestResult => {
    // --- resolve declared links, parking the ones whose target is missing ---
    let groupId = billId;
    let linkedToExisting = false;

    for (const link of payload.links) {
      const targets = billsRepo.findByDocumentNumber(
        db, ctx.merchantId, financialYear, link.targetDocumentNumber,
      );
      const target = targets[0];
      if (target) {
        groupId = target.billGroupId;
        linkedToExisting = true;
      }
    }
    bill.billGroupId = groupId;

    billsRepo.insertBill(db, bill);

    for (const link of payload.links) {
      const targets = billsRepo.findByDocumentNumber(
        db, ctx.merchantId, financialYear, link.targetDocumentNumber,
      );
      const target = targets[0];
      ledgers.createLink(db, {
        fromBillId: billId,
        toBillId: target?.id ?? null,
        toDocumentNumber: link.targetDocumentNumber,
        toMerchantId: ctx.merchantId,
        relation: link.relation,
        targetLineNos: link.targetLineNos,
      });
      if (!target) {
        // E4: accept and park orphan amendments; reconcile when the original
        // arrives, alert if it never does.
        warnings.push(
          `target document ${link.targetDocumentNumber} has not arrived yet; amendment parked for reconciliation`,
        );
      }
    }

    // --- E4: a parked credit note may have been waiting for *this* bill -----
    if (payload.documentNumber) {
      for (const parked of ledgers.parkedLinksFor(db, ctx.merchantId, payload.documentNumber)) {
        ledgers.resolveLink(db, parked.id, billId);
        warnings.push(`reconciled a previously parked ${parked.relation} document`);
      }
    }

    registry.recordBillSeen(db, ctx.terminalId, now.toISOString());
    ledgers.bumpIssuanceStat(db, ctx.outletId, 'bills_issued', now);

    // A credit note or void attaches to the bill it amends. It does not get its
    // own claim QR — the customer already owns the document it modifies.
    if (isLinkedDocument) {
      billsRepo.updateBillState(db, billId, 'unclaimed');
      const r: IngestResult = {
        outcome: 'linked_document',
        billId,
        reason: `${payload.documentType} stored as a linked document${linkedToExisting ? ' on the original bill group' : ' awaiting its original'}`,
        paper: 'print',
        warnings,
      };
      claims.recordIdempotency(db, payload.idempotencyKey, billId, 'created', r);
      return r;
    }

    // --- M-02: mint the claim token ----------------------------------------
    // E1 "capture succeeded, print failed": never suppress the QR because the
    // printer failed. If both fail the sale still completes and our outage is
    // invisible to the shopper.
    const token = opts.offlineClaimToken
      ? claims.registerOfflineToken(
          db, billId, opts.offlineClaimToken.secret, opts.offlineClaimToken.issuedAt,
          undefined, payload.grandTotalMinor,
        )
      : claims.issueClaimToken(db, billId, {
          now,
          grandTotalMinor: payload.grandTotalMinor,
          offlineSigned: ctx.offlineSigned ?? false,
        });
    billsRepo.updateBillState(db, billId, 'unclaimed');

    // T-05: paper is always the fallback. Suppression happens only on a stored
    // customer preference — never because the merchant would prefer it.
    const paper: 'print' | 'suppress' =
      opts.formatPreference === 'digital' ? 'suppress' : 'print';
    ledgers.bumpIssuanceStat(db, ctx.outletId, paper === 'print' ? 'paper_printed' : 'paper_suppressed', now);

    const r: IngestResult = {
      outcome: 'created',
      billId,
      claimTokenSecret: token.secret,
      claimTokenExpiresAt: token.expiresAt,
      requiresSecondFactor: token.requiresSecondFactor,
      reason: 'bill stored and claim token issued',
      paper,
      warnings,
    };
    // The secret is not persisted in the idempotency response: a replay
    // returns the outcome, never a fresh copy of a bearer credential.
    claims.recordIdempotency(db, payload.idempotencyKey, billId, 'created', {
      ...r, claimTokenSecret: undefined,
    });
    return r;
  });

  if (ctx.printerFailed) {
    result.warnings.push('printer reported a failure; the claim code was issued regardless');
  }
  return result;
}

/** M-04 heartbeat, so the console can show a capture gap (E1). */
export function heartbeat(db: Db, terminalId: string, at = nowIso()): void {
  registry.recordHeartbeat(db, terminalId, at);
}
