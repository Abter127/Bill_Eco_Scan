import { html, raw, when } from './html.js';
import { page } from './layout.js';
import type { ConsoleSummary } from '../services/metrics.js';
import type { MerchantVisibleBill } from '../core/consent.js';
import type { QuarantineEntry } from '../db/repo/ledgers.js';

/**
 * The merchant console (M-04).
 *
 * Note what is not on this page: no customer column, no claim timestamps, no
 * "who". The template is fed `MerchantVisibleBill`, which has no field that
 * could hold an identity — the omission is structural, not editorial.
 *
 * What *is* on it, prominently, is the claim-rate coaching from E5. A merchant
 * who cannot see why their first fifty bills went unclaimed churns in week two,
 * so the fix sits above the numbers rather than in a help article.
 */

const SEVERITY_CLASS: Record<string, string> = {
  info: 'ok', warning: 'flag', critical: 'warn',
};

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export function renderConsole(
  summary: ConsoleSummary,
  bills: MerchantVisibleBill[],
  quarantined: QuarantineEntry[],
): string {
  // The merchant knows their till as "Till 1", not as a UUID. The console is
  // read by a shop owner, so every identifier on it should be one they chose.
  const terminalLabels = new Map(summary.captureGaps.map((g) => [g.terminalId, g.label]));
  const tillLabel = (id: string | null) => (id ? terminalLabels.get(id) ?? '' : '');

  const claimPct = Math.min(1, summary.claimRateTarget === 0 ? 0 : summary.claimRate / summary.claimRateTarget);
  const paperPct = Math.min(1, summary.paperSuppressionTarget === 0 ? 0 : summary.paperSuppressionRate / summary.paperSuppressionTarget);

  return page({ title: `${summary.outletName} — Billing Hub` }, html`
<div class="card">
  <h1>${summary.outletName}</h1>
  <p class="muted">${summary.merchantName} · ${summary.period.fromDateKey} to ${summary.period.toDateKey}</p>
</div>

${raw(
  summary.coaching
    .map(
      (c) => html`<div class="note ${SEVERITY_CLASS[c.severity] ?? 'ok'}">
        <strong>${c.title}</strong>
        <div style="margin-top:4px">${c.action}</div>
        ${when(c.benchmark, html`<div class="muted" style="margin-top:4px">${c.benchmark}</div>`)}
      </div>`,
    )
    .join(''),
)}

<div class="card">
  <h2 style="margin-top:0">This period</h2>
  <div class="stat"><span>Bills captured</span><b>${summary.billsIssued}</b></div>
  <div class="stat">
    <span>Bills kept by customers<div class="muted">Target ${pct(summary.claimRateTarget)}</div></span>
    <b>${pct(summary.claimRate)}</b>
  </div>
  <div class="bar"><span style="width:${Math.round(claimPct * 100)}%"></span></div>
  <div class="stat" style="margin-top:12px">
    <span>Slips not printed<div class="muted">Target ${pct(summary.paperSuppressionTarget)}</div></span>
    <b>${pct(summary.paperSuppressionRate)}</b>
  </div>
  <div class="bar"><span style="width:${Math.round(paperPct * 100)}%"></span></div>
  <p class="muted" style="margin-top:14px">Paper is only skipped when a customer has asked for it to be.
    Refusing a printed bill to push someone to scan is a breach of the merchant terms.</p>
</div>

<div class="card">
  <h2 style="margin-top:0">Tills</h2>
  ${raw(
    summary.captureGaps
      .map(
        (g) => html`<div class="stat">
          <span>${g.label}<div class="muted">${
            g.severity === 'ok'
              ? 'Reporting normally'
              : g.lastHeartbeatAt
                ? `Last reported ${g.gapMinutes} minutes ago`
                : 'Has never reported'
          }</div></span>
          <span class="badge ${g.severity === 'ok' ? 'verified' : 'flag'}">${
            g.severity === 'ok' ? 'OK' : g.severity === 'warning' ? 'Check' : 'Down'
          }</span>
        </div>`,
      )
      .join('') || html`<p class="muted">No tills registered yet.</p>`,
  )}
</div>

${when(
  summary.claimAnomalies.length > 0,
  html`<div class="card">
    <h2 style="margin-top:0">Worth a look</h2>
    ${raw(summary.claimAnomalies.map((a) => html`<div class="note flag">${a.note}</div>`).join(''))}
  </div>`,
)}

${when(
  summary.orphanAmendments.length > 0,
  html`<div class="card">
    <h2 style="margin-top:0">Refunds waiting for their bill</h2>
    ${raw(summary.orphanAmendments.map((o) => html`<div class="note flag">${o.message}</div>`).join(''))}
  </div>`,
)}

<div class="card">
  <h2 style="margin-top:0">Bills issued</h2>
  <table>
    <thead><tr><th>Date</th><th>Bill no.</th><th class="num">Total</th><th class="num">Kept</th></tr></thead>
    <tbody>${raw(
      bills
        .map(
          (b) => html`<tr>
            <td>${b.documentDateKey ?? '—'}<div class="muted">${tillLabel(b.terminalId)}</div></td>
            <td>${b.documentNumber ?? '—'}</td>
            <td class="num">${(b.grandTotalMinor / 100).toFixed(2)}</td>
            <td class="num">${b.claimed ? 'Yes' : 'No'}</td>
          </tr>`,
        )
        .join('') || html`<tr><td colspan="4" class="muted">No bills in this period.</td></tr>`,
    )}</tbody>
  </table>
  <p class="muted" style="margin-top:12px">We can tell you whether a bill was kept. We can’t tell you who kept it,
    and there is no setting that changes that.</p>
</div>

${when(
  quarantined.length > 0,
  html`<div class="card">
    <h2 style="margin-top:0">Held back (${quarantined.length})</h2>
    <p class="muted">These prints were not customer bills, so they were never shown to anyone.</p>
    ${raw(
      quarantined
        .slice(0, 20)
        .map(
          (q) => html`<div class="stat">
            <span>${q.streamClass.replace(/_/g, ' ')}<div class="muted">${q.reason}</div></span>
            <span class="muted">${q.createdAt.slice(0, 16).replace('T', ' ')}</span>
          </div>`,
        )
        .join(''),
    )}
  </div>`,
)}`);
}

/** E8 "merchant's first day": prove it works before the session ends. */
export function renderCaptureTest(state: 'waiting' | 'received', detail?: string): string {
  return page({ title: 'Test your setup' }, html`
<div class="card">
  <h1>${state === 'received' ? 'It works' : 'Print one bill'}</h1>
  ${state === 'received'
    ? raw(html`<p>We received a bill from your till just now.</p>
        <p class="muted">${detail ?? ''}</p>
        <a class="btn" href="/console">Go to your console</a>`)
    : raw(html`<p>Ring up anything on your till and print it, exactly as you normally would.
        It should appear here within a few seconds.</p>
        <p class="muted">Nothing about your billing software changes. We read what the printer was already sent.</p>
        <p class="muted">This page refreshes on its own.</p>`)}
</div>
${when(state === 'waiting', '<meta http-equiv="refresh" content="3">')}`);
}
