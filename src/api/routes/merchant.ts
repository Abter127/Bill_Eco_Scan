import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import type { Db } from '../../db/sqlite.js';
import { billPayloadSchema } from '../../core/schema.js';
import { localDateKey } from '../../core/time.js';
import * as registry from '../../db/repo/registry.js';
import * as ledgers from '../../db/repo/ledgers.js';
import { ingestBill, ingestPrintStream, heartbeat } from '../../services/issuance.js';
import { consoleSummary, merchantBills, auditMerchantSurfaces, velocityAnomalies, coercionSignals } from '../../services/metrics.js';
import { renderConsole, renderCaptureTest } from '../../web/console-page.js';
import { ingestLimiter } from '../ratelimit.js';

/**
 * Merchant- and agent-facing routes.
 *
 * The agent authenticates per terminal, so a compromised till cannot post bills
 * for another outlet, and M-04's credential rotation has something to rotate.
 */

interface TerminalAuth {
  terminalId: string;
  outletId: string;
  merchantId: string;
}

function authenticate(db: Db, headers: Record<string, unknown>): TerminalAuth | null {
  const terminalId = String(headers['x-terminal-id'] ?? '');
  const secret = String(headers['x-terminal-secret'] ?? '');
  if (!terminalId || !secret) return null;

  const terminal = registry.authenticateTerminal(db, terminalId, secret);
  if (!terminal) return null;
  const outlet = registry.getOutlet(db, terminal.outletId);
  if (!outlet) return null;
  return { terminalId: terminal.id, outletId: outlet.id, merchantId: outlet.merchantId };
}

