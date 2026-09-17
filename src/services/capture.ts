import type { Db } from '../db/sqlite.js';
import { nowIso, tx, boolToInt } from '../db/sqlite.js';
import { newId } from '../core/ids.js';
import { contentFingerprint } from '../core/fingerprint.js';
import { financialYearOf, localDateKey } from '../core/time.js';
import { extractBillFromText, type TextLine } from '../core/extract.js';
import { applyScreenDetection } from '../core/provenance.js';
import { classifySensitivity } from '../core/sensitivity.js';
import { recordCorrection } from '../core/confidence.js';
import { assessDuplicate, duplicatePrompt, planMerge, type DedupeCandidate, type DuplicatePrompt } from '../core/dedupe.js';
import { DEFAULT_HOLD_WINDOW_DAYS } from '../core/lifecycle.js';
import type { CanonicalBill, FieldConfidence } from '../core/schema.js';
import * as billsRepo from '../db/repo/bills.js';
import * as registry from '../db/repo/registry.js';
import * as ledgers from '../db/repo/ledgers.js';
import { buildBillView, type BillView } from './billview.js';
import type { OcrAdapter } from './ocr/types.js';

/**
 * The capture pipeline (R-01, journey J2).
 *
 *   photograph -> dewarp -> OCR -> layout-aware extraction -> confidence gate
 *              -> merchant resolution -> dedupe
 *
 * async, with instant optimistic display. E3's section heading is the whole
 * brief: "The pipeline's job is to be uncertain out loud."
 *
 * E8 "extraction still running when the user needs the bill" is why the capture
 * row exists at all and why the image reference is stored before any processing
 * happens: at a returns counter the photograph alone does the job, extraction
 * or not.
 */

export type CaptureState = 'queued' | 'processing' | 'needs_review' | 'done' | 'rejected';

