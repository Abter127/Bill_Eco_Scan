import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CaptureAgent } from '../src/agent/agent.js';
import { Outbox, backoffMs } from '../src/agent/queue.js';
import { buildServer } from '../src/api/server.js';
import { escposKot, escposReceipt, escposShiftReport, makeWorld } from './helpers.js';
import * as billsRepo from '../src/db/repo/bills.js';
import * as claimsRepo from '../src/db/repo/claims.js';
import { resolveClaimToken } from '../src/services/claim.js';

/**
 * M-03's acceptance criterion, exercised end to end:
 * "Four-hour outage during peak trade reconciles with zero duplicates and zero
 * losses."
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'billing-hub-agent-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A fetch that talks to an in-process Fastify instance, and can go "offline". */
function makeTransport(app: Awaited<ReturnType<typeof buildServer>>) {
  const state = { online: true, requests: 0 };
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    state.requests++;
    if (!state.online) throw new Error('ECONNREFUSED');
    const res = await app.inject({
      method: (init?.method ?? 'GET') as 'POST',
      url: new URL(String(url)).pathname,
      headers: init?.headers as Record<string, string>,
      payload: init?.body as string | undefined,
    });
    return {
      ok: res.statusCode >= 200 && res.statusCode < 300,
      status: res.statusCode,
      json: async () => res.json(),
    } as Response;
  }) as unknown as typeof fetch;
  return { state, fetchImpl };
}

async function setup() {
  const w = makeWorld();
  const app = await buildServer({ db: w.db });
  const transport = makeTransport(app);
  // A controllable clock, so retry backoff can be waited out in milliseconds
  // instead of minutes.
  const clock = { now: new Date('2026-09-17T09:00:00Z') };
  const agent = new CaptureAgent({
    serverUrl: 'http://test.local',
    terminalId: w.terminalId,
    terminalSecret: w.terminalSecret,
    outletId: w.outletId,
    queuePath: join(dir, 'outbox.sqlite'),
    fetchImpl: transport.fetchImpl,
    now: () => clock.now,
  });

  /** Flushes repeatedly, advancing the clock past each backoff, until drained. */
  const drain = async (maxRounds = 60) => {
    for (let i = 0; i < maxRounds; i++) {
      const status = agent.status();
      if (status.pending === 0 && status.failed === 0) return;
      await agent.flush(200);
      clock.now = new Date(clock.now.getTime() + 10 * 60_000);
    }
  };

  return { w, app, agent, transport, clock, drain };
}

