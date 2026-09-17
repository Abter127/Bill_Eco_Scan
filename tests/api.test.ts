import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { ingestBill } from '../src/services/issuance.js';
import { claimBill } from '../src/services/claim.js';
import { signSession } from '../src/api/auth.js';
import { billPayloadSchema } from '../src/core/schema.js';
import { newIdempotencyKey } from '../src/core/ids.js';
import { escposReceipt, escposKot, makeWorld } from './helpers.js';

/**
 * End-to-end through HTTP: J1 at the counter, J3 under pressure, and the
 * merchant console — checking the surfaces, not just the services behind them.
 */

/**
 * Bills here are created through HTTP, which stamps them with the real clock,
 * so this suite works in real time rather than against a pinned date.
 */
const nowish = () => new Date();

async function world() {
  const w = makeWorld();
  const app = await buildServer({ db: w.db });
  const terminalHeaders = {
    'x-terminal-id': w.terminalId,
    'x-terminal-secret': w.terminalSecret,
    'content-type': 'application/json',
  };
  return { w, app, terminalHeaders };
}

function session(accountId: string) {
  return { cookie: `bh_session=${signSession(accountId)}` };
}

function payload(w: ReturnType<typeof makeWorld>, over: Record<string, unknown> = {}) {
  return billPayloadSchema.parse({
    idempotencyKey: newIdempotencyKey(),
    outletId: w.outletId, terminalId: w.terminalId, terminalTime: nowish().toISOString(),
    documentNumber: `INV/2026/${Math.floor(Math.random() * 100000)}`,
    documentDateKey: nowish().toISOString().slice(0, 10),
    grandTotalMinor: 95500,
    lines: [{ lineNo: 0, description: 'Electric kettle', qty: 1, lineTotalMinor: 95500 }],
    ...over,
  });
}