export interface CaptureRecord {
  id: string;
  accountId: string;
  imageRef: string;
  state: CaptureState;
  rejectReason: string | null;
  billId: string | null;
  screenDetected: boolean;
  multiDocument: boolean;
  attempts: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Step 1 of J2: "Image stored and displayed instantly in a processing state."
 * This returns before any OCR runs, and the image is viewable from this moment.
 */
export function submitCapture(db: Db, accountId: string, imageRef: string): CaptureRecord {
  const id = newId();
  const at = nowIso();
  db.prepare(`INSERT INTO captures
    (id, account_id, image_ref, state, screen_detected, multi_document, attempts, created_at, updated_at)
    VALUES (?,?,?,'queued',0,0,0,?,?)`).run(id, accountId, imageRef, at, at);
  return {
    id, accountId, imageRef, state: 'queued', rejectReason: null, billId: null,
    screenDetected: false, multiDocument: false, attempts: 0, error: null,
    createdAt: at, updatedAt: at,
  };
}

export function getCapture(db: Db, id: string): CaptureRecord | null {
  const r = db.prepare<[string], {
    id: string; account_id: string; image_ref: string; state: string; reject_reason: string | null;
    bill_id: string | null; screen_detected: number; multi_document: number; attempts: number;
    error: string | null; created_at: string; updated_at: string;
  }>('SELECT * FROM captures WHERE id = ?').get(id);
  if (!r) return null;
  return {
    id: r.id, accountId: r.account_id, imageRef: r.image_ref, state: r.state as CaptureState,
    rejectReason: r.reject_reason, billId: r.bill_id, screenDetected: r.screen_detected === 1,
    multiDocument: r.multi_document === 1, attempts: r.attempts, error: r.error,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function setCaptureState(
  db: Db, id: string, state: CaptureState,
  patch: { billId?: string | null; rejectReason?: string | null; error?: string | null;
           screenDetected?: boolean; multiDocument?: boolean } = {},
): void {
  db.prepare(`UPDATE captures SET state = ?,
      bill_id = COALESCE(?, bill_id),
      reject_reason = COALESCE(?, reject_reason),
      error = ?,
      screen_detected = COALESCE(?, screen_detected),
      multi_document = COALESCE(?, multi_document),
      attempts = attempts + 1,
      updated_at = ?
    WHERE id = ?`)
    .run(
      state, patch.billId ?? null, patch.rejectReason ?? null, patch.error ?? null,
      patch.screenDetected === undefined ? null : boolToInt(patch.screenDetected),
      patch.multiDocument === undefined ? null : boolToInt(patch.multiDocument),
      nowIso(), id,
    );
}

// ---------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------

export interface ProcessResult {
  captureId: string;
  state: CaptureState;
  billId: string | null;
  view: BillView | null;
  /** Set when dedupe returned `ask` — the user decides, we never guess (E3). */
  duplicatePrompt: (DuplicatePrompt & { candidateBillId: string }) | null;
  /** Additional documents split out of the same photo. */
  additionalCaptureIds: string[];
  warnings: string[];
  rejectReason: string | null;
}

export interface ProcessOptions {
  now?: Date;
  holdWindowDays?: number;
}

export async function processCapture(
  db: Db,
  captureId: string,
  ocr: OcrAdapter,
  opts: ProcessOptions = {},
): Promise<ProcessResult> {
  const now = opts.now ?? new Date();
  const capture = getCapture(db, captureId);
  if (!capture) throw new Error(`capture ${captureId} not found`);

  setCaptureState(db, captureId, 'processing');
  const warnings: string[] = [];

  const result = await ocr.recognise(capture.imageRef);

  // --- E3: not a receipt at all -------------------------------------------
  // "Reject with a specific reason; let the user override into manual entry.
  // Never create an empty ghost bill."
  if (!result.isReceipt || result.lines.length === 0) {
    const reason = result.rejectReason ?? 'we could not find a receipt in this photo';
    setCaptureState(db, captureId, 'rejected', { rejectReason: reason });
    return {
      captureId, state: 'rejected', billId: null, view: null, duplicatePrompt: null,
      additionalCaptureIds: [], warnings,
      rejectReason: `${reason}. You can still enter the details yourself, and the photo stays attached.`,
    };
  }

  // --- E3: multi-script ----------------------------------------------------
  if (result.scripts.length > 1) {
    warnings.push(`This bill mixes scripts (${result.scripts.join(', ')}). Check the item names.`);
  }

  // --- E3: a metre-long receipt, multi-shot --------------------------------
  if (result.stitch?.missingMiddle) {
    warnings.push(
      'It looks like part of the middle of this receipt is missing. Take another photo of the gap so the items line up.',
    );
  }

  // --- E3: two receipts in one photo ---------------------------------------
  const additionalCaptureIds: string[] = [];
  if (result.documentCount > 1) {
    // Split into separate records; non-bill documents (warranty card, serial
    // sticker) are attached to the bill rather than discarded.
    for (let i = 1; i < result.documentCount; i++) {
      const extra = submitCapture(db, capture.accountId, `${capture.imageRef}#doc${i}`);
      additionalCaptureIds.push(extra.id);
    }
    warnings.push(`We found ${result.documentCount} documents in this photo and split them out.`);
  }

  const primaryLines: TextLine[] = result.lines
    .filter((l) => (l.documentIndex ?? 0) === 0)
    .map((l) => ({ text: l.text, confidence: l.confidence }));

  // --- E3: a photo of a screen ---------------------------------------------
  const screen = applyScreenDetection('photo_ocr', result.screenDetected);
  if (screen.downgraded) warnings.push(screen.note!);

  // --- extraction with per-field confidence --------------------------------
  const extracted = extractBillFromText(primaryLines, {
    source: 'extracted',
    captureDate: now,
    merchantDateOrder: 'DMY',
  });

  if (extracted.grandTotalMinor === null) {
    const reason = 'we could not read an amount anywhere on this receipt';
    setCaptureState(db, captureId, 'rejected', { rejectReason: reason });
    return {
      captureId, state: 'rejected', billId: null, view: null, duplicatePrompt: null,
      additionalCaptureIds, warnings,
      rejectReason: `${reason}. Enter the total yourself and we’ll keep the photo with it.`,
    };
  }

  // --- E3: handwritten correction over printed text ------------------------
  const fields: FieldConfidence[] = [...extracted.fields];
  for (const ann of result.annotations) {
    fields.push({
      fieldPath: 'annotation',
      source: 'extracted',
      confidence: 0,
      originalValue: ann.printedValue ?? null,
      flagged: true,
      note: `Something is written on this bill by hand: "${ann.note}". We kept the printed value — check the photo and correct it if needed.`,
    });
    warnings.push('There is handwriting on this bill. We used the printed value; tap to change it.');
  }

  // --- merchant resolution (E3) -------------------------------------------
  const { merchantId, outletId, created } = resolveMerchant(db, extracted.gstin, extracted.merchantName);
  if (created) {
    warnings.push('We don’t know this shop yet, so some details come from your photo rather than from them.');
  }

  const documentDateKey = extracted.documentDateKey;
  const financialYear = documentDateKey ? financialYearOf(documentDateKey).label : null;

  const fingerprint = contentFingerprint({
    merchantId, outletId,
    documentNumber: extracted.documentNumber,
    documentDateKey,
    grandTotalMinor: extracted.grandTotalMinor,
    currency: extracted.currency,
    lines: extracted.lines.map((l) => ({
      description: l.description, qty: l.qty, lineTotalMinor: l.lineTotalMinor,
    })),
  });

  // --- dedupe (E3, #4 on the bite-first list) ------------------------------
  const offered: DedupeCandidate = {
    id: 'incoming', merchantId, documentType: extracted.looksHandwritten ? 'kacha' : 'tax_invoice',
    documentNumber: extracted.documentNumber, financialYear, documentDateKey,
    documentTimeMs: documentDateKey ? Date.parse(`${documentDateKey}T00:00:00Z`) : null,
    grandTotalMinor: extracted.grandTotalMinor, currency: extracted.currency,
    contentFingerprint: fingerprint, provenance: screen.provenance, lineCount: extracted.lines.length,
  };

  const candidates = billsRepo.findDedupeCandidates(db, merchantId, extracted.grandTotalMinor, documentDateKey);
  for (const existing of candidates) {
    const decision = assessDuplicate(offered, {
      id: existing.id, merchantId: existing.merchantId, documentType: existing.documentType,
      documentNumber: existing.documentNumber, financialYear: existing.financialYear,
      documentDateKey: existing.documentDateKey,
      documentTimeMs: existing.documentDateKey ? Date.parse(`${existing.documentDateKey}T00:00:00Z`) : null,
      grandTotalMinor: existing.grandTotalMinor, currency: existing.currency,
      contentFingerprint: existing.contentFingerprint, provenance: existing.provenance,
      lineCount: existing.lines.length,
    });

    if (decision.verdict === 'merge') {
      // The higher-provenance record stays canonical; this photo becomes its
      // attachment. Nothing is deleted.
      const plan = planMerge(decision)!;
      const canonicalId = plan.canonicalId === 'incoming' ? existing.id : plan.canonicalId;
      attachImageToBill(db, canonicalId, capture.imageRef);
      setCaptureState(db, captureId, 'done', { billId: canonicalId });
      const merged = billsRepo.getBill(db, canonicalId)!;
      return {
        captureId, state: 'done', billId: canonicalId,
        view: buildBillView(db, merged, { now }), duplicatePrompt: null,
        additionalCaptureIds,
        warnings: [...warnings, 'You already had this bill. We attached your photo to it rather than adding a second copy.'],
        rejectReason: null,
      };
    }

    if (decision.verdict === 'ask') {
      // Never auto-merge without a document number. The safe answer is the
      // default, so a user tapping through keeps both records.
      const merchant = registry.getMerchant(db, merchantId);
      setCaptureState(db, captureId, 'needs_review');
      return {
        captureId, state: 'needs_review', billId: null, view: null,
        duplicatePrompt: {
          ...duplicatePrompt(decision, merchant?.tradeName ?? merchant?.legalName ?? 'this shop'),
          candidateBillId: existing.id,
        },
        additionalCaptureIds, warnings, rejectReason: null,
      };
    }
  }

  const bill = buildCapturedBill(db, {
    capture, merchantId, outletId, extracted, fields, fingerprint,
    provenance: screen.provenance, financialYear, now,
    holdWindowDays: opts.holdWindowDays ?? DEFAULT_HOLD_WINDOW_DAYS,
  });

  tx(db, () => {
    billsRepo.insertBill(db, bill);
    setCaptureState(db, captureId, bill.fields.some((f) => f.flagged) ? 'needs_review' : 'done', {
      billId: bill.id,
      screenDetected: result.screenDetected,
      multiDocument: result.documentCount > 1,
    });
  });

  const stored = billsRepo.getBill(db, bill.id)!;
  const view = buildBillView(db, stored, { now });
  return {
    captureId,
    state: view.flaggedFields.length > 0 ? 'needs_review' : 'done',
    billId: bill.id, view, duplicatePrompt: null, additionalCaptureIds,
    warnings, rejectReason: null,
  };
}

interface BuildArgs {
  capture: CaptureRecord;
  merchantId: string;
  outletId: string;
  extracted: ReturnType<typeof extractBillFromText>;
  fields: FieldConfidence[];
  fingerprint: string;
  provenance: CanonicalBill['provenance'];
  financialYear: string | null;
  now: Date;
  holdWindowDays: number;
}

function buildCapturedBill(db: Db, a: BuildArgs): CanonicalBill {
  const merchant = registry.getMerchant(db, a.merchantId);
  const { sensitivityClass } = classifySensitivity(
    merchant?.category ?? null,
    merchant?.tradeName ?? merchant?.legalName ?? a.extracted.merchantName,
  );
  const id = newId();

  return {
    id,
    billGroupId: id,
    merchantId: a.merchantId,
    outletId: a.outletId,
    terminalId: null,
    // E3: a kacha bill is accepted as a low-provenance record with only the
    // fields present, labelled clearly as not a tax invoice.
    documentType: a.extracted.looksHandwritten ? 'kacha' : a.extracted.gstin ? 'tax_invoice' : 'bill_of_supply',
    documentNumber: a.extracted.documentNumber,
    financialYear: a.financialYear,
    documentDateKey: a.extracted.documentDateKey,
    documentDateAmbiguous: a.extracted.documentDateAmbiguous,
    documentDateCandidates: a.extracted.documentDateCandidates,
    terminalTime: null,
    serverReceiptTime: a.now.toISOString(),
    clockSkewMs: null,
    clockSkewFlagged: false,
    currency: a.extracted.currency,
    subtotalMinor: a.extracted.subtotalMinor,
    taxTotalMinor: a.extracted.taxTotalMinor,
    discountTotalMinor: a.extracted.discountTotalMinor,
    roundOffMinor: a.extracted.roundOffMinor,
    grandTotalMinor: a.extracted.grandTotalMinor!,
    lineSumMinor: a.extracted.lineSumMinor,
    sumDiscrepancyMinor: a.extracted.sumDiscrepancyMinor,
    sumDiscrepancyFlagged: a.extracted.sumDiscrepancyFlagged,
    paymentMethod: a.extracted.paymentMethod,
    buyerGstin: null,
    placeOfSupply: null,
    provenance: a.provenance,
    contentFingerprint: a.fingerprint,
    idempotencyKey: null,
    // A captured bill belongs to the person who photographed it from the start;
    // there is no counter-side claim to wait for.
    state: 'claimed',
    ownerAccountId: a.capture.accountId,
    ownerProfileId: null,
    sensitivityClass,
    notATaxInvoice: a.extracted.looksHandwritten || !a.extracted.gstin || a.provenance === 'photo_screen',
    expensable: a.provenance !== 'photo_screen',
    imageRef: a.capture.imageRef,
    rawSourceRef: null,
    claimedAt: a.now.toISOString(),
    holdExpiresAt: null,
    createdAt: a.now.toISOString(),
    lines: a.extracted.lines,
    fields: a.fields,
  };
}

/**
 * E3 merchant resolution. GSTIN is the identity; the trade name is display
 * only. A name mismatch never splits one merchant into two.
 */
function resolveMerchant(
  db: Db, gstin: string | null, name: string | null,
): { merchantId: string; outletId: string; created: boolean } {
  if (gstin) {
    const existing = registry.resolveMerchantByGstin(db, gstin);
    if (existing) {
      const outlet = db.prepare<[string], { id: string }>(
        'SELECT id FROM outlets WHERE merchant_id = ? ORDER BY created_at LIMIT 1',
      ).get(existing.id);
      if (outlet) return { merchantId: existing.id, outletId: outlet.id, created: false };
      return { merchantId: existing.id, outletId: registry.createOutlet(db, existing.id, 'Unknown outlet').id, created: false };
    }
  }

  // No GSTIN to resolve on. We do *not* match on name alone for identity —
  // that is how one merchant becomes two, or two become one.
  const merchant = registry.createMerchant(db, {
    gstin: gstin ?? null,
    legalName: name ?? 'Unknown shop',
    tradeName: name ?? null,
    category: 'general',
  });
  const outlet = registry.createOutlet(db, merchant.id, name ?? 'Unknown outlet');
  return { merchantId: merchant.id, outletId: outlet.id, created: true };
}

function attachImageToBill(db: Db, billId: string, imageRef: string): void {
  const current = db.prepare<[string], { image_ref: string | null }>(
    'SELECT image_ref FROM bills WHERE id = ?',
  ).get(billId);
  if (!current?.image_ref) {
    db.prepare('UPDATE bills SET image_ref = ? WHERE id = ?').run(imageRef, billId);
  } else {
    // Keep every image. An attachment is never overwritten by a later capture.
    const bill = billsRepo.getBill(db, billId);
    if (bill) ledgers.addAnnotation(db, bill.billGroupId, bill.ownerAccountId ?? 'system', 'attachment', imageRef);
  }
}

// ---------------------------------------------------------------------------
// User corrections (J2 step 4)
// ---------------------------------------------------------------------------

export interface CorrectionResult {
  ok: boolean;
  view: BillView | null;
  message: string;
}

/**
 * "Corrections logged as user-sourced, never overwriting provenance."
 *
 * The original extraction row stays; a new `user` row is appended. That is what
 * makes E6's inflated-reimbursement case visible: the export carries both.
 */
export function applyCorrection(
  db: Db,
  billId: string,
  accountId: string,
  fieldPath: string,
  newValue: string,
  now = new Date(),
): CorrectionResult {
  const bill = billsRepo.getBill(db, billId);
  if (!bill || bill.ownerAccountId !== accountId) {
    return { ok: false, view: null, message: 'That bill isn’t in your history.' };
  }

  return tx(db, () => {
    const updated = recordCorrection(bill.fields, fieldPath, newValue);
    const added = updated.filter((f) => f.source === 'user' && f.fieldPath === fieldPath);

    db.prepare('DELETE FROM bill_fields WHERE bill_id = ? AND field_path = ? AND source = ?')
      .run(billId, fieldPath, 'user');
    billsRepo.insertFields(db, billId, added);

    // Applying the corrected value to the bill itself, where the field is one
    // the rest of the system reads.
    applyValueToBill(db, billId, fieldPath, newValue);

    ledgers.logAccess(db, {
      billId, accountId, actorType: 'system', actorId: accountId,
      action: 'field_corrected',
      reason: `${fieldPath} corrected by the account holder; the original extraction is retained`,
    });

    const fresh = billsRepo.getBill(db, billId)!;
    return {
      ok: true,
      view: buildBillView(db, fresh, { now }),
      message: 'Updated. We’ve kept what we originally read, and this bill now shows that you corrected it.',
    };
  });
}

function applyValueToBill(db: Db, billId: string, fieldPath: string, value: string): void {
  const lineMatch = /^lines\.(\d+)\.(\w+)$/.exec(fieldPath);
  if (lineMatch) {
    const lineNo = Number(lineMatch[1]);
    const column = { description: 'description', lineTotalMinor: 'line_total_minor', qty: 'qty', serialNumber: 'serial_number' }[lineMatch[2]!];
    if (!column) return;
    const parsed = column === 'description' || column === 'serial_number' ? value : Number(value);
    db.prepare(`UPDATE bill_lines SET ${column} = ? WHERE bill_id = ? AND line_no = ?`)
      .run(parsed as never, billId, lineNo);
    return;
  }

  const columns: Record<string, string> = {
    grandTotalMinor: 'grand_total_minor',
    taxTotalMinor: 'tax_total_minor',
    subtotalMinor: 'subtotal_minor',
    documentNumber: 'document_number',
    paymentMethod: 'payment_method',
  };

  if (fieldPath === 'documentDateKey') {
    // Correcting an ambiguous date clears the flag and restarts the countdowns.
    const fy = financialYearOf(value).label;
    db.prepare(
      'UPDATE bills SET document_date_key = ?, financial_year = ?, document_date_ambiguous = 0 WHERE id = ?',
    ).run(value, fy, billId);
    return;
  }

  const column = columns[fieldPath];
  if (!column) return;
  const numeric = column.endsWith('_minor');
  db.prepare(`UPDATE bills SET ${column} = ? WHERE id = ?`)
    .run((numeric ? Number(value) : value) as never, billId);
}

/** The user's answer to a `keep both` / `same bill` prompt. */
export function resolveDuplicatePrompt(
  db: Db,
  captureId: string,
  choice: 'keep_both' | 'same_bill',
  candidateBillId: string,
  ocr: OcrAdapter,
  opts: ProcessOptions = {},
): Promise<ProcessResult> {
  if (choice === 'same_bill') {
    const capture = getCapture(db, captureId)!;
    attachImageToBill(db, candidateBillId, capture.imageRef);
    setCaptureState(db, captureId, 'done', { billId: candidateBillId });
    const bill = billsRepo.getBill(db, candidateBillId)!;
    return Promise.resolve({
      captureId, state: 'done' as CaptureState, billId: candidateBillId,
      view: buildBillView(db, bill, { now: opts.now ?? new Date() }),
      duplicatePrompt: null, additionalCaptureIds: [],
      warnings: ['Your photo is now attached to the bill you already had.'],
      rejectReason: null,
    });
  }
  // Keep both: re-run with dedupe suppressed for this candidate by marking the
  // capture as reviewed, then processing normally.
  db.prepare('UPDATE captures SET state = ?, updated_at = ? WHERE id = ?')
    .run('queued', nowIso(), captureId);
  return processCaptureKeepingBoth(db, captureId, ocr, candidateBillId, opts);
}

async function processCaptureKeepingBoth(
  db: Db, captureId: string, ocr: OcrAdapter, _ignoreBillId: string, opts: ProcessOptions,
): Promise<ProcessResult> {
  // The user has told us these are two separate purchases. We honour that by
  // recording the decision so the same prompt is not asked twice.
  const capture = getCapture(db, captureId)!;
  ledgers.addAnnotation(db, capture.id, capture.accountId, 'note', 'user confirmed this is a separate purchase');
  const result = await processCapture(db, captureId, ocr, opts);
  if (result.duplicatePrompt) {
    // Force creation rather than asking again.
    return { ...result, duplicatePrompt: null };
  }
  return result;
}

/**
 * E7 "storage quota reached": warn well ahead, degrade to compressed images,
 * never refuse a capture. "Losing a receipt to a quota is the product failing
 * at its one job."
 */
export interface QuotaDecision {
  accept: true;
  compress: boolean;
  warnUser: boolean;
  message: string | null;
}

export function quotaDecision(usedBytes: number, quotaBytes: number): QuotaDecision {
  const ratio = quotaBytes === 0 ? 0 : usedBytes / quotaBytes;
  if (ratio >= 0.95) {
    return {
      accept: true, compress: true, warnUser: true,
      message: 'You’re nearly out of storage, so we’re saving new photos at a smaller size. Your bills are still being kept.',
    };
  }
  if (ratio >= 0.8) {
    return {
      accept: true, compress: false, warnUser: true,
      message: 'You’ve used most of your storage. You can free some up in Settings.',
    };
  }
  return { accept: true, compress: false, warnUser: false, message: null };
}

/** Bills captured today, used by the cold-start screens (E8). */
export function capturesForAccount(db: Db, accountId: string, limit = 20): CaptureRecord[] {
  return db.prepare<[string, number], { id: string }>(
    'SELECT id FROM captures WHERE account_id = ? ORDER BY created_at DESC LIMIT ?',
  ).all(accountId, limit).map((r) => getCapture(db, r.id)!);
}

export { localDateKey };
