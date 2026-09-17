#!/usr/bin/env node
import { CaptureAgent } from './agent.js';

/**
 * Agent entrypoint.
 *
 * Onboarding target is "< 30 min, remote" with "no POS-vendor conversation".
 * That means the whole install is: run this, point the POS's printer at this
 * machine, print one bill. There is no configuration file to hand-edit and no
 * site visit.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. Set it from the pairing code in your Billing Hub console.`);
    process.exit(2);
  }
  return value;
}

const agent = new CaptureAgent({
  serverUrl: process.env.BILLING_HUB_URL ?? 'http://localhost:8080',
  terminalId: required('BILLING_HUB_TERMINAL_ID'),
  terminalSecret: required('BILLING_HUB_TERMINAL_SECRET'),
  outletId: required('BILLING_HUB_OUTLET_ID'),
  listenPort: Number(process.env.BILLING_HUB_LISTEN_PORT ?? 9100),
  printerHost: process.env.BILLING_HUB_PRINTER_HOST,
  printerPort: Number(process.env.BILLING_HUB_PRINTER_PORT ?? 9100),
});

const port = await agent.listen();
agent.start();
await agent.heartbeat();

console.log(`Billing Hub agent listening for print jobs on port ${port}.`);
console.log('Point your POS at this machine as its printer. Nothing else changes.');
if (!process.env.BILLING_HUB_PRINTER_HOST) {
  console.log('No BILLING_HUB_PRINTER_HOST set — print jobs are captured but not forwarded to a printer.');
}

const status = setInterval(() => {
  const s = agent.status();
  if (s.pending > 0 || s.failed > 0 || !s.online) {
    console.log(
      `[queue] pending=${s.pending} retrying=${s.failed} rejected=${s.rejected} ` +
      `online=${s.online}${s.oldestPendingAgeMs ? ` oldest=${Math.round(s.oldestPendingAgeMs / 60000)}m` : ''}`,
    );
  }
}, 60_000);
status.unref();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n${signal} received. Flushing the queue before exit — nothing is dropped.`);
    void agent.flush().then(() => agent.stop()).then(() => process.exit(0));
  });
}
