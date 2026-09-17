import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../../db/sqlite.js';
import { toDecimalString, money } from '../../core/money.js';
import * as billsRepo from '../../db/repo/bills.js';
import * as claimsRepo from '../../db/repo/claims.js';
import * as people from '../../db/repo/people.js';
import * as ledgers from '../../db/repo/ledgers.js';
import { resolveClaimToken, claimBill, retroactiveClaim } from '../../services/claim.js';
import { buildBillView } from '../../services/billview.js';
import { renderClaimPage, renderFirstBillState } from '../../web/claim-page.js';
import { page } from '../../web/layout.js';
import { html } from '../../web/html.js';
import { signSession, sessionCookie, verifySession, readCookie } from '../auth.js';
import { claimLimiter, accountLimiter } from '../ratelimit.js';

/**
 * The claim surface (C-01, C-03, journey J1).
 *
 * Every response here is HTML, served without a client bundle, and every
 * failure path lands on a page that offers a way forward. There is no 404 for a
 * token we issued.
 */

function currentAccount(req: FastifyRequest): string | null {
  const cookie = readCookie(req.headers.cookie, 'bh_session');
  return verifySession(cookie)?.accountId ?? null;
}

function clientKey(req: FastifyRequest): string {
  return req.ip || 'unknown';
}

