# Requirements traceability

Every requirement from PRD §6, and where it lives. Acceptance criteria that the PRD states
as testable are listed with the test that asserts them.

Legend: **Done** · **Partial** (built, with a named gap) · **Not built** (out of scope for
this build).

---

## M — Merchant / issuance

| ID | Requirement | Status | Implementation | Acceptance test |
|---|---|---|---|---|
| **M-01** | Print-stream capture agent | Done | `agent/agent.ts` listens on TCP 9100 and forwards bytes to the real printer before parsing. `core/escpos.ts` frames on cut commands. | *"An unmodified legacy POS produces structured bills"* — `agent.test.ts`; framing and rejection in `ingestion.test.ts` |
| **M-02** | Claim QR surface | Done | `db/repo/claims.ts` (256-bit secret, 15-min TTL, single use, hash at rest); `/qr/:token.svg` renders the QR from a token, never bill content. | *"token cannot be enumerated or replayed"* — `core.test.ts` (entropy), `claim.test.ts` (single use), `api.test.ts` (rate limit) |
| **M-03** | Offline queue | Done | `agent/queue.ts` — durable SQLite outbox, `synchronous = FULL`, client-generated idempotency keys, full-jitter backoff. Server half in `services/issuance.ts` + `idempotency_records`. | *"Four-hour outage reconciles with zero duplicates and zero losses"* — `agent.test.ts` (60 bills through a simulated outage) |
| **M-04** | Merchant console | Done | `services/metrics.ts`, `web/console-page.ts`. Fed only `MerchantVisibleBill`. | *"A full-permission admin can produce no list of people"* — `trust.test.ts` + the live `identity-audit` endpoint |
| **M-05** | Document-type classification | Done | `core/classify.ts`. Disqualifying markers beat positive evidence; unknown is quarantined. | *"A restaurant's kitchen tickets never appear as customer bills"* — `ingestion.test.ts` |
| **M-06** | Merchant PWA (Tier 0) | Not built | P1. `ingestBill` already accepts `provenance: 'merchant_manual'`, so the PWA is a UI over an existing entry point. | — |
| **M-07** | POS and IRP connectors | Not built | P2. The canonical schema (`core/schema.ts`) is the mapping target; `provenance` already distinguishes `pos_connector` and `irp`. | — |

## C — Claim and identity

| ID | Requirement | Status | Implementation | Acceptance test |
|---|---|---|---|---|
| **C-01** | No-install claim page | Done | `web/claim-page.ts` + `web/layout.ts`. Server-rendered, critical CSS inline, **no script tag at all** (the CSP says `default-src 'none'`). Account creation is offered below the bill. | *"Scan to readable bill under 3 s on 4G"* — page is ~6.7 KB in one request with no blocking resources; `api.test.ts` asserts the bill precedes the prompt and that no script is present |
| **C-02** | Bill lifecycle states | Done | `core/lifecycle.ts` — explicit transition table with guards; `services/jobs.ts` runs the hold-window sweep. | `core.test.ts` (illegal transitions), `claim.test.ts` (orphaned is still claimable) |
| **C-03** | Retroactive claim | Done | `services/claim.ts` → `retroactiveClaim`, reached from the expired-token page. | *"Walk-in with no account can claim yesterday's bill"* — `claim.test.ts` |
| **C-04** | Profiles | Done | `db/repo/people.ts` (personal/business + GSTIN), `reassignProfile` with an audit entry and an export warning. | `claim.test.ts` |
| **C-05** | Bill transfer | Not built | P2. The adjacent case — a shared, non-expensable copy for a split payment — *is* built (`shareBillCopy`), which covers the most common support ticket. | — |

## R — Records and derived value

| ID | Requirement | Status | Implementation | Acceptance test |
|---|---|---|---|---|
| **R-01** | Capture pipeline | Done | `services/capture.ts`, `core/extract.ts`, `core/confidence.ts`. Async, image stored and viewable before OCR runs. | *"never wrong and confident"* — `capture.test.ts` covers screen photos, kacha bills, multi-script, multi-document, stitching gaps, annotations, rejection |
| **R-02** | Search | Done | `core/search.ts` (half-memory parsing) + FTS5 with recency/item-match ranking. | *"find a purchase from item + rough month; first results < 200 ms"* — `api.test.ts`; `exports.test.ts` searches 5,000 bills well inside budget |
| **R-03** | Provenance display | Done | `core/provenance.ts` badges; `bill_fields` rows are append-only so the original extraction is always recoverable. | `capture.test.ts`, `core.test.ts` |
| **R-04** | Return-window countdown | Done | `core/warranty.ts` → `returnWindowState`, always carrying `sourceLabel`. | `amendments.test.ts` — including refusing to count down from an unread date |
| **R-05** | Warranty tracking and pack | Done | `core/warranty.ts`, `services/exports.ts` → `renderWarrantyPack`, `services/notifications.ts` → `sweepReminders`. | *"Eleven months after an appliance purchase, the user is told unprompted"* — reminder thresholds at 30 and 7 days; `exports.test.ts` asserts the pack contents |
| **R-06** | Export | Done | `services/exports.ts` + `services/filewriters.ts`. CSV, XLSX and PDF written without added dependencies. Not paywalled. | `exports.test.ts` — XLSX verified with an external `unzip`, tax values asserted to be numeric cells, PDF structurally parsed |
| **R-07** | Accounting connectors, GSTR-2B | Not built | P2. The export carries the columns a reconciliation needs, including HSN/SAC. | — |

