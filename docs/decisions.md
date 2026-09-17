# Open decisions, as currently resolved

PRD §9 lists six decisions as blocking. None of them can be settled by writing code, so each
is implemented as a **named default in one place**, with the reasoning recorded and the
override path built. Changing any of them is a one-line change, not a refactor.

---

## 01 — Hold window for unclaimed bills

**Default: 90 days**, then `orphaned`; purge after a further 30-day grace.
`core/lifecycle.ts` → `DEFAULT_HOLD_WINDOW_DAYS`, overridable per deployment via
`IssuanceConfig`.

The PRD calls 90 days defensible and names the trade-off: longer improves retroactive claim,
worsens the privacy story and the storage bill. The implementation weakens that trade-off
rather than picking a side — **`orphaned` is still claimable**. The window gates *purge*, not
claiming, so a customer photographing a four-month-old slip still binds their bill. What
expires at 90 days is our willingness to keep an unclaimed payload warm, not the customer's
right to it.

Purge de-identifies rather than deletes: the merchant's statutory copy persists under the
carve-out disclosed in the consent notice (`core/lifecycle.ts` → `purgePlanFor`).

## 02 — Merchant registry source

**Default: self-built directory with local GSTIN validation; GSP lookup not wired.**

`core/gstin.ts` validates the check digit and state code, which catches a fabricated GSTIN
without a network call, and the verified badge is withheld unless it passes. `E5`'s other two
defences are built and do not depend on a GSP: velocity anomaly detection
(`services/metrics.ts` → `velocityAnomalies`) and the customer-visible badge on the bill.

The gap this leaves: a *valid* GSTIN belonging to someone else. That needs a GSP, and the
decision is a commercial one. `merchants.gstin_verified` is the single field a GSP
integration would set.

## 03 — Does warranty restart on replacement?

**Default: continue** the original warranty, with the source shown and an override.
`core/warranty.ts` → `DEFAULT_REPLACEMENT_RULE`.

The PRD is right that it varies by manufacturer, so the product's job is not to be right —
it is to be legible. The rule, its source label and the resulting dates are all returned
together by `warrantyAfterReplacement`, and `recordWarrantyReplacement` accepts an override.
A user who knows their manufacturer restarts can say so; a user who does not is told which
rule produced the date they are looking at.

## 04 — Sensitivity classification list

**Owner: `privacy-office`. Version: `2026-09-01`.** `core/sensitivity.ts` → `SENSITIVITY_POLICY`.

The list is data with a named maintainer and a version string, rather than conditions spread
through the code. It carries 16 categories plus name patterns, because the likelier failure
is a merchant self-declaring `general` than the list being wrong — so a shop called "Apollo
Pharmacy" is classified sensitive whatever its category says.

The unresolved half is governance: who reviews additions, and how often. An unmaintained
list is the failure mode, which is why `maintainer` is a required field on the policy object
rather than a comment.

## 05 — High-value claim friction

**Default: a second factor above ₹25,000** — the last four digits of the amount.
`db/repo/claims.ts` → `HIGH_VALUE_SECOND_FACTOR_MINOR`.

The threat is E2's queue-scanner. The defence has to cost the buyer almost nothing and cost
the attacker everything, and "what does the slip in your hand say" does exactly that: the
buyer is holding the number, the person behind them is not.

₹25,000 is a guess pending claim-rate data from M2. The instrumentation to settle it exists —
claim rate is already segmented by outlet, and a drop above the threshold would show up
against one below it. A failed attempt does not consume the token, so a mistyped digit does
not cost the real buyer their bill.

## 06 — Who pays

**Not resolved, and deliberately not encoded.**

This is the one decision that should not be settled by the build. The PRD notes it "changes
what's P0", and the defensive move is to keep every path open:

- **Merchant SaaS / per-bill** — `issuance_stats` counts bills issued, claimed, paper
  printed and paper suppressed per outlet per day. Both meters already exist.
- **Business tier** — profiles, GSTIN attachment, financial-year exports and provenance
  flags are built; a tier boundary is a check, not a feature.
- **Accounting connector upsell** — R-07 is unbuilt but the export already carries the
  columns (including HSN/SAC) a reconciliation needs.

One thing *is* foreclosed on purpose. Merchant-side customer data is not a revenue line,
because the schema cannot express it (T-01). E6 is blunt about why: it is "the most-requested
feature, and the one that ends the company". Keeping it structurally impossible means no
future pricing conversation can quietly reopen it.

---

## Decisions taken that the PRD left implicit

| Decision | Choice | Why |
|---|---|---|
| Reprint detection window | 30 minutes, plus an explicit reprint marker | Long enough for a cashier reprinting a smudged slip; short enough that two genuine purchases of the same item hours apart stay separate |
| Offline-scan grace | 6 hours past token expiry, with client-attested scan time | Covers a customer who scanned in a basement and surfaced later, without making a 15-minute token effectively permanent |
| Dedupe auto-merge bar | A matching document number, nothing softer | E3 is explicit that a false merge is worse than a missed duplicate |
| Confidence gate on the total | 0.985, blocking | Derived from the ≥99% total-accuracy metric in §3 |
| Staff-claim anomaly threshold | 25% of one till's claims over ≥8 claims | Low enough to catch the pattern, high enough not to flag a genuine regular at a small counter |
| Coercion threshold | 70% paper suppression over ≥25 bills | Far above the 20% target, so it flags behaviour customer preference cannot explain |
| Async export threshold | 2,000 bills | Well under the 50,000 case in E7, so the path is exercised long before it is needed |
| Search visibility | 12 bills | E8 says not to show a search bar over a list short enough to read |
