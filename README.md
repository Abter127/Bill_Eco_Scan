# Billing Hub

A format-agnostic bridge between the bill a shop prints and the record a customer keeps.
India-first: GST, HSN/SAC, UPI, DPDP Act 2023, thermal-printer retail.

Built from the Billing Hub PRD v0.1. This repository implements the **P0 (v1) requirement
set** plus the P1 items the P0 flows depend on. P2 items (POS/IRP connectors, accounting
connectors, bill transfer) are deliberately out — see [Scope](#what-is-and-is-not-built).

---

## Why it is shaped this way

The PRD's edge-case catalogue is the longest section on purpose: *"in a billing product the
exceptions aren't rare, they're most of retail."* So the architecture is organised around
the exceptions rather than the happy path.

Three decisions follow from that, and they explain most of the code:

**1. The consent boundary is a type, not a permission check.**
There is no code path that hands a merchant a `CanonicalBill`. Merchant-facing code takes
`MerchantVisibleBill`, which has nowhere to put a customer identity. A runtime guard
(`assertNoCustomerIdentity`) catches a careless spread, and `/api/v1/console/:id/identity-audit`
turns M-04's acceptance criterion into an endpoint an auditor can call.
*"If the schema can't express it, sales can't sell it."*

**2. Uncertainty is per field, and loud.**
Confidence is tracked on individual fields, never on the document, because "95% document
accuracy with 5% total-amount error is a broken product wearing a good number". The total
carries a 0.985 gate and blocks; an item description carries 0.82 and does not. A total
computed from the line items is marked `derived` and always flagged — presented as
computed, never as read.

**3. Bills are immutable; everything else is a linked document.**
Voids, credit notes, amendments and exchanges never edit an amount. They create a new
document and link it, so a claim page shows an amendment inline rather than a silently
different number, and a refund recorded after an export flags that export instead of
diverging from it quietly.

---

## Layout

```
src/
  core/        Pure domain logic, no I/O. Everything here is unit-testable in isolation.
    money        Integer minor units; refuses to total across currencies (E7).
    time         April–March financial year, ambiguous dates, clock skew (E7).
    escpos       Cut-boundary framing; rejects interleaved jobs rather than guessing (E1).
    classify     Bill vs KOT / quote / challan / shift report / test print (M-05).
    extract      One layout-aware extractor shared by print stream and OCR (R-01).
    dedupe       Merge only on a matching document number; otherwise ask (E3).
    lifecycle    issued → unclaimed → claim_pending → claimed, + orphaned/purged (C-02).
    consent      The merchant projection type and scoped grants (T-01).
    sensitivity  Pharmacy/clinic/diagnostic handling (T-04).
    provenance, confidence, warranty, search, gstin, fingerprint, ids, schema

  db/          SQLite schema + repositories. Constraints carry PRD rules.
  services/    Issuance, claim, capture, amendments, exports, notifications, DPDP,
               metrics, jobs. The OCR boundary lives under services/ocr.
  api/         Fastify routes, stateless sessions, token-bucket rate limiting.
  web/         Server-rendered claim page and merchant console. No client bundle.
  agent/       The on-premise print-capture agent and its durable outbox.

tests/         230 tests, organised by the PRD's edge-case sections.
docs/          Requirements traceability, and the open decisions as implemented.
```

---

## Running it

```bash
npm install
npm test              # 230 tests
npm run typecheck

npm run seed          # creates a demo merchant, till and three bills
npm run dev           # http://localhost:8080
```

`npm run seed` prints a claim-page URL and the terminal credentials for the console.

### The agent

The agent registers as a printer. A shop points its POS at the agent's host instead of the
printer's, and the agent forwards every byte onward before doing anything else — so paper
comes out at the same speed whether the link is up, down, or on fire.

```bash
BILLING_HUB_URL=https://bills.example.in \
BILLING_HUB_TERMINAL_ID=... \
BILLING_HUB_TERMINAL_SECRET=... \
BILLING_HUB_OUTLET_ID=... \
BILLING_HUB_PRINTER_HOST=192.168.1.50 \
npm run agent
```

Nothing about the billing software changes. That is M-01's acceptance criterion: *"staff
notice no difference."*

### Configuration

| Variable | Purpose |
|---|---|
| `BILLING_HUB_DB` | SQLite path (default `./data/billing-hub.sqlite`) |
| `BILLING_HUB_SECRET` | Session signing key. **Required in production.** |
| `BILLING_HUB_PUBLIC_URL` | Base URL encoded into claim QRs |
| `BILLING_HUB_EXPORT_DIR` | Where export files are written |
| `BILLING_HUB_INTERNAL_KEY` | Guards the trust-and-safety anomaly endpoint |

---

## The eight that bite first

The PRD ranks these. Each has a named home in the code and tests that fail if it regresses.

| # | Case | Where it is handled | Test |
|---|---|---|---|
| 1 | Expired-token dead end | `services/claim.ts` → `resolveClaimToken` returns `expired` with merchant, date and amount, plus a retroactive path. Never a 404. | `claim.test.ts`, `api.test.ts` |
| 2 | Non-bill documents on the printer | `core/classify.ts` — disqualifying markers beat positive evidence; a slip with no money at all is a KOT. Unknown goes to quarantine, never to a customer. | `ingestion.test.ts` |
| 3 | Reprint duplicates | `core/fingerprint.ts` — fingerprints *content*, not print events. A second identical stream issues no new token. | `ingestion.test.ts` |
| 4 | False dedupe merge | `core/dedupe.ts` — auto-merge requires a matching document number; everything softer returns `ask`, whose prompt defaults to *keep both*. | `capture.test.ts` |
| 5 | Notification preview leak | `core/sensitivity.ts` — sensitive-class merchants get a generic preview with no name or amount, in the title as well as the body. | `trust.test.ts` |
| 6 | Ambiguous dates | `core/time.ts` — `03/04/2026` returns `dateKey: null, ambiguous: true` with both candidates. Capture date may eliminate one; merchant locale never does. | `core.test.ts` |
| 7 | Merchant churns at low claim rate | `services/metrics.ts` — coaching with a benchmark and a concrete fix (QR placement), from the first week. | `merchant.test.ts` |
| 8 | Handwritten *kacha* bills | `core/extract.ts` → `looksHandwritten`; stored as low-provenance and labelled *not a tax invoice*. | `capture.test.ts` |

---

## What is and is not built

**Built (P0):** M-01 print-stream capture · M-02 claim QR · M-03 offline queue ·
M-04 merchant console · M-05 document classification · C-01 no-install claim page ·
C-02 lifecycle · R-01 capture pipeline · R-02 search · R-03 provenance ·
R-04 return countdown · R-06 export · T-01 consent boundary · T-02 access audit ·
T-03 DPDP rights · T-04 sensitivity classification.

**Built (P1, because P0 flows lean on them):** C-03 retroactive claim (the recovery path for
every expired token and every capture gap) · C-04 profiles · R-05 warranty tracking and pack ·
T-05 format preference.

**Not built:** M-06 merchant PWA · M-07 POS/IRP connectors · R-07 accounting connectors and
GSTR-2B · C-05 bill transfer. The canonical schema is the mapping target these need, and
`services/ocr/types.ts` shows the shape an external integration takes.

**Substituted for a real service:** OCR. `OcrAdapter` is the boundary and
`FixtureOcrAdapter` drives it from JSON sidecars, so every E3 case is a fixture rather than
a claim. A production adapter implements the same interface and the pipeline does not change.

See [`docs/requirements.md`](docs/requirements.md) for the full requirement-by-requirement
map and [`docs/decisions.md`](docs/decisions.md) for how the six open decisions are
currently resolved.

---

## Bugs this build found

Written down because each was silent, and the kind of thing that ships:

- **Amounts of four or more digits were truncated to their last three.** A grouping-only
  regex anchored to end-of-line matched `205.00` inside `2205.00`; ₹38,500 read as ₹500.
  Found by rendering the merchant console against seeded data, not by a test. Fixed with a
  grouped-or-plain alternation, with a regression test over both conventions.
- `INV` matched inside the word `INVOICE`, capturing `OICE` as a bill number.
- `2 x 145.00` continuation lines were counted as separate items, roughly doubling the line
  sum and raising a false mismatch flag on correct bills.
- The loser of a simultaneous claim got *"this bill can no longer be claimed"* instead of
  the race message with a dispute path, because bill state was checked before the token.
- A user-edited amount lost its export flag on bills that arrived structured, because the
  flag required a prior extraction row that those bills never had — exactly the E6
  reimbursement case.
- Link timestamps used wall time, so a credit note replayed after an outage started its
  orphan-alert clock at reconnect rather than at the return.
- The agent re-queued permanent 4xx rejections forever.
