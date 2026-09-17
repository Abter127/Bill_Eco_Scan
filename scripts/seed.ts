import { openDb } from '../src/db/sqlite.js';
import * as registry from '../src/db/repo/registry.js';
import * as people from '../src/db/repo/people.js';
import { ingestPrintStream } from '../src/services/issuance.js';
import { claimBill } from '../src/services/claim.js';
import { newClaimTokenSecret } from '../src/core/ids.js';

/**
 * Seeds a demo outlet, a till and a few bills so the claim page and console
 * have something real to render. Run with `npm run seed`.
 */

const ESC = Buffer.from([0x1b, 0x40]);
const CUT = Buffer.from([0x1d, 0x56, 0x42, 0x00]);
const line = (s: string) => Buffer.from(`${s}\n`, 'utf8');
const pad = (l: string, r: string, w = 40) => `${l}${' '.repeat(Math.max(1, w - l.length - r.length))}${r}`;

function receipt(opts: {
  billNo: string; date: string; items: Array<[string, number]>; tax: number; total: number;
}): Buffer {
  return Buffer.concat([
    ESC,
    line('Sharma General Store'),
    line('Sector 17, Chandigarh'),
    line('GSTIN: 27AAPFU0939F1ZV'),
    line('TAX INVOICE'),
    line(`Bill No: ${opts.billNo}`),
    line(`Date: ${opts.date}  Time: 19:42`),
    line('-'.repeat(40)),
    ...opts.items.map(([name, amount]) => line(pad(name, amount.toFixed(2)))),
    line('-'.repeat(40)),
    line(pad('CGST 2.5%', (opts.tax / 2).toFixed(2))),
    line(pad('SGST 2.5%', (opts.tax / 2).toFixed(2))),
    line(pad('GRAND TOTAL', opts.total.toFixed(2))),
    line(pad('Paid by', 'UPI')),
    line('Thank you! Visit again'),
    CUT,
  ]);
}

const db = openDb();

const merchant = registry.createMerchant(db, {
  gstin: '27AAPFU0939F1ZV',
  legalName: 'SHARMA ENTERPRISES PRIVATE LIMITED',
  tradeName: 'Sharma General Store',
  category: 'grocery',
  returnWindowDays: 7,
  returnPolicySource: 'Shop’s stated return policy: 7 days with the bill',
});
const outlet = registry.createOutlet(db, merchant.id, 'Sector 17', 'Chandigarh');
const terminalSecret = newClaimTokenSecret();
const terminal = registry.createTerminal(db, outlet.id, 'Till 1', terminalSecret);
const { account } = people.createAccount(db, { phoneE164: '+919812345678' });

const ctx = { terminalId: terminal.id, outletId: outlet.id, merchantId: merchant.id };
const today = new Date();
const dateOf = (daysAgo: number) => {
  const d = new Date(today.getTime() - daysAgo * 86_400_000);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
};

const seeds = [
  { billNo: 'INV/2026/0417', date: dateOf(1), items: [['Basmati Rice 5kg', 620], ['Toor Dal 1kg', 290]] as Array<[string, number]>, tax: 45.5, total: 955.5 },
  { billNo: 'INV/2026/0402', date: dateOf(9), items: [['Prestige pressure cooker 5L', 2100]] as Array<[string, number]>, tax: 105, total: 2205 },
  { billNo: 'INV/2026/0388', date: dateOf(21), items: [['Steel tiffin', 450], ['Dish soap', 120]] as Array<[string, number]>, tax: 28.5, total: 598.5 },
];

let lastToken: string | undefined;
for (const [i, seed] of seeds.entries()) {
  const { results } = ingestPrintStream(db, ctx, receipt(seed));
  const created = results.find((r) => r.outcome === 'created');
  if (!created?.claimTokenSecret) continue;

  if (i === 0) {
    lastToken = created.claimTokenSecret; // leave the newest one unclaimed
  } else {
    claimBill(db, { secret: created.claimTokenSecret, accountId: account.id });
  }
}

registry.recordHeartbeat(db, terminal.id);

console.log(`
Seeded.

  Merchant   ${merchant.tradeName} (${merchant.gstin})
  Outlet     ${outlet.id}
  Terminal   ${terminal.id}
  Secret     ${terminalSecret}

Start the server with:   npm run dev

Then open:
  Claim page     http://localhost:8080/c/${lastToken ?? '<token>'}
  Merchant console  (send the terminal headers)
    curl -s http://localhost:8080/console/${outlet.id} \\
      -H 'x-terminal-id: ${terminal.id}' \\
      -H 'x-terminal-secret: ${terminalSecret}'
`);

db.close();