describe('the agent-facing API', () => {
  it('rejects an unauthenticated terminal', async () => {
    const { w, app } = await world();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/bills',
      headers: { 'content-type': 'application/json' },
      payload: payload(w),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a wrong terminal secret', async () => {
    const { w, app } = await world();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/bills',
      headers: { 'x-terminal-id': w.terminalId, 'x-terminal-secret': 'wrong', 'content-type': 'application/json' },
      payload: payload(w),
    });
    expect(res.statusCode).toBe(401);
  });

  it('creates on first post and returns 200 on replay', async () => {
    const { w, app, terminalHeaders } = await world();
    const body = payload(w);

    const first = await app.inject({ method: 'POST', url: '/api/v1/bills', headers: terminalHeaders, payload: body });
    expect(first.statusCode).toBe(201);
    expect(first.json().claimTokenSecret).toBeTruthy();

    const replay = await app.inject({ method: 'POST', url: '/api/v1/bills', headers: terminalHeaders, payload: body });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().claimTokenSecret).toBeUndefined();
    expect(w.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM bills').get()!.n).toBe(1);
  });

  it('accepts a raw print stream and quarantines the kitchen ticket', async () => {
    const { w, app, terminalHeaders } = await world();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/print-stream',
      headers: { ...terminalHeaders, 'content-type': 'application/octet-stream' },
      payload: Buffer.concat([escposKot(), escposReceipt({ billNumber: 'INV/2026/1', total: 300 })]),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().quarantined).toBe(1);
    expect(w.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM bills').get()!.n).toBe(1);
  });

  it('rejects an invalid payload with a useful error', async () => {
    const { app, terminalHeaders } = await world();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/bills', headers: terminalHeaders,
      payload: { idempotencyKey: 'not-a-uuid' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_payload');
  });

  it('serves a QR that carries a token, never bill content (E1)', async () => {
    const { app } = await world();
    const res = await app.inject({ method: 'GET', url: '/qr/sometoken.svg' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/svg+xml');
    expect(res.body).toContain('<svg');
    // A 400-line bill would not change this payload at all.
    expect(res.body.length).toBeLessThan(40_000);
  });
});

describe('J1 — the claim page', () => {
  it('paints the bill with no login and offers to keep it afterwards', async () => {
    const { w, app, terminalHeaders } = await world();
    const issued = await app.inject({
      method: 'POST', url: '/api/v1/bills', headers: terminalHeaders, payload: payload(w),
    });
    const token = issued.json().claimTokenSecret as string;

    const page = await app.inject({ method: 'GET', url: `/c/${token}` });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');

    // The bill is on screen.
    expect(page.body).toContain('Sharma General Store');
    expect(page.body).toContain('Electric kettle');
    expect(page.body).toMatch(/955/);
    // And the prompt to keep it comes after it in the document.
    expect(page.body.indexOf('Electric kettle')).toBeLessThan(page.body.indexOf('Keep this bill'));
    // No client bundle to download on a cold 4G device.
    expect(page.body).not.toMatch(/<script/i);
  });

  it('never caches or indexes a bearer-token page', async () => {
    const { w, app, terminalHeaders } = await world();
    const issued = await app.inject({
      method: 'POST', url: '/api/v1/bills', headers: terminalHeaders, payload: payload(w),
    });
    const page = await app.inject({ method: 'GET', url: `/c/${issued.json().claimTokenSecret}` });

    expect(page.headers['cache-control']).toContain('no-store');
    expect(page.body).toContain('noindex');
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.headers['x-frame-options']).toBe('DENY');
  });

  it('answers an expired token with the bill’s identity, never a 404 (#1)', async () => {
    const { w, app } = await world();
    // Issued an hour ago: well past the 15-minute token TTL.
    const anHourAgo = new Date(Date.now() - 3600_000);
    const issued = ingestBill(
      w.db,
      { terminalId: w.terminalId, outletId: w.outletId, merchantId: w.merchantId, now: anHourAgo },
      payload(w, { terminalTime: anHourAgo.toISOString() }),
    );

    const page = await app.inject({ method: 'GET', url: `/c/${issued.claimTokenSecret}` });
    expect(page.statusCode).toBe(200);              // not 404
    expect(page.body).toContain('Your bill is still here');
    expect(page.body).toContain('Sharma General Store');
    expect(page.body).toMatch(/Add this bill/);
  });

  it('offers a way forward for a token we never issued', async () => {
    const { app } = await world();
    const page = await app.inject({ method: 'GET', url: '/c/nonsense' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toMatch(/Photograph your bill/i);
  });

  it('claims through the form and lands on the designed one-bill screen (E8)', async () => {
    const { w, app, terminalHeaders } = await world();
    const issued = await app.inject({
      method: 'POST', url: '/api/v1/bills', headers: terminalHeaders, payload: payload(w),
    });
    const token = issued.json().claimTokenSecret as string;

    const claimed = await app.inject({
      method: 'POST', url: `/c/${token}/claim`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'phone=9812345678',
    });

    expect(claimed.statusCode).toBe(200);
    expect(claimed.headers['set-cookie']).toMatch(/bh_session=/);
    expect(String(claimed.headers['set-cookie'])).toContain('HttpOnly');
    // A list of one looks broken, so the one-bill state is its own screen.
    expect(claimed.body).toContain('What happens next');
    expect(claimed.body).toMatch(/Photograph an old receipt/i);
  });

  it('rejects a malformed phone number without creating an account', async () => {
    const { w, app, terminalHeaders } = await world();
    const issued = await app.inject({
      method: 'POST', url: '/api/v1/bills', headers: terminalHeaders, payload: payload(w),
    });
    const before = w.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM accounts').get()!.n;

    const res = await app.inject({
      method: 'POST', url: `/c/${issued.json().claimTokenSecret}/claim`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'phone=12345',
    });
    expect(res.statusCode).toBe(400);
    expect(w.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM accounts').get()!.n).toBe(before);
  });
});

describe('J3 — finding a bill under pressure', () => {
  it('answers a half-memory search and says what it understood', async () => {
    const { w, app, terminalHeaders } = await world();
    for (const desc of ['Prestige pressure cooker', 'Basmati rice 5kg', 'Steel tiffin']) {
      const issued = await app.inject({
        method: 'POST', url: '/api/v1/bills', headers: terminalHeaders,
        payload: payload(w, {
          grandTotalMinor: desc.includes('cooker') ? 210000 : 30000,
          lines: [{ lineNo: 0, description: desc, qty: 1, lineTotalMinor: desc.includes('cooker') ? 210000 : 30000 }],
        }),
      });
      claimBill(w.db, { secret: issued.json().claimTokenSecret as string, accountId: w.accountId });
    }

    const monthName = nowish().toLocaleString('en-GB', { month: 'long', timeZone: 'Asia/Kolkata' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/bills?q=' + encodeURIComponent(`cooker around 2000 in ${monthName}`),
      headers: session(w.accountId),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.understood.join(' ')).toContain(monthName);
    expect(body.results[0].bill.lines[0].description).toBe('Prestige pressure cooker');
    expect(body.results[0].itemMatch).toBe(true);
  });

  it('requires a session for the history', async () => {
    const { app } = await world();
    expect((await app.inject({ method: 'GET', url: '/api/v1/bills' })).statusCode).toBe(401);
  });

  it('hides search over a short history (E8)', async () => {
    const { w, app, terminalHeaders } = await world();
    const issued = await app.inject({
      method: 'POST', url: '/api/v1/bills', headers: terminalHeaders, payload: payload(w),
    });
    claimBill(w.db, { secret: issued.json().claimTokenSecret as string, accountId: w.accountId });

    const res = await app.inject({ method: 'GET', url: '/api/v1/bills', headers: session(w.accountId) });
    expect(res.json().showSearch).toBe(false);
    expect(res.json().total).toBe(1);
  });

  it('serves a shareable PDF of a bill the caller owns, and only that', async () => {
    const { w, app, terminalHeaders } = await world();
    const issued = await app.inject({
      method: 'POST', url: '/api/v1/bills', headers: terminalHeaders, payload: payload(w),
    });
    const billId = issued.json().billId as string;
    claimBill(w.db, { secret: issued.json().claimTokenSecret as string, accountId: w.accountId });

    const mine = await app.inject({
      method: 'GET', url: `/api/v1/bills/${billId}/pdf`, headers: session(w.accountId),
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.headers['content-type']).toBe('application/pdf');
    expect(mine.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    const stranger = await app.inject({
      method: 'GET', url: `/api/v1/bills/${billId}/pdf`, headers: session('someone-else'),
    });
    expect(stranger.statusCode).toBe(404);
  });
});

describe('J4 — verifying a return at the counter', () => {
  it('returns the verdict and nothing about the customer', async () => {
    const { w, app, terminalHeaders } = await world();
    const issued = await app.inject({
      method: 'POST', url: '/api/v1/bills', headers: terminalHeaders, payload: payload(w),
    });
    const billId = issued.json().billId as string;
    claimBill(w.db, { secret: issued.json().claimTokenSecret as string, accountId: w.accountId });

    const res = await app.inject({ method: 'GET', url: `/api/v1/bills/${billId}/verify` });
    expect(res.statusCode).toBe(200);
    expect(res.json().verification.authentic).toBe(true);
    expect(res.body).not.toContain(w.accountId);
  });

  it('refuses verification by an unrelated merchant', async () => {
    const { w, app, terminalHeaders } = await world();
    const issued = await app.inject({
      method: 'POST', url: '/api/v1/bills', headers: terminalHeaders, payload: payload(w),
    });
    const res = await app.inject({
      method: 'GET', url: `/api/v1/bills/${issued.json().billId}/verify?merchantId=someone-else`,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('M-04 — the merchant console', () => {
  it('renders claim-rate coaching and no customer column', async () => {
    const { w, app, terminalHeaders } = await world();
    for (let i = 0; i < 5; i++) {
      await app.inject({ method: 'POST', url: '/api/v1/bills', headers: terminalHeaders, payload: payload(w) });
    }

    const res = await app.inject({
      method: 'GET', url: `/console/${w.outletId}`,
      headers: { 'x-terminal-id': w.terminalId, 'x-terminal-secret': w.terminalSecret },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Bills captured');
    expect(res.body).toMatch(/can’t tell you who kept it/i);
    expect(res.body).not.toContain(w.accountId);
  });

  it('refuses a console for another outlet', async () => {
    const { w, app } = await world();
    const res = await app.inject({
      method: 'GET', url: '/console/some-other-outlet',
      headers: { 'x-terminal-id': w.terminalId, 'x-terminal-secret': w.terminalSecret },
    });
    expect(res.statusCode).toBe(401);
  });

  it('exposes the identity audit as an endpoint an auditor can call', async () => {
    const { w, app, terminalHeaders } = await world();
    await app.inject({ method: 'POST', url: '/api/v1/bills', headers: terminalHeaders, payload: payload(w) });

    const res = await app.inject({
      method: 'GET', url: `/api/v1/console/${w.outletId}/identity-audit`,
      headers: { 'x-terminal-id': w.terminalId, 'x-terminal-secret': w.terminalSecret },
    });
    expect(res.json().passes).toBe(true);
    expect(res.json().identityFieldsFound).toEqual([]);
  });

  it('proves capture works during onboarding (E8)', async () => {
    const { w, app, terminalHeaders } = await world();
    const headers = { 'x-terminal-id': w.terminalId, 'x-terminal-secret': w.terminalSecret };

    const waiting = await app.inject({ method: 'GET', url: `/console/${w.outletId}/test`, headers });
    expect(waiting.body).toContain('Print one bill');

    await app.inject({ method: 'POST', url: '/api/v1/bills', headers: terminalHeaders, payload: payload(w) });
    const received = await app.inject({ method: 'GET', url: `/console/${w.outletId}/test`, headers });
    expect(received.body).toContain('It works');
  });
});

describe('T-03 — rights endpoints over HTTP', () => {
  it('publishes the consent notice without a session', async () => {
    const { app } = await world();
    const res = await app.inject({ method: 'GET', url: '/api/v1/consent-notice' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.length).toBeGreaterThan(3);
  });

  it('returns an access package and logs the access', async () => {
    const { w, app } = await world();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/dpdp/access', headers: session(w.accountId),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().package.retentionDisclosure).toBeTruthy();

    const log = await app.inject({ method: 'GET', url: '/api/v1/me/access-log', headers: session(w.accountId) });
    expect(log.json().entries.map((e: { action: string }) => e.action)).toContain('access_package_generated');
  });

  it('rejects an unknown rights request kind', async () => {
    const { w, app } = await world();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/dpdp/nonsense', headers: session(w.accountId),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('health and errors', () => {
  it('serves health', async () => {
    const { app } = await world();
    expect((await app.inject({ method: 'GET', url: '/health' })).json().ok).toBe(true);
  });

  it('renders an HTML error page to a browser and JSON to a client', async () => {
    const { app } = await world();
    const html = await app.inject({
      method: 'GET', url: '/api/v1/bills', headers: { accept: 'text/html' },
    });
    expect(html.statusCode).toBe(401);
    expect(html.body).toContain('sign in');

    const json = await app.inject({ method: 'GET', url: '/api/v1/bills' });
    expect(json.json().error).toBe('unauthorised');
  });
});

describe('E6 — claim-token enumeration is rate limited', () => {
  it('starts refusing a flood of guesses from one client', async () => {
    const { app } = await world();
    let limited = false;
    for (let i = 0; i < 60; i++) {
      const res = await app.inject({
        method: 'GET', url: `/c/guess-${i}`,
        headers: { 'x-forwarded-for': '203.0.113.9' },
      });
      if (res.statusCode === 429) { limited = true; break; }
    }
    expect(limited).toBe(true);
  });
});

async function close(app: FastifyInstance) {
  await app.close();
}
void close;