export function registerMerchantRoutes(app: FastifyInstance, db: Db): void {
  /**
   * M-01 / M-03: the agent posts a structured bill with a client-generated
   * idempotency key. Replays return the original outcome.
   */
  app.post('/api/v1/bills', async (req, reply) => {
    const auth = authenticate(db, req.headers as Record<string, unknown>);
    if (!auth) return reply.code(401).send({ error: 'terminal_auth_failed' });

    if (!ingestLimiter.take(auth.terminalId)) {
      return reply
        .code(429)
        .header('Retry-After', String(ingestLimiter.retryAfterSeconds(auth.terminalId)))
        .send({ error: 'rate_limited' });
    }

    const parsed = billPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_payload', detail: parsed.error.flatten() });
    }

    // M-03: a token the agent minted and showed the customer during an outage
    // travels beside the payload. `billPayloadSchema` strips unknown keys, so
    // it is read from the raw body.
    const offline = (req.body as { offlineClaimToken?: { secret?: string; issuedAt?: string } })
      ?.offlineClaimToken;
    const offlineClaimToken =
      offline?.secret && offline.issuedAt
        ? { secret: offline.secret, issuedAt: offline.issuedAt }
        : undefined;

    const result = ingestBill(
      db,
      {
        terminalId: auth.terminalId,
        outletId: auth.outletId,
        merchantId: auth.merchantId,
        printerFailed: req.headers['x-printer-failed'] === 'true',
        offlineSigned: req.headers['x-offline-signed'] === 'true',
      },
      parsed.data,
      undefined,
      { provenance: 'print_stream', offlineClaimToken },
    );

    // 201 only when this call actually created the bill. A replay of the same
    // idempotency key is a 200, so the agent can tell them apart from the
    // status line alone.
    return reply
      .code(result.outcome === 'created' && !result.replayed ? 201 : 200)
      .send(result);
  });

  /** M-01: raw ESC/POS bytes, framed and classified server-side. */
  app.post('/api/v1/print-stream', async (req, reply) => {
    const auth = authenticate(db, req.headers as Record<string, unknown>);
    if (!auth) return reply.code(401).send({ error: 'terminal_auth_failed' });
    if (!ingestLimiter.take(auth.terminalId)) return reply.code(429).send({ error: 'rate_limited' });

    const body = req.body;
    const bytes = Buffer.isBuffer(body)
      ? body
      : typeof body === 'string'
        ? Buffer.from(body, 'binary')
        : null;
    if (!bytes) return reply.code(400).send({ error: 'expected_raw_bytes' });

    return reply.send(ingestPrintStream(db, {
      terminalId: auth.terminalId, outletId: auth.outletId, merchantId: auth.merchantId,
    }, bytes));
  });

  /** E1: the heartbeat that makes a capture gap visible in the console. */
  app.post('/api/v1/heartbeat', async (req, reply) => {
    const auth = authenticate(db, req.headers as Record<string, unknown>);
    if (!auth) return reply.code(401).send({ error: 'terminal_auth_failed' });
    heartbeat(db, auth.terminalId);
    return reply.send({ ok: true, at: new Date().toISOString() });
  });

  /**
   * M-02: the QR itself. The payload is a URL carrying a token — never bill
   * content, so a 400-line wholesale bill produces the same small QR as a
   * two-line one (E1).
   */
  app.get<{ Params: { token: string } }>('/qr/:token.svg', async (req, reply) => {
    const base = process.env.BILLING_HUB_PUBLIC_URL ?? 'https://bills.example.in';
    const svg = await QRCode.toString(`${base}/c/${req.params.token}`, {
      type: 'svg', errorCorrectionLevel: 'M', margin: 1, width: 240,
    });
    return reply
      .header('Content-Type', 'image/svg+xml')
      .header('Cache-Control', 'no-store')
      .send(svg);
  });

  // -------------------------------------------------------------------------
  // Console
  // -------------------------------------------------------------------------

  app.get<{ Params: { outletId: string }; Querystring: { from?: string; to?: string } }>(
    '/console/:outletId',
    async (req, reply) => {
      const auth = authenticate(db, req.headers as Record<string, unknown>);
      if (!auth || auth.outletId !== req.params.outletId) {
        return reply.code(401).send('Not authorised for this outlet.');
      }
      const now = new Date();
      const to = req.query.to ?? localDateKey(now);
      const from = req.query.from ?? localDateKey(new Date(now.getTime() - 29 * 86_400_000));

      const summary = consoleSummary(db, req.params.outletId, from, to, now);
      const bills = merchantBills(db, req.params.outletId, from, to);
      const quarantined = ledgers.listQuarantine(db, req.params.outletId);

      return reply.type('text/html; charset=utf-8').send(renderConsole(summary, bills, quarantined));
    },
  );

  app.get<{ Params: { outletId: string }; Querystring: { from?: string; to?: string } }>(
    '/api/v1/console/:outletId',
    async (req, reply) => {
      const auth = authenticate(db, req.headers as Record<string, unknown>);
      if (!auth || auth.outletId !== req.params.outletId) {
        return reply.code(401).send({ error: 'terminal_auth_failed' });
      }
      const now = new Date();
      const to = req.query.to ?? localDateKey(now);
      const from = req.query.from ?? localDateKey(new Date(now.getTime() - 29 * 86_400_000));
      return reply.send({
        summary: consoleSummary(db, req.params.outletId, from, to, now),
        bills: merchantBills(db, req.params.outletId, from, to),
      });
    },
  );

  /**
   * E8 "merchant's first day": a live capture test during onboarding. "Never
   * let the first session end without visible proof it works."
   */
  app.get<{ Params: { outletId: string } }>('/console/:outletId/test', async (req, reply) => {
    const auth = authenticate(db, req.headers as Record<string, unknown>);
    if (!auth || auth.outletId !== req.params.outletId) {
      return reply.code(401).send('Not authorised for this outlet.');
    }
    const recent = db.prepare<[string, string], { id: string; grand_total_minor: number; created_at: string }>(
      'SELECT id, grand_total_minor, created_at FROM bills WHERE outlet_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1',
    ).get(req.params.outletId, new Date(Date.now() - 10 * 60_000).toISOString());

    return reply.type('text/html; charset=utf-8').send(
      recent
        ? renderCaptureTest('received', `₹${(recent.grand_total_minor / 100).toFixed(2)} at ${recent.created_at.slice(11, 16)}`)
        : renderCaptureTest('waiting'),
    );
  });

  /**
   * M-04's acceptance criterion as a live endpoint: an auditor (or the shop
   * owner's own lawyer) can check that no merchant surface can produce a
   * customer identity.
   */
  app.get<{ Params: { outletId: string } }>('/api/v1/console/:outletId/identity-audit', async (req, reply) => {
    const auth = authenticate(db, req.headers as Record<string, unknown>);
    if (!auth || auth.outletId !== req.params.outletId) {
      return reply.code(401).send({ error: 'terminal_auth_failed' });
    }
    const now = new Date();
    const to = localDateKey(now);
    const from = localDateKey(new Date(now.getTime() - 365 * 86_400_000));
    return reply.send(auditMerchantSurfaces(db, req.params.outletId, from, to));
  });

  // -------------------------------------------------------------------------
  // Platform trust-and-safety (E5) — not merchant-visible
  // -------------------------------------------------------------------------

  app.get<{ Querystring: { from?: string; to?: string } }>('/api/v1/internal/anomalies', async (req, reply) => {
    if (req.headers['x-internal-key'] !== process.env.BILLING_HUB_INTERNAL_KEY) {
      return reply.code(401).send({ error: 'unauthorised' });
    }
    const now = new Date();
    const to = req.query.to ?? localDateKey(now);
    const from = req.query.from ?? localDateKey(new Date(now.getTime() - 29 * 86_400_000));
    return reply.send({
      fakeMerchantSignals: velocityAnomalies(db, from, to, now),
      coercionSignals: coercionSignals(db, from, to),
    });
  });
}
