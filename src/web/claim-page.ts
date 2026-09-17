import { html, raw, when } from './html.js';
import { page } from './layout.js';
import type { BillView } from '../services/billview.js';
import type { ClaimResolution } from '../services/claim.js';

/**
 * The claim page (C-01, journey J1).
 *
 * The ordering is the requirement, not a preference: the bill renders first,
 * and the "keep this" prompt comes *after* the value is on screen. J1 step 5 is
 * explicit about it, and it is the difference between a product and a signup
 * wall with a receipt behind it.
 */

function billBody(view: BillView, opts: { showKeepPrompt: boolean; token?: string }): string {
  const rows: string[] = [];
  if (view.totals.subtotal) rows.push(html`<li><span>Subtotal</span><span>${view.totals.subtotal}</span></li>`);
  if (view.totals.discount) rows.push(html`<li><span>Discount</span><span>−${view.totals.discount}</span></li>`);
  if (view.totals.tax) rows.push(html`<li><span>Tax</span><span>${view.totals.tax}</span></li>`);
  if (view.totals.roundOff) rows.push(html`<li><span>Round off</span><span>${view.totals.roundOff}</span></li>`);
  rows.push(html`<li class="grand"><span>Total</span><span>${view.totals.grandTotal}</span></li>`);

  const lineRows = view.lines.map(
    (l) => html`<tr class="${l.returned ? 'returned' : ''}">
      <td>${l.description}${when(l.serialNumber, html`<div class="muted">Serial ${l.serialNumber}</div>`)}${when(
        l.warranty?.endDateKey,
        html`<div class="muted">Warranty to ${l.warranty?.endDateKey} · ${l.warranty?.sourceLabel}</div>`,
      )}</td>
      <td class="num">${l.qty}${l.uom ? ` ${l.uom}` : ''}</td>
      <td class="num">${l.lineTotal}</td>
    </tr>`,
  );

  const rw = view.returnWindow;

  return html`
<div class="card">
  <div class="meta" style="margin:0 0 6px">
    <span class="badge ${view.provenance.tone}">${view.provenance.label}</span>
    ${when(view.merchant.verified, html`<span class="badge verified">GSTIN verified</span>`)}
    ${when(view.notATaxInvoice, html`<span class="badge flag">Not a tax invoice</span>`)}
    ${when(!view.expensable, html`<span class="badge flag">Shared copy — not expensable</span>`)}
  </div>
  <h1>${view.merchant.displayName}</h1>
  <p class="muted">${view.outlet.name}${view.outlet.city ? `, ${view.outlet.city}` : ''}</p>
  <div class="total">${view.totals.grandTotal}</div>
  <div class="meta">
    <span>${view.documentDateKey ?? 'Date not read'}</span>
    ${when(view.documentNumber, html`<span>Bill ${view.documentNumber}</span>`)}
    ${when(view.paymentMethod, html`<span>${view.paymentMethod}</span>`)}
    <span>Ref ${view.shortRef}</span>
  </div>
  <p class="muted" style="margin-top:10px">${view.provenance.detail}</p>
</div>

${raw(view.warnings.map((w) => html`<div class="note warn">${w}</div>`).join(''))}

${when(
  view.flaggedFields.length > 0,
  html`<div class="card">
    <h2 style="margin-top:0">Check these${view.blockingFieldCount > 0 ? ' before you rely on this bill' : ''}</h2>
    <p class="muted">We weren’t sure about these. Tap one to compare it with the photo and fix it.</p>
    ${raw(
      view.flaggedFields
        .map(
          (f) => html`<button class="flagged" name="field" value="${f.fieldPath}">
            <strong>${f.label}</strong>${f.value ? `: ${f.value}` : ''}
            ${when(f.note, html`<div>${f.note}</div>`)}
          </button>`,
        )
        .join(''),
    )}
  </div>`,
)}

<div class="card">
  <h2 style="margin-top:0">Items</h2>
  <table>
    <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Amount</th></tr></thead>
    <tbody>${raw(lineRows.join(''))}</tbody>
  </table>
  ${when(
    view.paginated,
    html`<p class="muted" style="margin-top:10px">Showing the first ${view.lines.length} of ${view.lineCount} items.
      <a href="/b/${view.id}?all=1">Show all</a></p>`,
  )}
  <ul class="rows" style="margin-top:12px">${raw(rows.join(''))}</ul>
  ${when(
    view.totals.sumDiscrepancyFlagged,
    html`<div class="note flag" style="margin-top:12px">The items add up to ${view.totals.lineSum}, but the
      printed total is ${view.totals.grandTotal}. We’ve kept both. The printed total is what the shop charged.</div>`,
  )}
</div>

${when(
  rw.applicable,
  html`<div class="card">
    <h2 style="margin-top:0">Returns</h2>
    <div class="countdown">
      ${rw.open && rw.daysRemaining !== null
        ? raw(html`<strong>${rw.daysRemaining} day${rw.daysRemaining === 1 ? '' : 's'} left</strong><span class="muted">to return · until ${rw.expiresDateKey}</span>`)
        : raw(html`<strong>Closed</strong><span class="muted">${rw.expiresDateKey ? `ended ${rw.expiresDateKey}` : ''}</span>`)}
    </div>
    <p class="muted" style="margin-top:8px">${rw.sourceLabel}</p>
    ${when(rw.note, html`<p class="muted">${rw.note}</p>`)}
  </div>`,
)}

${when(
  opts.showKeepPrompt,
  html`<div class="card">
    <h2 style="margin-top:0">Keep this bill</h2>
    <p>Save it to your account so you can find it when something needs returning or a warranty runs out.</p>
    <form method="post" action="/c/${opts.token ?? ''}/claim">
      <input class="field" type="tel" name="phone" inputmode="numeric" autocomplete="tel"
             placeholder="Mobile number" aria-label="Mobile number" required>
      <button class="btn" type="submit">Keep this bill</button>
    </form>
    <a class="btn secondary" href="/c/${opts.token ?? ''}/link">Just give me a link</a>
    <p class="muted" style="margin-top:6px">A link works for the next 15 minutes without an account. Keeping the bill
      means it’s still here in a year.</p>
  </div>`,
)}`;
}

