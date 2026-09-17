import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../../db/sqlite.js';
import { parseSearchQuery, shouldShowSearch } from '../../core/search.js';
import { includeInSharedProfile, requiresBiometricUnlock } from '../../core/sensitivity.js';
import { fieldsForScope, buildReturnVerification } from '../../core/consent.js';
import * as billsRepo from '../../db/repo/bills.js';
import * as people from '../../db/repo/people.js';
import * as ledgers from '../../db/repo/ledgers.js';
import { buildBillView } from '../../services/billview.js';
import { submitCapture, processCapture, applyCorrection, quotaDecision, capturesForAccount } from '../../services/capture.js';
import { createExport, staleExports, renderBillPdf, renderWarrantyPack } from '../../services/exports.js';
import { shareBillCopy, reassignProfile } from '../../services/claim.js';
import { applyCreditNote } from '../../services/amendments.js';
import { fileRequest, listRequests, buildAccessPackage, eraseAccount, consentNotice } from '../../services/dpdp.js';
import { notificationsFor } from '../../services/notifications.js';
import { returnWindowState } from '../../core/warranty.js';
import * as registry from '../../db/repo/registry.js';
import { verifySession, readCookie } from '../auth.js';
import type { OcrAdapter } from '../../services/ocr/types.js';

/** Customer-facing API (R-01, R-02, R-06, T-02, T-03). */

function accountOf(req: FastifyRequest): string | null {
  const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
  const cookie = readCookie(req.headers.cookie, 'bh_session');
  return verifySession(bearer ?? cookie)?.accountId ?? null;
}