## T — Trust and controls

| ID | Requirement | Status | Implementation | Acceptance test |
|---|---|---|---|---|
| **T-01** | Consent boundary | Done | `core/consent.ts` — projection type, runtime guard, scoped expiring grants. | `trust.test.ts` |
| **T-02** | Access audit log | Done | `db/repo/ledgers.ts` → `logAccess`; `reason` is non-nullable. Owner-visible via `/api/v1/me/access-log`. | `trust.test.ts`, `api.test.ts` |
| **T-03** | DPDP rights endpoints | Done | `services/dpdp.ts` — access, correction, erasure, grievance with stored SLA deadlines; itemised consent notice; documented disclosure process and transparency report. | `trust.test.ts`, `api.test.ts` |
| **T-04** | Sensitivity classification | Done | `core/sensitivity.ts` — versioned, owned category list plus name patterns. Suppressed previews, excluded from shared profiles, analytics and training sets, mandatory biometric view, excluded from exports by default. | `trust.test.ts` |
| **T-05** | Format preference portability | Done | Stored on the account; honoured at issuance. Paper is always the fallback, and suppression far above the target is flagged as a terms breach. | `trust.test.ts`, `merchant.test.ts` |

---

## Edge-case coverage (PRD §7)

| Section | Cases with enforced behaviour | Notes |
|---|---|---|
| **E1 — At the counter** | 13 of 13 | Reprint, non-bill documents, capture-gap, printer failure, void, amendment, interleaved tills, zero/negative bills, line-sum mismatch, 400-line pagination, two legal entities, split payment, no customer screen |
| **E2 — Claim and identity** | 9 of 9 | Queue scanning, simultaneous claim, expiry, offline scan, wrong profile, bought-for-another (via shared copy), account merge, recycled phone, account deletion |
| **E3 — Capture and extraction** | 13 of 13 | All driven by `OcrAdapter` signals so each is a fixture rather than an assertion about a vendor |
| **E4 — Returns and lifecycle** | 8 of 8 | Partial return, exchange, different outlet, out-of-order credit note, post-export return, warranty replacement, credit note on an unclaimed bill, annotations surviving amendments |
| **E5 — Merchant lifecycle** | 7 of 7 | Departure, re-registration, outlet closure, fake merchant, staff claiming, coercion, low-claim-rate churn |
| **E6 — Privacy and abuse** | 8 of 8 | Preview leak, shared profile, app lock, forwarded link, inflated edit, merchant data demand, legal process, token enumeration |
| **E7 — Time, data and scale** | 8 of 8 | Clock skew, duplicate invoice numbers per FY, midnight boundary, financial year, pre-account bills, 50k volume, storage quota, non-INR |
| **E8 — Cold start** | 5 of 5 | One-bill screen, capture-only mode, search threshold, extraction-in-progress, merchant first day |

Where the PRD states a rule ("→ …"), that rule is implemented and, in most cases, has a
test named after the case. The exceptions are noted inline in the source.

---

## Known gaps

1. **OCR is an interface, not an engine.** Everything downstream of it is real and tested;
   the engine itself is a fixture adapter. Dewarping and screen detection are contract
   inputs rather than implementations.
2. **Notification delivery is recorded, not sent.** `notifications` rows are written with
   the correct suppressed/unsuppressed content; there is no APNs/FCM transport.
3. **Image storage is a reference string.** `imageRef` is stored and carried; no blob store
   is wired up, so the quota logic in `quotaDecision` is exercised only by its callers.
4. **GSTIN verification is structural.** The check digit and state code are validated
   locally (which catches fabricated numbers); there is no GSP lookup, which is open
   decision §9.02.
5. **The purge sweep is destructive by design** and has no undo. It runs only against
   `orphaned` bills past the hold window plus a grace period, and never against a claimed
   bill.