describe('M-03 — a four-hour outage during peak trade', () => {
  it('loses nothing and duplicates nothing', async () => {
    const { w, agent, transport, clock, drain } = await setup();
    const BILLS = 60;
    const countBills = () =>
      w.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM bills').get()!.n;

    // Peak trade with the link down.
    transport.state.online = false;
    agent.setOnline(false);
    for (let i = 0; i < BILLS; i++) {
      agent.capture(escposReceipt({ billNumber: `INV/2026/${1000 + i}`, total: 100 + i }));
    }
    expect(agent.status().pending).toBe(BILLS);

    // Four hours of retrying into a dead link. Nothing sent, nothing lost.
    for (let hour = 0; hour < 4; hour++) {
      await agent.flush(200);
      clock.now = new Date(clock.now.getTime() + 3600_000);
    }
    expect(countBills()).toBe(0);
    expect(agent.status().pending + agent.status().failed).toBe(BILLS);

    // The link comes back and the whole queue drains.
    transport.state.online = true;
    await drain();

    expect(countBills()).toBe(BILLS);              // zero losses
    expect(agent.status().pending).toBe(0);
    expect(agent.status().failed).toBe(0);

    // Replaying the entire queue again creates nothing new.
    await agent.flush(200);
    await agent.flush(200);
    expect(countBills()).toBe(BILLS);              // zero duplicates

    // Each bill kept its own identity rather than collapsing into one.
    const distinct = w.db.prepare<[], { n: number }>(
      'SELECT COUNT(DISTINCT document_number) AS n FROM bills',
    ).get()!.n;
    expect(distinct).toBe(BILLS);

    await agent.stop();
  }, 30_000);

  it('registers a locally-minted claim token so the printed QR still works', async () => {
    const { w, agent, transport, clock, drain } = await setup();

    transport.state.online = false;
    agent.setOnline(false);
    const outcome = agent.capture(escposReceipt({ billNumber: 'INV/2026/9001', total: 500 }));
    expect(outcome.offlineTokens).toBe(1);

    // Read the secret the agent printed on the slip.
    const outbox = new Outbox(join(dir, 'outbox.sqlite'));
    const queued = outbox.due(clock.now, 10)[0]!;
    const printedSecret = queued.offlineClaimTokenSecret!;
    outbox.close();

    // Before reconnect the QR resolves to nothing at all.
    expect(resolveClaimToken(w.db, printedSecret).kind).toBe('unknown');

    transport.state.online = true;
    await drain();

    // After reconnect, the code the customer photographed resolves to their bill.
    const resolved = resolveClaimToken(w.db, printedSecret);
    expect(['valid', 'expired']).toContain(resolved.kind);
    expect(claimsRepo.findToken(w.db, printedSecret)!.offlineSigned).toBe(true);

    await agent.stop();
  }, 20_000);

  it('never sends a kitchen ticket or a shift report, online or off', async () => {
    const { w, agent, transport } = await setup();

    const outcome = agent.capture(Buffer.concat([
      escposKot(),
      escposReceipt({ billNumber: 'INV/2026/5005', total: 250 }),
      escposShiftReport(),
    ]));

    expect(outcome.fragments).toBe(3);
    expect(outcome.enqueued).toBe(1);
    expect(outcome.quarantinedLocally).toBe(2);

    transport.state.online = true;
    await agent.flush(10);
    expect(w.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM bills').get()!.n).toBe(1);

    await agent.stop();
  });

  it('survives a restart with the queue intact', async () => {
    const { agent, transport, clock } = await setup();
    transport.state.online = false;
    agent.setOnline(false);
    agent.capture(escposReceipt({ billNumber: 'INV/2026/7007', total: 700 }));
    await agent.stop(); // simulates the shop losing power

    const reopened = new Outbox(join(dir, 'outbox.sqlite'));
    expect(reopened.stats().pending).toBe(1);
    expect(reopened.due(clock.now, 10)[0]!.payload.documentNumber).toBe('INV/2026/7007');
    reopened.close();
  });

  it('never lets a capture failure reach the till', async () => {
    const { agent } = await setup();
    // Garbage on the wire must not throw into the print path.
    expect(() => agent.capture(Buffer.from([0x00, 0xff, 0x1b, 0x99]))).not.toThrow();
    expect(() => agent.capture(Buffer.alloc(0))).not.toThrow();
    await agent.stop();
  });
});

describe('the outbox itself', () => {
  it('stops retrying a payload the server will never accept', () => {
    const outbox = new Outbox(':memory:');
    const item = outbox.enqueue({
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
      outletId: 'o', terminalId: 't', documentType: 'tax_invoice', documentNumber: 'X',
      terminalTime: new Date().toISOString(), documentDateKey: null, currency: 'INR',
      subtotalMinor: null, taxTotalMinor: null, discountTotalMinor: null, roundOffMinor: null,
      grandTotalMinor: 100, paymentMethod: null, buyerGstin: null, placeOfSupply: null,
      lines: [], rawSourceRef: null, enqueuedAt: null, links: [],
    });

    outbox.markRejected(item.id, 'server rejected this bill with 400');
    expect(outbox.due(new Date(), 10)).toHaveLength(0);
    expect(outbox.stats().rejected).toBe(1);
    expect(outbox.stats().pending).toBe(0);
    outbox.close();
  });

  it('backs off exponentially with full jitter, capped', () => {
    // With random() pinned to 1 the jitter window's upper bound is visible.
    expect(backoffMs(1, 1000, 300_000, () => 1)).toBe(2000);
    expect(backoffMs(4, 1000, 300_000, () => 1)).toBe(16_000);
    expect(backoffMs(30, 1000, 300_000, () => 1)).toBe(300_000); // capped
    // Jitter means the actual delay is somewhere in [0, bound).
    expect(backoffMs(4, 1000, 300_000, () => 0)).toBe(0);
  });

  it('keeps the same idempotency key across every retry', () => {
    const outbox = new Outbox(':memory:');
    const payload = {
      idempotencyKey: '22222222-2222-4222-8222-222222222222',
      outletId: 'o', terminalId: 't', documentType: 'tax_invoice' as const, documentNumber: 'Y',
      terminalTime: new Date().toISOString(), documentDateKey: null, currency: 'INR',
      subtotalMinor: null, taxTotalMinor: null, discountTotalMinor: null, roundOffMinor: null,
      grandTotalMinor: 100, paymentMethod: null, buyerGstin: null, placeOfSupply: null,
      lines: [], rawSourceRef: null, enqueuedAt: null, links: [],
    };
    const item = outbox.enqueue(payload);
    for (let i = 0; i < 5; i++) outbox.markFailed(item.id, 'network', new Date(0));
    expect(outbox.get(item.id)!.idempotencyKey).toBe(payload.idempotencyKey);
    expect(outbox.get(item.id)!.attempts).toBe(5);
    outbox.close();
  });
});
