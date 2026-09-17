import type { Db } from '../sqlite.js';
import { boolToInt, intToBool, nowIso } from '../sqlite.js';
import type {
  BillLine, BillState, CanonicalBill, DocumentType, FieldConfidence, Provenance, SensitivityClass,
} from '../../core/schema.js';
import { localDateKey } from '../../core/time.js';
import { rankScore, type ParsedQuery } from '../../core/search.js';

interface BillRow {
  id: string; bill_group_id: string; merchant_id: string; outlet_id: string;
  terminal_id: string | null; document_type: string; document_number: string | null;
  financial_year: string | null; document_date_key: string | null;
  document_date_ambiguous: number; document_date_candidates: string;
  terminal_time: string | null; server_receipt_time: string;
  clock_skew_ms: number | null; clock_skew_flagged: number; currency: string;
  subtotal_minor: number | null; tax_total_minor: number | null;
  discount_total_minor: number | null; round_off_minor: number | null;
  grand_total_minor: number; line_sum_minor: number | null;
  sum_discrepancy_minor: number | null; sum_discrepancy_flagged: number;
  payment_method: string | null; buyer_gstin: string | null; place_of_supply: string | null;
  provenance: string; content_fingerprint: string; idempotency_key: string | null;
  state: string; owner_account_id: string | null; owner_profile_id: string | null;
  sensitivity_class: string; not_a_tax_invoice: number; expensable: number;
  image_ref: string | null; raw_source_ref: string | null; claimed_at: string | null;
  hold_expires_at: string | null; created_at: string;
}

interface LineRow {
  bill_id: string; line_no: number; description: string; hsn_sac: string | null;
  qty: number; uom: string | null; unit_price_minor: number | null; gst_rate_bp: number | null;
  taxable_value_minor: number | null; cgst_minor: number | null; sgst_minor: number | null;
  igst_minor: number | null; cess_minor: number | null; discount_minor: number | null;
  line_total_minor: number; serial_number: string | null; warranty_months: number | null;
  returned_qty: number;
}

interface FieldRow {
  field_path: string; source: string; confidence: number | null;
  original_value: string | null; flagged: number; note: string | null;
}

function toLine(r: LineRow): BillLine {
  return {
    lineNo: r.line_no, description: r.description, hsnSac: r.hsn_sac, qty: r.qty,
    uom: r.uom, unitPriceMinor: r.unit_price_minor, gstRateBp: r.gst_rate_bp,
    taxableValueMinor: r.taxable_value_minor, cgstMinor: r.cgst_minor, sgstMinor: r.sgst_minor,
    igstMinor: r.igst_minor, cessMinor: r.cess_minor, discountMinor: r.discount_minor,
    lineTotalMinor: r.line_total_minor, serialNumber: r.serial_number,
    warrantyMonths: r.warranty_months, returnedQty: r.returned_qty,
  };
}

function toField(r: FieldRow): FieldConfidence {
  return {
    fieldPath: r.field_path, source: r.source as FieldConfidence['source'],
    confidence: r.confidence, originalValue: r.original_value,
    flagged: intToBool(r.flagged), note: r.note,
  };
}