export function registerCustomerRoutes(app: FastifyInstance, db: Db, ocr: OcrAdapter): void {
  const requireAccount = (req: FastifyRequest): string => {
    const id = accountOf(req);
    if (!id) throw Object.assign(new Error('unauthorised'), { statusCode: 401 });
    return id;
  };

  // ---- history and search (R-02) -----------------------------------------

  app.get<{ Querystring: { q?: string; limit?: string; offset?: string; profileId?: string } }>(
    '/api/v1/bills',
    async (req, reply) => {
      const accountId = requireAccount(req);
      const total = billsRepo.countByOwner(db, accountId);

      if (req.query.q) {
        const parsed = parseSearchQuery(req.query.q);
        const hits = billsRepo.searchBills(db, accountId, parsed, {
          limit: Number(req.query.limit ?? 25),
        });
        return reply.send({
          // J3: show what we understood, so a half-memory search is debuggable
          // by the person standing at the returns desk.
          understood: parsed.understood,
          query: { text: parsed.text, amount: parsed.amount, dates: parsed.dates },
          total,
          results: hits.map((h) => ({
            score: Number(h.score.toFixed(4)),
            itemMatch: h.itemMatch,
            bill: buildBillView(db, h.bill),
          })),
        });
      }

      const bills = billsRepo.listByOwner(db, accountId, {
        limit: Number(req.query.limit ?? 50),
        offset: Number(req.query.offset ?? 0),
        profileId: req.query.profileId ?? null,
      });
      return reply.send({
        total,
        // E8: don't show a search bar over a list short enough to read.
        showSearch: shouldShowSearch(total),
        bills: bills.map((b) => buildBillView(db, b)),
      });
    },
  );

  app.get<{ Params: { billId: string } }>('/api/v1/bills/:billId', async (req, reply) => {
    const accountId = requireAccount(req);
    const bill = billsRepo.getBill(db, req.params.billId);
    if (!bill || bill.ownerAccountId !== accountId) return reply.code(404).send({ error: 'not_found' });

    const account = people.getAccount(db, accountId)!;
    return reply.send({
      bill: buildBillView(db, bill, { paginate: false }),
      // E6: biometric lock is optional on the app, mandatory on the sensitive view.
      requiresUnlock: requiresBiometricUnlock(bill.sensitivityClass, account.appLockEnabled),
      shareableInHouseholdView: includeInSharedProfile(bill.sensitivityClass, new Set(), bill.id),
    });
  });

  // ---- capture (R-01) -----------------------------------------------------

  app.post<{ Body: { imageRef?: string; usedBytes?: number; quotaBytes?: number } }>(
    '/api/v1/captures',
    async (req, reply) => {
      const accountId = requireAccount(req);
      if (!req.body?.imageRef) return reply.code(400).send({ error: 'imageRef_required' });

      // E7: never refuse a capture over quota. Warn, compress, but accept.
      const quota = quotaDecision(req.body.usedBytes ?? 0, req.body.quotaBytes ?? 1);
      const capture = submitCapture(db, accountId, req.body.imageRef);

      return reply.code(202).send({
        capture,
        quota,
        // E8: the photograph alone does the job while extraction runs.
        imageViewableNow: true,
        message: 'Saved. We’re reading it now — the photo is already in your history either way.',
      });
    },
  );

  app.post<{ Params: { captureId: string } }>('/api/v1/captures/:captureId/process', async (req, reply) => {
    requireAccount(req);
    return reply.send(await processCapture(db, req.params.captureId, ocr));
  });

  app.get('/api/v1/captures', async (req, reply) => {
    const accountId = requireAccount(req);
    return reply.send({ captures: capturesForAccount(db, accountId) });
  });

  /** J2 step 4: confirm or correct only the flagged fields. */
  app.post<{ Params: { billId: string }; Body: { fieldPath?: string; value?: string } }>(
    '/api/v1/bills/:billId/fields',
    async (req, reply) => {
      const accountId = requireAccount(req);
      if (!req.body?.fieldPath || req.body.value === undefined) {
        return reply.code(400).send({ error: 'fieldPath_and_value_required' });
      }
      const result = applyCorrection(db, req.params.billId, accountId, req.body.fieldPath, req.body.value);
      return reply.code(result.ok ? 200 : 404).send(result);
    },
  );

  // ---- returns and sharing ------------------------------------------------

  /**
   * J4 step 2: "merchant scans it to verify authenticity without receiving any
   * other data". The response is built from the consent projection, so there is
   * no route by which more could be returned.
   */
  app.get<{ Params: { billId: string }; Querystring: { merchantId?: string } }>(
    '/api/v1/bills/:billId/verify',
    async (req, reply) => {
      const bill = billsRepo.getBill(db, req.params.billId);
      if (!bill) return reply.code(404).send({ error: 'not_found' });

      const merchantId = req.query.merchantId ?? bill.merchantId;
      // E4: verification is at merchant level, not outlet level — bought in
      // Mohali, returned in Noida.
      if (registry.resolveCurrentMerchant(db, bill.merchantId) !== registry.resolveCurrentMerchant(db, merchantId)) {
        return reply.code(403).send({ error: 'different_merchant' });
      }

      const merchant = registry.getMerchant(db, bill.merchantId);
      const rw = returnWindowState(
        {
          documentDateKey: bill.documentDateKey,
          merchantReturnWindowDays: merchant?.returnWindowDays ?? null,
          merchantReturnPolicySource: merchant?.returnPolicySource ?? null,
        },
        new Date(),
      );

      ledgers.logAccess(db, {
        billId: bill.id, accountId: bill.ownerAccountId, actorType: 'merchant', actorId: merchantId,
        action: 'return_verification',
        reason: 'the merchant scanned this bill at the counter to verify it is genuine',
      });

      return reply.send({
        verification: buildReturnVerification(db ? bill : bill, merchantId, rw.open),
        fieldsDisclosed: fieldsForScope('return_verification'),
      });
    },
  );

  app.post<{ Params: { billId: string }; Body: { toAccountId?: string } }>(
    '/api/v1/bills/:billId/share',
    async (req, reply) => {
      const accountId = requireAccount(req);
      const bill = billsRepo.getBill(db, req.params.billId);
      if (!bill || bill.ownerAccountId !== accountId) return reply.code(404).send({ error: 'not_found' });
      if (!req.body?.toAccountId) return reply.code(400).send({ error: 'toAccountId_required' });
      return reply.send(shareBillCopy(db, req.params.billId, req.body.toAccountId));
    },
  );

  app.post<{ Params: { billId: string }; Body: { profileId?: string } }>(
    '/api/v1/bills/:billId/profile',
    async (req, reply) => {
      const accountId = requireAccount(req);
      if (!req.body?.profileId) return reply.code(400).send({ error: 'profileId_required' });
      return reply.send(reassignProfile(db, req.params.billId, accountId, req.body.profileId));
    },
  );

  app.post<{
    Body: {
      originalBillId?: string; documentNumber?: string; outletId?: string;
      amountMinor?: number; returnedLines?: Array<{ lineNo: number; qty: number }>;
    };
  }>('/api/v1/credit-notes', async (req, reply) => {
    const body = req.body ?? {};
    if (!body.documentNumber || !body.outletId || body.amountMinor === undefined) {
      return reply.code(400).send({ error: 'documentNumber_outletId_amountMinor_required' });
    }
    return reply.send(applyCreditNote(db, {
      originalBillId: body.originalBillId,
      documentNumber: body.documentNumber,
      outletId: body.outletId,
      amountMinor: body.amountMinor,
      returnedLines: body.returnedLines ?? [],
    }));
  });

  // ---- exports (R-06) -----------------------------------------------------

  app.post<{ Body: { format?: string; financialYear?: string; profileId?: string; includeSensitive?: boolean } }>(
    '/api/v1/exports',
    async (req, reply) => {
      const accountId = requireAccount(req);
      const format = (req.body?.format ?? 'csv') as 'csv' | 'xlsx' | 'pdf';
      if (!['csv', 'xlsx', 'pdf'].includes(format)) return reply.code(400).send({ error: 'unsupported_format' });

      return reply.send(await createExport(db, {
        accountId,
        format,
        financialYear: req.body?.financialYear ?? null,
        profileId: req.body?.profileId ?? null,
        includeSensitive: req.body?.includeSensitive ?? false,
      }));
    },
  );

  app.get('/api/v1/exports/stale', async (req, reply) => {
    const accountId = requireAccount(req);
    return reply.send({ staleExports: staleExports(db, accountId) });
  });

  /** J3 step 4: "something a stranger will accept". */
  app.get<{ Params: { billId: string } }>('/api/v1/bills/:billId/pdf', async (req, reply) => {
    const accountId = requireAccount(req);
    const bill = billsRepo.getBill(db, req.params.billId);
    if (!bill || bill.ownerAccountId !== accountId) return reply.code(404).send({ error: 'not_found' });
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="bill-${req.params.billId.slice(0, 8)}.pdf"`)
      .send(renderBillPdf(db, req.params.billId));
  });

  /** R-05: the one-tap warranty pack. */
  app.get<{ Params: { billId: string; lineNo: string } }>(
    '/api/v1/bills/:billId/warranty-pack/:lineNo',
    async (req, reply) => {
      const accountId = requireAccount(req);
      const bill = billsRepo.getBill(db, req.params.billId);
      if (!bill || bill.ownerAccountId !== accountId) return reply.code(404).send({ error: 'not_found' });
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', 'attachment; filename="warranty-pack.pdf"')
        .send(renderWarrantyPack(db, req.params.billId, Number(req.params.lineNo)));
    },
  );

  // ---- trust and rights (T-02, T-03, T-05) --------------------------------

  /** T-02: the owner sees every non-owner read of their data. */
  app.get('/api/v1/me/access-log', async (req, reply) => {
    const accountId = requireAccount(req);
    return reply.send({
      entries: ledgers.accessLogForOwner(db, accountId),
      explanation:
        'Everyone who looked at your bills, other than you, and why. Support, staff and automated jobs all appear here.',
    });
  });

  app.get('/api/v1/me/notifications', async (req, reply) => {
    const accountId = requireAccount(req);
    return reply.send({ notifications: notificationsFor(db, accountId) });
  });

  app.get('/api/v1/consent-notice', async (_req, reply) => reply.send(consentNotice()));

  app.post<{ Params: { kind: string }; Body: { detail?: string } }>(
    '/api/v1/dpdp/:kind',
    async (req, reply) => {
      const accountId = requireAccount(req);
      const kind = req.params.kind as 'access' | 'correction' | 'erasure' | 'grievance';
      if (!['access', 'correction', 'erasure', 'grievance'].includes(kind)) {
        return reply.code(400).send({ error: 'unknown_request_kind' });
      }
      const request = fileRequest(db, accountId, kind, req.body?.detail ?? null);

      if (kind === 'access') {
        return reply.send({ request, package: buildAccessPackage(db, accountId) });
      }
      if (kind === 'erasure') {
        return reply.send({ request, result: eraseAccount(db, accountId, request.id) });
      }
      return reply.send({ request });
    },
  );

  app.get('/api/v1/dpdp', async (req, reply) => {
    const accountId = requireAccount(req);
    return reply.send({ requests: listRequests(db, accountId) });
  });

  /** T-05: format preference, set once, honoured at every counter. */
  app.put<{ Body: { formatPreference?: 'paper' | 'digital' | 'both'; appLock?: boolean } }>(
    '/api/v1/me/preferences',
    async (req, reply) => {
      const accountId = requireAccount(req);
      if (req.body?.formatPreference) {
        people.setFormatPreference(db, accountId, req.body.formatPreference);
      }
      if (typeof req.body?.appLock === 'boolean') {
        people.setAppLock(db, accountId, req.body.appLock);
      }
      return reply.send({
        account: people.getAccount(db, accountId),
        note: 'Paper is always available. Choosing digital means we ask the counter to skip the printed slip — a shop can never refuse you paper.',
      });
    },
  );

  app.get('/api/v1/me/profiles', async (req, reply) => {
    const accountId = requireAccount(req);
    return reply.send({ profiles: people.listProfiles(db, accountId) });
  });

  app.post<{ Body: { kind?: 'personal' | 'business'; label?: string; gstin?: string } }>(
    '/api/v1/me/profiles',
    async (req, reply) => {
      const accountId = requireAccount(req);
      if (!req.body?.label || !req.body?.kind) return reply.code(400).send({ error: 'kind_and_label_required' });
      return reply.code(201).send(
        people.createProfile(db, accountId, req.body.kind, req.body.label, req.body.gstin ?? null),
      );
    },
  );
}
