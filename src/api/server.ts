import Fastify, { LogController, type FastifyInstance } from 'fastify';
import type { Db } from '../db/sqlite.js';
import { registerMerchantRoutes } from './routes/merchant.js';
import { registerClaimRoutes } from './routes/claim.js';
import { registerCustomerRoutes } from './routes/customer.js';
import { FixtureOcrAdapter } from '../services/ocr/fixture-adapter.js';
import type { OcrAdapter } from '../services/ocr/types.js';
import { page } from '../web/layout.js';
import { html } from '../web/html.js';

export interface ServerOptions {
  db: Db;
  ocr?: OcrAdapter;
  logger?: boolean;
}

export async function buildServer(opts: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    // The claim page URL *is* the bearer token, so per-request logging is off:
    // keeping it out of access logs is cheaper than redacting it later.
    //
    // Set via `logController` rather than the top-level `disableRequestLogging`,
    // which Fastify 5 deprecates (with a warning on every boot) and removes in 6.
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 8 * 1024 * 1024,
    trustProxy: true,
  });

  // Raw ESC/POS bytes arrive as application/octet-stream.
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body),
  );
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'strict-origin');
    reply.header(
      'Content-Security-Policy',
      // No script anywhere on these pages, so the policy can say so outright.
      "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    return payload;
  });

  app.setErrorHandler((rawError, req, reply) => {
    const err = rawError as Error & { statusCode?: number };
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    const wantsHtml = String(req.headers.accept ?? '').includes('text/html');
    if (wantsHtml) {
      return reply.code(status).type('text/html; charset=utf-8').send(
        page({ title: 'Something went wrong' }, html`<div class="card">
          <h1>Something went wrong</h1>
          <p>${status === 401 ? 'You need to sign in to see this.' : 'We couldn’t load that just now. Your bills are safe — try again in a moment.'}</p>
        </div>`),
      );
    }
    return reply.code(status).send({
      error: status === 401 ? 'unauthorised' : status >= 500 ? 'internal_error' : 'bad_request',
      message: status >= 500 ? undefined : err.message,
    });
  });

  app.get('/health', async () => ({ ok: true, at: new Date().toISOString() }));

  const ocr = opts.ocr ?? new FixtureOcrAdapter();
  registerMerchantRoutes(app, opts.db);
  registerClaimRoutes(app, opts.db);
  registerCustomerRoutes(app, opts.db, ocr);

  return app;
}