export function registerClaimRoutes(app: FastifyInstance, db: Db): void {
  /** J1 step 4: the bill on screen, no install, no login. */
  app.get<{ Params: { token: string } }>('/c/:token', async (req, reply) => {
    if (!claimLimiter.take(clientKey(req))) {
      return reply.code(429).type('text/html; charset=utf-8').send(
        page({ title: 'One moment' }, html`<div class="card"><h1>One moment</h1>
          <p>Too many attempts from this connection. Wait a few seconds and reload — your bill is not going anywhere.</p></div>`),
      );
    }

    const resolution = resolveClaimToken(db, req.params.token, {
      viewerAccountId: currentAccount(req),
    });

    // A token page is never cached: it is a bearer credential, and a shared
    // device must not render it from history.
    return reply
      .header('Cache-Control', 'no-store, private')
      .type('text/html; charset=utf-8')
      .send(renderClaimPage(resolution, req.params.token));
  });

  /** E2: second factor on a high-value bill, before the bill is shown. */
  app.post<{ Params: { token: string }; Body: { secondFactor?: string } }>(
    '/c/:token/verify',
    async (req, reply) => {
      if (!claimLimiter.take(clientKey(req), Date.now(), 3)) {
        return reply.code(429).send('Too many attempts.');
      }
      const token = claimsRepo.findToken(db, req.params.token);
      const bill = token ? billsRepo.getBill(db, token.billId) : null;
      if (!token || !bill) {
        return reply.redirect(`/c/${req.params.token}`, 303);
      }

      const expected = toDecimalString(money(bill.grandTotalMinor, bill.currency)).replace(/\D/g, '').slice(-4);
      const given = (req.body?.secondFactor ?? '').replace(/\D/g, '').slice(-4);
      if (given !== expected) {
        ledgers.logAccess(db, {
          billId: bill.id, actorType: 'system', actorId: clientKey(req),
          action: 'claim_failed', reason: 'second factor mismatch', visibleToOwner: false,
        });
        return reply.type('text/html; charset=utf-8').send(
          page({ title: 'That didn’t match' }, html`<div class="card">
            <h1>That didn’t match</h1>
            <p>Check the last 4 digits of the total printed on your bill and try again.</p>
            <form method="post" action="/c/${req.params.token}/verify">
              <input class="field" type="text" name="secondFactor" inputmode="numeric" maxlength="4"
                     placeholder="Last 4 digits of the total" aria-label="Last 4 digits of the total" required>
              <button class="btn" type="submit">Show my bill</button>
            </form></div>`),
        );
      }

      return reply
        .header('Cache-Control', 'no-store, private')
        .type('text/html; charset=utf-8')
        .send(renderClaimPage(
          { ...resolveClaimToken(db, req.params.token), requiresSecondFactor: false, secondFactorPrompt: null },
          req.params.token,
        ));
    },
  );

  /** J1 step 5: account creation, offered after the bill is on screen. */
  app.post<{ Params: { token: string }; Body: { phone?: string; scannedAt?: string } }>(
    '/c/:token/claim',
    async (req, reply) => {
      const phone = normalisePhone(req.body?.phone);
      if (!phone) return badRequest(reply, 'Enter a valid 10-digit mobile number.');
      if (!accountLimiter.take(clientKey(req))) {
        return reply.code(429).send('Too many attempts. Try again shortly.');
      }

      // E2: phone is a lookup key, never an identity, and a match never binds
      // historical bills — only this one.
      const existing = people.findAccountByPhone(db, phone);
      const accountId = existing?.id ?? people.createAccount(db, { phoneE164: phone }).account.id;

      const result = claimBill(db, {
        secret: req.params.token,
        accountId,
        scannedAt: req.body?.scannedAt ?? null,
      });

      if (!result.ok) {
        return reply.type('text/html; charset=utf-8').send(
          page({ title: 'We couldn’t add that bill' }, html`<div class="card">
            <h1>We couldn’t add that bill</h1>
            <p>${result.message}</p>
            ${result.nextAction === 'retroactive_claim'
              ? html`<a class="btn" href="/c/${req.params.token}">Try again</a>`
              : result.nextAction === 'dispute'
                ? html`<a class="btn secondary" href="/dispute/${result.billId ?? ''}">This should be my bill</a>`
                : ''}
          </div>`),
        );
      }

      const count = billsRepo.countByOwner(db, accountId);
      const body = count === 1
        // E8: "a list of one looks broken" — so the one-bill state is a screen.
        ? renderFirstBillState(result.view)
        : renderClaimPage(
            {
              kind: 'owner', billId: result.billId, view: result.view, identity: null,
              requiresSecondFactor: false, secondFactorPrompt: null,
              message: result.message, nextAction: 'none',
            },
            req.params.token,
          );

      return reply
        .header('Set-Cookie', sessionCookie(signSession(accountId)))
        .header('Cache-Control', 'no-store, private')
        .type('text/html; charset=utf-8')
        .send(body);
    },
  );

  /** C-03 from the expired-token page. */
  app.post<{ Params: { token: string }; Body: { phone?: string; secondFactor?: string } }>(
    '/c/:token/retroactive',
    async (req, reply) => {
      const phone = normalisePhone(req.body?.phone);
      if (!phone) return badRequest(reply, 'Enter a valid 10-digit mobile number.');
      if (!accountLimiter.take(clientKey(req))) return reply.code(429).send('Too many attempts.');

      const token = claimsRepo.findToken(db, req.params.token);
      const bill = token ? billsRepo.getBill(db, token.billId) : null;
      if (!bill) return badRequest(reply, 'We could not find that bill.');

      // The last-4 check is what makes an expired token safe to honour: it
      // proves the person is holding the slip.
      const expected = toDecimalString(money(bill.grandTotalMinor, bill.currency)).replace(/\D/g, '').slice(-4);
      const given = (req.body?.secondFactor ?? '').replace(/\D/g, '').slice(-4);
      if (given !== expected) {
        ledgers.logAccess(db, {
          billId: bill.id, actorType: 'system', actorId: clientKey(req),
          action: 'claim_failed', reason: 'retroactive claim: amount confirmation mismatch',
          visibleToOwner: false,
        });
        return badRequest(reply, 'That didn’t match the total on the bill. Check and try again.');
      }

      const existing = people.findAccountByPhone(db, phone);
      const accountId = existing?.id ?? people.createAccount(db, { phoneE164: phone }).account.id;

      const result = retroactiveClaim(db, {
        accountId,
        merchantId: bill.merchantId,
        documentNumber: bill.documentNumber,
        financialYear: bill.financialYear,
        grandTotalMinor: bill.grandTotalMinor,
        currency: bill.currency,
        documentDateKey: bill.documentDateKey,
        offeredProvenance: 'user_manual',
      });

      if (!result.ok) return badRequest(reply, result.message);

      return reply
        .header('Set-Cookie', sessionCookie(signSession(accountId)))
        .type('text/html; charset=utf-8')
        .send(
          billsRepo.countByOwner(db, accountId) === 1
            ? renderFirstBillState(result.view)
            : renderClaimPage(
                {
                  kind: 'owner', billId: result.billId, view: result.view, identity: null,
                  requiresSecondFactor: false, secondFactorPrompt: null,
                  message: result.message, nextAction: 'none',
                },
                req.params.token,
              ),
        );
    },
  );

  /**
   * J1 step 5's other half: "Declining still leaves a shareable link valid for
   * the hold window." Someone who does not want an account still leaves with
   * something.
   */
  app.get<{ Params: { token: string } }>('/c/:token/link', async (req, reply) => {
    const resolution = resolveClaimToken(db, req.params.token);
    if (!resolution.view) return reply.redirect(`/c/${req.params.token}`, 303);
    const base = process.env.BILLING_HUB_PUBLIC_URL ?? '';
    return reply.type('text/html; charset=utf-8').send(
      page({ title: 'Your link' }, html`<div class="card">
        <h1>Here’s your link</h1>
        <p class="muted">Works for the next 15 minutes without an account. Screenshot it, or send it to yourself.</p>
        <p style="word-break:break-all"><a href="${base}/c/${req.params.token}">${base}/c/${req.params.token}</a></p>
        <p class="muted">A link is not the same as keeping the bill. In a year, only a saved bill will still be here.</p>
        <a class="btn" href="/c/${req.params.token}">Keep it properly instead</a>
      </div>`),
    );
  });

  /** The owner's own view of a bill, by id. */
  app.get<{ Params: { billId: string }; Querystring: { all?: string } }>('/b/:billId', async (req, reply) => {
    const accountId = currentAccount(req);
    if (!accountId) return reply.redirect(`/signin?next=/b/${req.params.billId}`, 303);

    const bill = billsRepo.getBill(db, req.params.billId);
    if (!bill || bill.ownerAccountId !== accountId) {
      return reply.code(404).type('text/html; charset=utf-8').send(
        page({ title: 'Not found' }, html`<div class="card"><h1>Not found</h1>
          <p>That bill isn’t in your history.</p></div>`),
      );
    }

    const view = buildBillView(db, bill, { paginate: req.query.all !== '1' });
    return reply
      .header('Cache-Control', 'no-store, private')
      .type('text/html; charset=utf-8')
      .send(renderClaimPage(
        {
          kind: 'owner', billId: bill.id, view, identity: null,
          requiresSecondFactor: false, secondFactorPrompt: null, message: '', nextAction: 'none',
        },
        '',
      ));
  });
}

function normalisePhone(raw: string | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  const local = digits.length > 10 ? digits.slice(-10) : digits;
  // Indian mobile numbers start 6-9.
  if (!/^[6-9]\d{9}$/.test(local)) return null;
  return `+91${local}`;
}

function badRequest(reply: FastifyReply, message: string) {
  return reply.code(400).type('text/html; charset=utf-8').send(
    page({ title: 'Check that again' }, html`<div class="card">
      <h1>Check that again</h1><p>${message}</p>
      <a class="btn secondary" href="javascript:history.back()">Go back</a></div>`),
  );
}