export function renderClaimPage(resolution: ClaimResolution, token: string): string {
  switch (resolution.kind) {
    case 'valid': {
      const view = resolution.view!;
      // T-04: a sensitive-class bill must not put the merchant name in the tab
      // title either — a browser-switcher preview is the same leak as a lock
      // screen.
      const title = view.sensitive ? 'Your bill' : `${view.merchant.displayName} — your bill`;

      if (resolution.requiresSecondFactor) {
        // E2: on a high-value bill, confirm before showing. The person holding
        // the slip can answer instantly; the person behind them in the queue
        // cannot.
        return page({ title: 'Confirm this is your bill' }, html`
          <div class="card">
            <h1>Confirm this is your bill</h1>
            <p>${resolution.secondFactorPrompt}</p>
            <form method="post" action="/c/${token}/verify">
              <input class="field" type="text" name="secondFactor" inputmode="numeric" maxlength="4"
                     placeholder="Last 4 digits of the total" aria-label="Last 4 digits of the total" required>
              <button class="btn" type="submit">Show my bill</button>
            </form>
            <p class="muted">This step only appears on larger bills. It stops someone standing behind you
              from scanning the same code.</p>
          </div>`);
      }

      return page({ title }, billBody(view, { showKeepPrompt: true, token }));
    }

    case 'owner':
      return page(
        { title: resolution.view!.sensitive ? 'Your bill' : `${resolution.view!.merchant.displayName} — your bill` },
        billBody(resolution.view!, { showKeepPrompt: false }),
      );

    case 'expired': {
      // #1 on the will-bite-first list. This page is the fix: it identifies the
      // bill, explains plainly, and offers the way in.
      const id = resolution.identity!;
      return page({ title: 'Your bill is still here' }, html`
        <div class="card">
          <h1>Your bill is still here</h1>
          <p class="muted">The code you scanned has expired, but we know which bill it was.</p>
          <div class="total">${id.amount}</div>
          <div class="meta">
            <span>${id.merchantDisplayName}</span>
            ${when(id.outletName, html`<span>${id.outletName}</span>`)}
            ${when(id.documentDateKey, html`<span>${id.documentDateKey}</span>`)}
            <span>Ref ${id.shortRef}</span>
          </div>
        </div>
        <div class="card">
          <h2 style="margin-top:0">Add it to your account</h2>
          <p>Confirm one detail from your printed slip and it’s yours.</p>
          <form method="post" action="/c/${token}/retroactive">
            <input class="field" type="tel" name="phone" inputmode="numeric" autocomplete="tel"
                   placeholder="Mobile number" aria-label="Mobile number" required>
            <input class="field" type="text" name="secondFactor" inputmode="numeric" maxlength="4"
                   placeholder="Last 4 digits of the total on your slip"
                   aria-label="Last 4 digits of the total on your slip" required>
            <button class="btn" type="submit">Add this bill</button>
          </form>
          <p class="muted">We ask so a code scanned by mistake doesn’t end up on the wrong
            account. Read it off the printed slip in your hand.</p>
          <a class="btn secondary" href="/capture">Photograph the slip instead</a>
        </div>`);
    }

    case 'already_claimed': {
      const id = resolution.identity!;
      return page({ title: 'This bill is already saved' }, html`
        <div class="card">
          <h1>This bill is already saved</h1>
          <p>${resolution.message}</p>
          <div class="meta">
            <span>${id.merchantDisplayName}</span>
            <span>${id.amount}</span>
            ${when(id.documentDateKey, html`<span>${id.documentDateKey}</span>`)}
            <span>Ref ${id.shortRef}</span>
          </div>
        </div>
        <div class="card">
          <a class="btn" href="/signin?next=/b/${resolution.billId ?? ''}">Sign in to see it</a>
          <a class="btn secondary" href="/dispute/${resolution.billId ?? ''}">This should be my bill</a>
        </div>`);
    }

    case 'unknown':
    default:
      return page({ title: 'We don’t recognise this code' }, html`
        <div class="card">
          <h1>We don’t recognise this code</h1>
          <p>${resolution.message}</p>
          <a class="btn" href="/capture">Photograph your bill</a>
        </div>`);
  }
}

/** E8 "one bill in the account" — a designed screen, not an empty list. */
export function renderFirstBillState(view: BillView): string {
  return page({ title: 'Your first bill' }, html`
    ${raw(billBody(view, { showKeepPrompt: false }))}
    <div class="card">
      <h2 style="margin-top:0">What happens next</h2>
      <p>This bill stays here. When you need it — a return, a warranty, an expense claim — it’s one search away,
        and it doesn’t fade like the paper does.</p>
      <p class="muted">Right now you have one bill, which doesn’t look like much. The fastest way to make this
        useful is to add one you already have.</p>
      <a class="btn" href="/capture">Photograph an old receipt</a>
      <p class="muted">Any shop, any paper bill — it doesn’t have to be a shop that uses Billing Hub.</p>
    </div>`);
}
