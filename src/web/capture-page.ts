import { html, when } from './html.js';
import { page } from './layout.js';

/**
 * The "add a paper bill" page (journey J2).
 *
 * Honesty note carried into the UI: automatic photo reading needs the OCR
 * engine, which in this build is a fixture rather than a real model, and there
 * is no image blob store wired up. So this page leads with the path that works
 * end to end without either — typing the bill in — and is plain about the photo
 * option rather than presenting a capture flow that would quietly do nothing.
 */

export interface CapturePageOptions {
  /** True when the visitor already has a session; we then skip the phone field. */
  signedIn: boolean;
  error?: string | null;
  /** Pre-fill after a validation bounce so the customer doesn't retype. */
  values?: { shop?: string; date?: string; amount?: string; gstin?: string };
}

export function renderCapturePage(opts: CapturePageOptions): string {
  const v = opts.values ?? {};
  const today = new Date().toISOString().slice(0, 10);

  return page({ title: 'Add a paper bill' }, html`
<div class="card">
  <h1>Add a paper bill</h1>
  <p class="muted">From any shop — it doesn’t have to be one that uses Billing Hub. Type in what the
    slip says and it joins your history, ready for a return or a warranty.</p>
</div>

${when(opts.error, html`<div class="note warn">${opts.error}</div>`)}

<div class="card">
  <form method="post" action="/capture">
    <label class="muted" for="shop">Shop name</label>
    <input class="field" id="shop" name="shop" type="text" value="${v.shop ?? ''}"
           placeholder="e.g. Gupta Kirana Store" required>

    <label class="muted" for="amount">Total on the bill (₹)</label>
    <input class="field" id="amount" name="amount" type="text" inputmode="decimal" value="${v.amount ?? ''}"
           placeholder="e.g. 640.00" required>

    <label class="muted" for="date">Date on the bill</label>
    <input class="field" id="date" name="date" type="date" value="${v.date ?? today}" max="${today}" required>

    <label class="muted" for="gstin">Shop GSTIN <span>(optional — turns this into a tax invoice)</span></label>
    <input class="field" id="gstin" name="gstin" type="text" value="${v.gstin ?? ''}"
           placeholder="15-character GSTIN, if it’s printed">

    ${when(!opts.signedIn, html`<label class="muted" for="phone">Your mobile number</label>
          <input class="field" id="phone" name="phone" type="tel" inputmode="numeric" autocomplete="tel"
                 placeholder="So we can keep this bill for you" required>`)}

    <button class="btn" type="submit">Add this bill</button>
  </form>
  <p class="muted" style="margin-top:6px">This is saved as something you typed, not a tax invoice —
    handy for returns and warranties, not for claiming input tax credit.</p>
</div>

<div class="card">
  <h2 style="margin-top:0">Photographing it instead</h2>
  <p class="muted">In the full product you photograph the slip and it’s read for you. That reader isn’t
    switched on in this local build, so typing it in is the way to add a bill here.</p>
</div>`);
}
