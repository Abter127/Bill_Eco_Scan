import { esc } from './html.js';

/**
 * The page shell.
 *
 * Critical CSS is inlined because a blocking stylesheet round-trip on a cold
 * 4G device is most of the 3-second budget in C-01. There is no webfont for the
 * same reason — a system stack renders Devanagari, Gurmukhi and Tamil on the
 * devices this launches on, and a webfont would not.
 */

const CSS = `
:root{
  --bg:#fbfaf8; --surface:#fff; --ink:#15130f; --muted:#67625a; --line:#e6e2db;
  --accent:#1b5e4b; --accent-ink:#fff; --flag:#8a5a00; --flag-bg:#fdf6e6;
  --warn:#8a2d20; --warn-bg:#fdf0ee; --ok:#1b5e4b; --ok-bg:#eef5f2;
  --radius:12px;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#131211; --surface:#1c1a18; --ink:#f2efe9; --muted:#a49d93; --line:#2e2b27;
    --accent:#6fd2b0; --accent-ink:#0f1f1a; --flag:#e0b25f; --flag-bg:#2a2313;
    --warn:#f0a396; --warn-bg:#2d1a17; --ok:#6fd2b0; --ok-bg:#16241f;
  }
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  background:var(--bg); color:var(--ink);
  font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans","Noto Sans Devanagari","Noto Sans Tamil",Ubuntu,sans-serif;
  -webkit-text-size-adjust:100%;
}
.wrap{max-width:560px;margin:0 auto;padding:16px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:20px;margin-bottom:12px}
h1{font-size:22px;line-height:1.25;margin:0 0 4px}
h2{font-size:15px;margin:20px 0 8px;letter-spacing:.02em;text-transform:uppercase;color:var(--muted)}
p{margin:0 0 10px}
.muted{color:var(--muted);font-size:14px}
.total{font-size:34px;font-weight:700;letter-spacing:-.02em;margin:4px 0 2px;font-variant-numeric:tabular-nums}
.meta{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:13px;color:var(--muted);margin-top:6px}
.badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:4px 9px;border-radius:999px;border:1px solid var(--line);background:var(--bg)}
.badge.verified{border-color:var(--accent);color:var(--accent)}
.badge.downgraded,.badge.flag{border-color:var(--flag);color:var(--flag);background:var(--flag-bg)}
table{width:100%;border-collapse:collapse;font-size:15px}
th{text-align:left;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.03em;color:var(--muted);padding:0 0 6px}
td{padding:9px 0;border-top:1px solid var(--line);vertical-align:top}
td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
tr.returned td{text-decoration:line-through;color:var(--muted)}
.rows{list-style:none;margin:0;padding:0}
.rows li{display:flex;justify-content:space-between;gap:16px;padding:7px 0;border-top:1px solid var(--line);font-size:15px}
.rows li.grand{font-weight:700;font-size:17px;border-top-width:2px}
.note{border-radius:10px;padding:12px 14px;font-size:14px;margin-bottom:10px}
.note.flag{background:var(--flag-bg);color:var(--flag);border:1px solid color-mix(in srgb,var(--flag) 35%,transparent)}
.note.warn{background:var(--warn-bg);color:var(--warn);border:1px solid color-mix(in srgb,var(--warn) 35%,transparent)}
.note.ok{background:var(--ok-bg);color:var(--ok);border:1px solid color-mix(in srgb,var(--ok) 35%,transparent)}
.btn{display:block;width:100%;text-align:center;padding:14px 18px;border-radius:10px;border:0;
  background:var(--accent);color:var(--accent-ink);font-size:16px;font-weight:600;cursor:pointer;text-decoration:none;margin-bottom:8px}
.btn.secondary{background:transparent;color:var(--ink);border:1px solid var(--line);font-weight:500}
.field{display:block;width:100%;padding:12px 14px;font-size:16px;border:1px solid var(--line);
  border-radius:10px;background:var(--surface);color:var(--ink);margin-bottom:10px}
.countdown{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.countdown strong{font-size:20px}
.flagged{border:1px dashed var(--flag);background:var(--flag-bg);color:var(--flag);
  border-radius:8px;padding:8px 10px;margin:6px 0;font-size:14px;width:100%;text-align:left;cursor:pointer}
.qr{display:block;margin:0 auto;width:200px;height:200px}
.stat{display:flex;justify-content:space-between;align-items:baseline;padding:10px 0;border-top:1px solid var(--line)}
.stat b{font-size:22px;font-variant-numeric:tabular-nums}
.bar{height:6px;border-radius:3px;background:var(--line);overflow:hidden;margin-top:6px}
.bar span{display:block;height:100%;background:var(--accent)}
footer{padding:20px 4px 40px;font-size:12px;color:var(--muted);text-align:center}
a{color:var(--accent)}
`.replace(/\n\s*/g, '');

export interface LayoutOptions {
  title: string;
  /** Sensitive bills must not put the merchant name in the tab title either. */
  suppressTitleDetail?: boolean;
  bodyClass?: string;
}

export function page(opts: LayoutOptions, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="referrer" content="strict-origin">
<meta name="robots" content="noindex,nofollow">
<meta name="color-scheme" content="light dark">
<title>${esc(opts.title)}</title>
<style>${CSS}</style>
</head><body${opts.bodyClass ? ` class="${esc(opts.bodyClass)}"` : ''}>
<div class="wrap">${body}</div>
<footer>Billing Hub — your bill, in the format you chose.</footer>
</body></html>`;
}
