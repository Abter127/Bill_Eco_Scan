import { z } from 'zod';

/**
 * The canonical bill schema. Every ingestion path — print stream, merchant PWA,
 * photo capture, POS connector, IRP feed — maps *into* this and nothing else.
 *
 * Two schema-level commitments from the PRD are load-bearing:
 *
 *   T-01 / E6: there is no field anywhere on a merchant-visible projection that
 *   can hold a customer identity. "Write it into the product, not the policy —
 *   if the schema can't express it, sales can't sell it."
 *
 *   E4: bills are immutable. Nothing here is an editable amount. Corrections
 *   arrive as new documents linked to the original.
 */

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

export const DocumentTypes = [
  'tax_invoice',
  'bill_of_supply',
  'kacha', // handwritten / unstructured, explicitly not a tax invoice (E3)
  'credit_note',
  'debit_note',
  'amendment',
  'void',
] as const;
export type DocumentType = (typeof DocumentTypes)[number];

/** What the classifier may decide a print stream is. Only `bill` is ingested. */
export const StreamClasses = [
  'bill',
  'kitchen_order_ticket',
  'quote',
  'delivery_challan',
  'shift_report',
  'test_print',
  'training_mode',
  'reprint',
  'unknown',
] as const;
export type StreamClass = (typeof StreamClasses)[number];

export const BillStates = [
  'issued',
  'unclaimed',
  'claim_pending',
  'claimed',
  'orphaned',
  'cancelled',
  'purged',
] as const;
export type BillState = (typeof BillStates)[number];

export const Provenances = [
  'irp',              // e-invoice feed, government-signed
  'pos_connector',    // vendor integration
  'print_stream',     // our agent, at the counter
  'merchant_manual',  // merchant PWA (Tier 0)
  'photo_ocr',        // customer photograph of an original
  'photo_screen',     // photograph of a screen — downgraded, never original (E3)
  'user_manual',      // typed by the customer
] as const;
export type Provenance = (typeof Provenances)[number];

export const LinkRelations = [
  'amends',
  'cancels',
  'credit_note_for',
  'exchange_of',
  'visit_group',      // one shop, two legal entities (E1)
  'duplicate_of',
  'shared_copy_of',   // split payment (E1) — read-only, non-expensable
  'attachment_of',    // warranty card / serial sticker photographed with a bill
] as const;
export type LinkRelation = (typeof LinkRelations)[number];

export const FieldSources = ['printed', 'extracted', 'derived', 'user'] as const;
export type FieldSource = (typeof FieldSources)[number];

export const SensitivityClasses = ['standard', 'sensitive'] as const;
export type SensitivityClass = (typeof SensitivityClasses)[number];

export const ProfileKinds = ['personal', 'business'] as const;
export type ProfileKind = (typeof ProfileKinds)[number];

// ---------------------------------------------------------------------------
// Line items
// ---------------------------------------------------------------------------

export const billLineSchema = z.object({
  lineNo: z.number().int().nonnegative(),
  description: z.string().min(1),
  /** HSN for goods, SAC for services. Absent on a kacha bill. */
  hsnSac: z.string().nullable().default(null),
  qty: z.number().finite().default(1),
  uom: z.string().nullable().default(null),
  unitPriceMinor: z.number().int().nullable().default(null),
  /** GST rate in basis points: 18% -> 1800. Integers only. */
  gstRateBp: z.number().int().nullable().default(null),
  taxableValueMinor: z.number().int().nullable().default(null),
  cgstMinor: z.number().int().nullable().default(null),
  sgstMinor: z.number().int().nullable().default(null),
  igstMinor: z.number().int().nullable().default(null),
  cessMinor: z.number().int().nullable().default(null),
  discountMinor: z.number().int().nullable().default(null),
  lineTotalMinor: z.number().int(),
  /** Needed for a warranty pack (R-05). */
  serialNumber: z.string().nullable().default(null),
  warrantyMonths: z.number().int().nonnegative().nullable().default(null),
  /** Set when a credit note references this line (E4 partial return). */
  returnedQty: z.number().finite().default(0),
});
export type BillLine = z.infer<typeof billLineSchema>;

// ---------------------------------------------------------------------------
// Merchant-supplied bill payload (what the agent posts)
// ---------------------------------------------------------------------------