function toBill(r: BillRow, lines: BillLine[], fields: FieldConfidence[]): CanonicalBill {
  return {
    id: r.id, billGroupId: r.bill_group_id, merchantId: r.merchant_id, outletId: r.outlet_id,
    terminalId: r.terminal_id, documentType: r.document_type as DocumentType,
    documentNumber: r.document_number, financialYear: r.financial_year,
    documentDateKey: r.document_date_key,
    documentDateAmbiguous: intToBool(r.document_date_ambiguous),
    documentDateCandidates: JSON.parse(r.document_date_candidates) as string[],
    terminalTime: r.terminal_time, serverReceiptTime: r.server_receipt_time,
    clockSkewMs: r.clock_skew_ms, clockSkewFlagged: intToBool(r.clock_skew_flagged),
    currency: r.currency, subtotalMinor: r.subtotal_minor, taxTotalMinor: r.tax_total_minor,
    discountTotalMinor: r.discount_total_minor, roundOffMinor: r.round_off_minor,
    grandTotalMinor: r.grand_total_minor, lineSumMinor: r.line_sum_minor,
    sumDiscrepancyMinor: r.sum_discrepancy_minor,
    sumDiscrepancyFlagged: intToBool(r.sum_discrepancy_flagged),
    paymentMethod: r.payment_method, buyerGstin: r.buyer_gstin, placeOfSupply: r.place_of_supply,
    provenance: r.provenance as Provenance, contentFingerprint: r.content_fingerprint,
    idempotencyKey: r.idempotency_key, state: r.state as BillState,
    ownerAccountId: r.owner_account_id, ownerProfileId: r.owner_profile_id,
    sensitivityClass: r.sensitivity_class as SensitivityClass,
    notATaxInvoice: intToBool(r.not_a_tax_invoice), expensable: intToBool(r.expensable),
    imageRef: r.image_ref, rawSourceRef: r.raw_source_ref, claimedAt: r.claimed_at,
    holdExpiresAt: r.hold_expires_at, createdAt: r.created_at, lines, fields,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export function insertBill(db: Db, bill: CanonicalBill): void {
  db.prepare(`INSERT INTO bills (
    id, bill_group_id, merchant_id, outlet_id, terminal_id, document_type, document_number,
    financial_year, document_date_key, document_date_ambiguous, document_date_candidates,
    terminal_time, server_receipt_time, clock_skew_ms, clock_skew_flagged, currency,
    subtotal_minor, tax_total_minor, discount_total_minor, round_off_minor, grand_total_minor,
    line_sum_minor, sum_discrepancy_minor, sum_discrepancy_flagged, payment_method, buyer_gstin,
    place_of_supply, provenance, content_fingerprint, idempotency_key, state, owner_account_id,
    owner_profile_id, sensitivity_class, not_a_tax_invoice, expensable, image_ref, raw_source_ref,
    claimed_at, hold_expires_at, created_at
  ) VALUES (
    @id, @bill_group_id, @merchant_id, @outlet_id, @terminal_id, @document_type, @document_number,
    @financial_year, @document_date_key, @document_date_ambiguous, @document_date_candidates,
    @terminal_time, @server_receipt_time, @clock_skew_ms, @clock_skew_flagged, @currency,
    @subtotal_minor, @tax_total_minor, @discount_total_minor, @round_off_minor, @grand_total_minor,
    @line_sum_minor, @sum_discrepancy_minor, @sum_discrepancy_flagged, @payment_method, @buyer_gstin,
    @place_of_supply, @provenance, @content_fingerprint, @idempotency_key, @state, @owner_account_id,
    @owner_profile_id, @sensitivity_class, @not_a_tax_invoice, @expensable, @image_ref, @raw_source_ref,
    @claimed_at, @hold_expires_at, @created_at
  )`).run({
    id: bill.id, bill_group_id: bill.billGroupId, merchant_id: bill.merchantId,
    outlet_id: bill.outletId, terminal_id: bill.terminalId, document_type: bill.documentType,
    document_number: bill.documentNumber, financial_year: bill.financialYear,
    document_date_key: bill.documentDateKey,
    document_date_ambiguous: boolToInt(bill.documentDateAmbiguous),
    document_date_candidates: JSON.stringify(bill.documentDateCandidates),
    terminal_time: bill.terminalTime, server_receipt_time: bill.serverReceiptTime,
    clock_skew_ms: bill.clockSkewMs, clock_skew_flagged: boolToInt(bill.clockSkewFlagged),
    currency: bill.currency, subtotal_minor: bill.subtotalMinor, tax_total_minor: bill.taxTotalMinor,
    discount_total_minor: bill.discountTotalMinor, round_off_minor: bill.roundOffMinor,
    grand_total_minor: bill.grandTotalMinor, line_sum_minor: bill.lineSumMinor,
    sum_discrepancy_minor: bill.sumDiscrepancyMinor,
    sum_discrepancy_flagged: boolToInt(bill.sumDiscrepancyFlagged),
    payment_method: bill.paymentMethod, buyer_gstin: bill.buyerGstin,
    place_of_supply: bill.placeOfSupply, provenance: bill.provenance,
    content_fingerprint: bill.contentFingerprint, idempotency_key: bill.idempotencyKey,
    state: bill.state, owner_account_id: bill.ownerAccountId, owner_profile_id: bill.ownerProfileId,
    sensitivity_class: bill.sensitivityClass, not_a_tax_invoice: boolToInt(bill.notATaxInvoice),
    expensable: boolToInt(bill.expensable), image_ref: bill.imageRef,
    raw_source_ref: bill.rawSourceRef, claimed_at: bill.claimedAt,
    hold_expires_at: bill.holdExpiresAt, created_at: bill.createdAt,
  });

  const insLine = db.prepare(`INSERT INTO bill_lines (
    bill_id, line_no, description, hsn_sac, qty, uom, unit_price_minor, gst_rate_bp,
    taxable_value_minor, cgst_minor, sgst_minor, igst_minor, cess_minor, discount_minor,
    line_total_minor, serial_number, warranty_months, returned_qty
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const l of bill.lines) {
    insLine.run(
      bill.id, l.lineNo, l.description, l.hsnSac, l.qty, l.uom, l.unitPriceMinor, l.gstRateBp,
      l.taxableValueMinor, l.cgstMinor, l.sgstMinor, l.igstMinor, l.cessMinor, l.discountMinor,
      l.lineTotalMinor, l.serialNumber, l.warrantyMonths, l.returnedQty,
    );
  }

  insertFields(db, bill.id, bill.fields);
  indexBill(db, bill);
}

export function insertFields(db: Db, billId: string, fields: FieldConfidence[]): void {
  const ins = db.prepare(`INSERT INTO bill_fields
    (bill_id, field_path, source, confidence, original_value, flagged, note, created_at)
    VALUES (?,?,?,?,?,?,?,?)`);
  const at = nowIso();
  for (const f of fields) {
    ins.run(billId, f.fieldPath, f.source, f.confidence, f.originalValue, boolToInt(f.flagged), f.note, at);
  }
}

/** FTS rows are rebuilt rather than patched — bills change only via amendment. */
export function indexBill(db: Db, bill: CanonicalBill, merchantText?: string): void {
  db.prepare('DELETE FROM bills_fts WHERE bill_id = ?').run(bill.id);
  const merchant = merchantText ?? db.prepare<[string], { legal_name: string; trade_name: string | null }>(
    'SELECT legal_name, trade_name FROM merchants WHERE id = ?',
  ).get(bill.merchantId);
  const mText = typeof merchant === 'string'
    ? merchant
    : merchant
      ? [merchant.legal_name, merchant.trade_name].filter(Boolean).join(' ')
      : '';
  db.prepare('INSERT INTO bills_fts (bill_id, merchant_text, item_text, document_number) VALUES (?,?,?,?)')
    .run(bill.id, mText, bill.lines.map((l) => l.description).join(' • '), bill.documentNumber ?? '');
}

export function updateBillState(
  db: Db,
  id: string,
  state: BillState,
  patch: Partial<Pick<CanonicalBill, 'ownerAccountId' | 'ownerProfileId' | 'claimedAt' | 'holdExpiresAt' | 'expensable'>> = {},
): void {
  db.prepare(`UPDATE bills SET
      state = ?,
      owner_account_id = COALESCE(?, owner_account_id),
      owner_profile_id = COALESCE(?, owner_profile_id),
      claimed_at = COALESCE(?, claimed_at),
      hold_expires_at = COALESCE(?, hold_expires_at),
      expensable = COALESCE(?, expensable)
    WHERE id = ?`)
    .run(
      state,
      patch.ownerAccountId ?? null,
      patch.ownerProfileId ?? null,
      patch.claimedAt ?? null,
      patch.holdExpiresAt ?? null,
      patch.expensable === undefined ? null : boolToInt(patch.expensable),
      id,
    );
}

/** C-04 reassignment. Ownership stays within the account; only the profile moves. */
export function reassignProfile(db: Db, billId: string, profileId: string): void {
  db.prepare('UPDATE bills SET owner_profile_id = ? WHERE id = ?').run(profileId, billId);
}

export function setReturnedQty(db: Db, billId: string, lineNo: number, qty: number): void {
  db.prepare('UPDATE bill_lines SET returned_qty = ? WHERE bill_id = ? AND line_no = ?')
    .run(qty, billId, lineNo);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function getBill(db: Db, id: string): CanonicalBill | null {
  const row = db.prepare<[string], BillRow>('SELECT * FROM bills WHERE id = ?').get(id);
  if (!row) return null;
  return hydrate(db, row);
}

function hydrate(db: Db, row: BillRow): CanonicalBill {
  const lines = db.prepare<[string], LineRow>(
    'SELECT * FROM bill_lines WHERE bill_id = ? ORDER BY line_no',
  ).all(row.id).map(toLine);
  const fields = db.prepare<[string], FieldRow>(
    'SELECT field_path, source, confidence, original_value, flagged, note FROM bill_fields WHERE bill_id = ? ORDER BY id',
  ).all(row.id).map(toField);
  return toBill(row, lines, fields);
}

export function findByFingerprint(
  db: Db, merchantId: string, fingerprint: string,
): CanonicalBill | null {
  const row = db.prepare<[string, string], BillRow>(
    'SELECT * FROM bills WHERE merchant_id = ? AND content_fingerprint = ? ORDER BY created_at LIMIT 1',
  ).get(merchantId, fingerprint);
  return row ? hydrate(db, row) : null;
}

export function findByDocumentNumber(
  db: Db, merchantId: string, financialYear: string | null, documentNumber: string,
): CanonicalBill[] {
  const rows = financialYear
    ? db.prepare<[string, string, string], BillRow>(
        'SELECT * FROM bills WHERE merchant_id = ? AND financial_year = ? AND document_number = ?',
      ).all(merchantId, financialYear, documentNumber)
    : db.prepare<[string, string], BillRow>(
        'SELECT * FROM bills WHERE merchant_id = ? AND document_number = ?',
      ).all(merchantId, documentNumber);
  return rows.map((r) => hydrate(db, r));
}

/** Candidates for dedupe against a newly captured photo (E3). */
export function findDedupeCandidates(
  db: Db, merchantId: string, grandTotalMinor: number, documentDateKey: string | null,
): CanonicalBill[] {
  const rows = documentDateKey
    ? db.prepare<[string, number, string], BillRow>(
        `SELECT * FROM bills WHERE merchant_id = ? AND grand_total_minor = ?
         AND document_date_key = ? AND state != 'purged' LIMIT 20`,
      ).all(merchantId, grandTotalMinor, documentDateKey)
    : db.prepare<[string, number], BillRow>(
        `SELECT * FROM bills WHERE merchant_id = ? AND grand_total_minor = ?
         AND state != 'purged' ORDER BY created_at DESC LIMIT 20`,
      ).all(merchantId, grandTotalMinor);
  return rows.map((r) => hydrate(db, r));
}

export interface ListOptions {
  limit?: number;
  offset?: number;
  profileId?: string | null;
  includeSensitive?: boolean;
}

export function listByOwner(db: Db, accountId: string, opts: ListOptions = {}): CanonicalBill[] {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const clauses = ['owner_account_id = ?', "state != 'purged'"];
  const params: unknown[] = [accountId];
  if (opts.profileId) { clauses.push('owner_profile_id = ?'); params.push(opts.profileId); }
  if (opts.includeSensitive === false) { clauses.push("sensitivity_class = 'standard'"); }
  params.push(limit, offset);

  const rows = db.prepare<unknown[], BillRow>(
    `SELECT * FROM bills WHERE ${clauses.join(' AND ')}
     ORDER BY COALESCE(document_date_key, substr(server_receipt_time,1,10)) DESC, created_at DESC
     LIMIT ? OFFSET ?`,
  ).all(...params);
  return rows.map((r) => hydrate(db, r));
}

export function countByOwner(db: Db, accountId: string): number {
  return db.prepare<[string], { n: number }>(
    "SELECT COUNT(*) AS n FROM bills WHERE owner_account_id = ? AND state != 'purged'",
  ).get(accountId)!.n;
}

// ---------------------------------------------------------------------------
// Search (R-02)
// ---------------------------------------------------------------------------

export interface SearchHit {
  bill: CanonicalBill;
  score: number;
  itemMatch: boolean;
  merchantMatch: boolean;
}

/** FTS5 needs its own escaping; a bare apostrophe or hyphen is a syntax error. */
function toFtsQuery(terms: string[]): string {
  return terms
    .map((t) => t.replace(/["]/g, ''))
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"*`)
    .join(' OR ');
}

export function searchBills(
  db: Db,
  accountId: string,
  q: ParsedQuery,
  opts: { limit?: number; now?: Date; includeSensitive?: boolean } = {},
): SearchHit[] {
  const limit = opts.limit ?? 25;
  const todayKey = localDateKey(opts.now ?? new Date());

  const where = ['b.owner_account_id = ?', "b.state != 'purged'"];
  const params: unknown[] = [accountId];

  if (q.amount) {
    where.push('b.grand_total_minor BETWEEN ? AND ?');
    params.push(q.amount.minMinor, q.amount.maxMinor);
  }
  if (q.dates) {
    where.push('b.document_date_key BETWEEN ? AND ?');
    params.push(q.dates.fromKey, q.dates.toKey);
  }
  if (q.paymentMethodHint) {
    where.push('b.payment_method LIKE ?');
    params.push(`${q.paymentMethodHint}%`);
  }
  if (opts.includeSensitive === false) where.push("b.sensitivity_class = 'standard'");

  let rows: Array<BillRow & { rank_score: number | null; item_text: string; merchant_text: string }>;

  if (q.terms.length > 0) {
    const fts = toFtsQuery(q.terms);
    rows = db.prepare<unknown[], BillRow & { rank_score: number | null; item_text: string; merchant_text: string }>(
      `SELECT b.*, bm25(bills_fts, 1.0, 4.0, 2.0) AS rank_score, f.item_text, f.merchant_text
         FROM bills_fts f
         JOIN bills b ON b.id = f.bill_id
        WHERE bills_fts MATCH ? AND ${where.join(' AND ')}
        LIMIT 500`,
    ).all(fts, ...params);
  } else {
    // A filter-only query (amount range, month) is a legitimate search: the
    // person remembers the month and roughly the amount but not the item.
    rows = db.prepare<unknown[], BillRow & { rank_score: number | null; item_text: string; merchant_text: string }>(
      `SELECT b.*, NULL AS rank_score, COALESCE(f.item_text,'') AS item_text,
              COALESCE(f.merchant_text,'') AS merchant_text
         FROM bills b LEFT JOIN bills_fts f ON f.bill_id = b.id
        WHERE ${where.join(' AND ')}
        ORDER BY COALESCE(b.document_date_key, substr(b.server_receipt_time,1,10)) DESC
        LIMIT 500`,
    ).all(...params);
  }

  // bm25 returns a negative score where more negative is better; map to 0..1.
  const best = rows.reduce((m, r) => Math.min(m, r.rank_score ?? 0), 0);
  const lowered = q.terms.map((t) => t.toLowerCase());

  const hits = rows.map((r) => {
    const itemMatch = lowered.some((t) => r.item_text.toLowerCase().includes(t));
    const merchantMatch = lowered.some((t) => r.merchant_text.toLowerCase().includes(t));
    const textScore = r.rank_score === null || best === 0 ? 0 : r.rank_score / best;
    return {
      row: r,
      itemMatch,
      merchantMatch,
      score: rankScore(
        {
          textScore: Math.max(0, Math.min(1, textScore)),
          itemMatch,
          merchantMatch,
          documentDateKey: r.document_date_key,
          amountInRange: q.amount !== null,
        },
        todayKey,
      ),
    };
  });

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit).map((h) => ({
    bill: hydrate(db, h.row),
    score: h.score,
    itemMatch: h.itemMatch,
    merchantMatch: h.merchantMatch,
  }));
}

/** Bills whose hold window has elapsed — the orphan/purge sweep. */
export function findExpiredHolds(db: Db, now: Date, limit = 500): CanonicalBill[] {
  const rows = db.prepare<[string, number], BillRow>(
    `SELECT * FROM bills
      WHERE state IN ('issued','unclaimed','claim_pending')
        AND hold_expires_at IS NOT NULL AND hold_expires_at <= ?
      LIMIT ?`,
  ).all(now.toISOString(), limit);
  return rows.map((r) => hydrate(db, r));
}