export const billPayloadSchema = z.object({
  /** Client-generated UUID. The idempotency key for the whole pipeline (M-03). */
  idempotencyKey: z.string().uuid(),
  outletId: z.string().min(1),
  terminalId: z.string().min(1),
  documentType: z.enum(DocumentTypes).default('tax_invoice'),
  documentNumber: z.string().min(1).nullable().default(null),
  /** Terminal-stated wall clock, ISO 8601. Never trusted alone (E7). */
  terminalTime: z.string().datetime({ offset: true }),
  /** Local date key the document itself claims. Governs all reporting (E7). */
  documentDateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  currency: z.string().length(3).default('INR'),
  subtotalMinor: z.number().int().nullable().default(null),
  taxTotalMinor: z.number().int().nullable().default(null),
  discountTotalMinor: z.number().int().nullable().default(null),
  roundOffMinor: z.number().int().nullable().default(null),
  /** The printed grand total. Canonical even when the lines disagree (E1). */
  grandTotalMinor: z.number().int(),
  paymentMethod: z.string().nullable().default(null),
  /** Buyer GSTIN on a B2B invoice. The only identity a merchant ever supplies. */
  buyerGstin: z.string().nullable().default(null),
  placeOfSupply: z.string().nullable().default(null),
  lines: z.array(billLineSchema).default([]),
  /** Raw captured bytes, retained for dispute resolution and re-parsing. */
  rawSourceRef: z.string().nullable().default(null),
  /** When the agent queued it locally — survives a four-hour outage (M-03). */
  enqueuedAt: z.string().datetime({ offset: true }).nullable().default(null),
  /** Links this document declares at issue time (credit notes, amendments). */
  links: z
    .array(
      z.object({
        relation: z.enum(LinkRelations),
        /** Document number of the target; may not exist yet (E4 out of order). */
        targetDocumentNumber: z.string().min(1),
        /** Lines of the target this document affects. Empty = whole document. */
        targetLineNos: z.array(z.number().int().nonnegative()).default([]),
      }),
    )
    .default([]),
});
export type BillPayload = z.infer<typeof billPayloadSchema>;

// ---------------------------------------------------------------------------
// Field-level confidence (R-01)
// ---------------------------------------------------------------------------

export const fieldConfidenceSchema = z.object({
  /** Dotted path into the canonical bill, e.g. "grandTotalMinor", "lines.0.qty". */
  fieldPath: z.string().min(1),
  source: z.enum(FieldSources),
  /** 0..1. Absent for printed/user sources, which are not guesses. */
  confidence: z.number().min(0).max(1).nullable().default(null),
  /** What extraction originally produced. Never overwritten by a correction. */
  originalValue: z.string().nullable().default(null),
  /** Below the gate: rendered highlighted and tappable, never as final. */
  flagged: z.boolean().default(false),
  note: z.string().nullable().default(null),
});
export type FieldConfidence = z.infer<typeof fieldConfidenceSchema>;

// ---------------------------------------------------------------------------
// The stored bill
// ---------------------------------------------------------------------------

export interface CanonicalBill {
  id: string;
  billGroupId: string;
  merchantId: string;
  outletId: string;
  terminalId: string | null;
  documentType: DocumentType;
  documentNumber: string | null;
  /** Unique per merchant per financial year, never globally (E7). */
  financialYear: string | null;
  documentDateKey: string | null;
  documentDateAmbiguous: boolean;
  documentDateCandidates: string[];
  terminalTime: string | null;
  serverReceiptTime: string;
  clockSkewMs: number | null;
  clockSkewFlagged: boolean;
  currency: string;
  subtotalMinor: number | null;
  taxTotalMinor: number | null;
  discountTotalMinor: number | null;
  roundOffMinor: number | null;
  grandTotalMinor: number;
  /** Sum of line totals. Stored alongside, never reconciled into (E1). */
  lineSumMinor: number | null;
  sumDiscrepancyMinor: number | null;
  sumDiscrepancyFlagged: boolean;
  paymentMethod: string | null;
  buyerGstin: string | null;
  placeOfSupply: string | null;
  provenance: Provenance;
  contentFingerprint: string;
  idempotencyKey: string | null;
  state: BillState;
  ownerAccountId: string | null;
  ownerProfileId: string | null;
  sensitivityClass: SensitivityClass;
  /** True when this document may not be presented as a GST tax invoice. */
  notATaxInvoice: boolean;
  /** Set when a shared read-only copy exists; blocks double-expensing (E1). */
  expensable: boolean;
  imageRef: string | null;
  rawSourceRef: string | null;
  claimedAt: string | null;
  holdExpiresAt: string | null;
  createdAt: string;
  lines: BillLine[];
  fields: FieldConfidence[];
}

// ---------------------------------------------------------------------------
// Merchant / outlet / account
// ---------------------------------------------------------------------------

export const merchantSchema = z.object({
  id: z.string(),
  /** GSTIN is the identity; trade name is only a display string (E3). */
  gstin: z.string().nullable(),
  legalName: z.string(),
  tradeName: z.string().nullable(),
  category: z.string(),
  gstinVerified: z.boolean().default(false),
  verifiedBadge: z.boolean().default(false),
  /** Successor linkage for re-registration (E5). Historical bills keep theirs. */
  successorMerchantId: z.string().nullable().default(null),
  state: z.enum(['active', 'departed', 'suspended']).default('active'),
  returnWindowDays: z.number().int().nonnegative().nullable().default(null),
  returnPolicySource: z.string().nullable().default(null),
  createdAt: z.string(),
});
export type Merchant = z.infer<typeof merchantSchema>;

export const outletSchema = z.object({
  id: z.string(),
  merchantId: z.string(),
  name: z.string(),
  city: z.string().nullable(),
  /** Outlets close, they are never deleted (E5). */
  state: z.enum(['active', 'closed']).default('active'),
  createdAt: z.string(),
});
export type Outlet = z.infer<typeof outletSchema>;
