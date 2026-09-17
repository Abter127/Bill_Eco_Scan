import type { Db } from '../db/sqlite.js';
import { localDateKey } from '../core/time.js';
import { toMerchantVisible, assertNoCustomerIdentity, type MerchantVisibleBill } from '../core/consent.js';
import * as billsRepo from '../db/repo/bills.js';
import * as registry from '../db/repo/registry.js';
import * as ledgers from '../db/repo/ledgers.js';
import { orphanAmendmentAlerts } from './amendments.js';

/**
 * The merchant console (M-04).
 *
 * Its acceptance criterion is a negative: "A full-permission admin can produce
 * no list of people who shopped there." Everything returned from this module is
 * either an aggregate or a `MerchantVisibleBill`, and both are run through the
 * consent-boundary guard before they leave.
 *
 * Its commercial purpose is E5's last entry: a merchant whose first fifty bills
 * go unclaimed concludes the product doesn't work and churns in week two. So
 * the console does not just report claim rate — it says what to do about it.
 */

export interface ConsoleSummary {
  outletId: string;
  outletName: string;
  merchantName: string;
  period: { fromDateKey: string; toDateKey: string };
  billsIssued: number;
  billsClaimed: number;
  /** Success metric: >= 30%. */
  claimRate: number;
  claimRateTarget: number;
  /** Success metric: >= 20%. The merchant's only hard ROI. */
  paperSuppressionRate: number;
  paperSuppressionTarget: number;
  quarantined: number;
  captureGaps: ReturnType<typeof registry.captureGaps>;
  coaching: CoachingNote[];
  claimAnomalies: Array<{ terminalId: string; share: number; claims: number; note: string }>;
  orphanAmendments: ReturnType<typeof orphanAmendmentAlerts>;
}

export interface CoachingNote {
  severity: 'info' | 'warning' | 'critical';
  title: string;
  /** A concrete fix, not a metric restated as advice. */
  action: string;
  benchmark: string | null;
}

export const CLAIM_RATE_TARGET = 0.30;
export const PAPER_SUPPRESSION_TARGET = 0.20;

export function consoleSummary(
  db: Db, outletId: string, fromDateKey: string, toDateKey: string, now = new Date(),
): ConsoleSummary {
  const outlet = registry.getOutlet(db, outletId);
  if (!outlet) throw new Error('outlet not found');
  const merchant = registry.getMerchant(db, outlet.merchantId);
  const metrics = ledgers.outletMetrics(db, outletId, fromDateKey, toDateKey);
  const gaps = registry.captureGaps(db, outletId, now);

  const coaching: CoachingNote[] = [];

  // E5: "Merchant console must explain claim rate in the first week, with a
  // benchmark and a concrete fix — QR placement is usually the culprit."
  if (metrics.billsIssued === 0) {
    coaching.push({
      severity: 'info',
      title: 'No bills captured yet',
      action: 'Print one bill on each till. It should appear here within a few seconds. If it does not, check the agent is running on the billing PC.',
      benchmark: null,
    });
  } else if (metrics.claimRate < CLAIM_RATE_TARGET) {
    coaching.push({
      severity: metrics.billsIssued >= 50 ? 'critical' : 'warning',
      title: `${Math.round(metrics.claimRate * 100)}% of your bills are being kept by customers`,
      action:
        'Nine times out of ten this is where the code sits. Move the QR to the customer’s side of the counter at eye level, ' +
        'and have staff say one line: "scan this if you want the bill on your phone." Shops that do this reach 30%+ within a fortnight.',
      benchmark: `Shops like yours: 30-45%. You: ${Math.round(metrics.claimRate * 100)}%.`,
    });
  } else {
    coaching.push({
      severity: 'info',
      title: `${Math.round(metrics.claimRate * 100)}% of bills are being kept`,
      action: 'This is healthy. The next lever is paper: customers who keep bills digitally can opt out of the printed slip.',
      benchmark: 'Target: 30%.',
    });
  }

  if (metrics.paperSuppressionRate < PAPER_SUPPRESSION_TARGET && metrics.billsIssued > 20) {
    coaching.push({
      severity: 'info',
      title: 'Paper savings are below target',
      action: 'Paper is only skipped when a customer has asked for it to be. Never refuse a printed bill to force this — it is against the merchant terms.',
      benchmark: `Target: 20% of slips not printed. You: ${Math.round(metrics.paperSuppressionRate * 100)}%.`,
    });
  }

  const down = gaps.filter((g) => g.severity !== 'ok');
  for (const gap of down) {
    coaching.push({
      severity: gap.severity === 'down' ? 'critical' : 'warning',
      title: `${gap.label} has not reported in${gap.gapMinutes ? ` for ${gap.gapMinutes} minutes` : ''}`,
      action:
        'Bills printed on this till are not reaching us. Check the agent is running on that PC. ' +
        'Customers can still add those bills later by photographing the printed slip.',
      benchmark: null,
    });
  }

  if (metrics.quarantined > 0) {
    coaching.push({
      severity: 'info',
      title: `${metrics.quarantined} print${metrics.quarantined > 1 ? 's were' : ' was'} held back`,
      action: 'These were not customer bills — kitchen tickets, test prints or shift reports. They were never shown to a customer. Review them if that looks wrong.',
      benchmark: null,
    });
  }

  const terminals = db.prepare<[string], { id: string }>(
    'SELECT id FROM terminals WHERE outlet_id = ?',
  ).all(outletId);

  const anomalies = terminals.flatMap((t) =>
    ledgers.claimAnomalies(db, t.id, fromDateKey, toDateKey).map((a) => ({
      terminalId: a.terminalId,
      share: a.share,
      claims: a.claims,
      // Note: no account identity leaves this function. The merchant is told
      // that a pattern exists, not whose it is.
      note:
        `One account has kept ${Math.round(a.share * 100)}% of this till's bills. ` +
        'That is unusual for a walk-in counter and is worth a look at how the code is being scanned.',
    })),
  );

  const summary: ConsoleSummary = {
    outletId,
    outletName: outlet.name,
    merchantName: merchant?.tradeName ?? merchant?.legalName ?? '',
    period: { fromDateKey, toDateKey },
    billsIssued: metrics.billsIssued,
    billsClaimed: metrics.billsClaimed,
    claimRate: metrics.claimRate,
    claimRateTarget: CLAIM_RATE_TARGET,
    paperSuppressionRate: metrics.paperSuppressionRate,
    paperSuppressionTarget: PAPER_SUPPRESSION_TARGET,
    quarantined: metrics.quarantined,
    captureGaps: gaps,
    coaching,
    claimAnomalies: anomalies,
    orphanAmendments: orphanAmendmentAlerts(db, 3, now),
  };

  assertNoCustomerIdentity(summary as unknown as Record<string, unknown>);
  return summary;
}

/**
 * The merchant's own bill list. Returns the projection type, so there is no
 * code path here that could carry an identity even by accident.
 */
export function merchantBills(
  db: Db, outletId: string, fromDateKey: string, toDateKey: string, limit = 100,
): MerchantVisibleBill[] {
  const rows = db.prepare<[string, string, string, number], { id: string }>(
    `SELECT id FROM bills WHERE outlet_id = ? AND document_date_key BETWEEN ? AND ?
      ORDER BY document_date_key DESC, created_at DESC LIMIT ?`,
  ).all(outletId, fromDateKey, toDateKey, limit);

  return rows.map((r) => toMerchantVisible(billsRepo.getBill(db, r.id)!));
}

/**
 * M-04's acceptance criterion, as an executable check rather than a promise.
 * Used by the test suite and available to an auditor.
 */
export interface IdentityExfiltrationAudit {
  surfacesChecked: string[];
  identityFieldsFound: string[];
  passes: boolean;
}

export function auditMerchantSurfaces(
  db: Db, outletId: string, fromDateKey: string, toDateKey: string,
): IdentityExfiltrationAudit {
  const found: string[] = [];
  const surfaces: string[] = [];

  const check = (name: string, value: unknown) => {
    surfaces.push(name);
    try {
      assertNoCustomerIdentity(value as Record<string, unknown>);
    } catch (err) {
      found.push(`${name}: ${(err as Error).message}`);
    }
  };

  check('consoleSummary', consoleSummary(db, outletId, fromDateKey, toDateKey));
  for (const bill of merchantBills(db, outletId, fromDateKey, toDateKey)) {
    check(`merchantBill:${bill.id}`, bill);
  }
  check('quarantine', { entries: ledgers.listQuarantine(db, outletId) });

  return { surfacesChecked: surfaces, identityFieldsFound: found, passes: found.length === 0 };
}

/**
 * E5 "fake merchant onboards": GSTIN verification catches the lazy version;
 * velocity anomaly detection catches the patient one.
 */
export interface VelocityAnomaly {
  merchantId: string;
  legalName: string;
  gstinVerified: boolean;
  billsInWindow: number;
  distinctTotals: number;
  suspicionScore: number;
  reasons: string[];
}

export function velocityAnomalies(
  db: Db, fromDateKey: string, toDateKey: string, now = new Date(),
): VelocityAnomaly[] {
  void now;
  const rows = db.prepare<[string, string], {
    merchant_id: string; legal_name: string; gstin_verified: number;
    n: number; distinct_totals: number; age_days: number;
  }>(`SELECT b.merchant_id, m.legal_name, m.gstin_verified,
             COUNT(*) AS n, COUNT(DISTINCT b.grand_total_minor) AS distinct_totals,
             CAST(julianday('now') - julianday(m.created_at) AS INTEGER) AS age_days
        FROM bills b JOIN merchants m ON m.id = b.merchant_id
       WHERE b.document_date_key BETWEEN ? AND ?
       GROUP BY b.merchant_id`)
    .all(fromDateKey, toDateKey);

  return rows
    .map((r) => {
      const reasons: string[] = [];
      let score = 0;
      if (r.gstin_verified !== 1) { score += 0.4; reasons.push('GSTIN not verified'); }
      if (r.age_days <= 2 && r.n > 50) { score += 0.3; reasons.push('high volume within days of onboarding'); }
      // A real shop's takings vary. A fabricated batch tends not to.
      if (r.n >= 10 && r.distinct_totals <= Math.max(2, Math.floor(r.n * 0.1))) {
        score += 0.3;
        reasons.push('almost every bill has the same total');
      }
      return {
        merchantId: r.merchant_id, legalName: r.legal_name,
        gstinVerified: r.gstin_verified === 1, billsInWindow: r.n,
        distinctTotals: r.distinct_totals, suspicionScore: Number(score.toFixed(2)), reasons,
      };
    })
    .filter((a) => a.suspicionScore >= 0.4)
    .sort((a, b) => b.suspicionScore - a.suspicionScore);
}

/**
 * E5 "merchant refuses paper unless you scan": monitored via paper-suppression
 * outliers. "Differentiation dies the first time this is tolerated", so this is
 * an enforcement signal, not a dashboard curiosity.
 */
export interface CoercionSignal {
  outletId: string;
  outletName: string;
  paperSuppressionRate: number;
  billsIssued: number;
  /** Suppression far above what customer preference could explain. */
  breach: boolean;
  message: string;
}

/** Well above the 20% target: at this level customers are not choosing. */
export const COERCION_SUPPRESSION_THRESHOLD = 0.7;

export function coercionSignals(db: Db, fromDateKey: string, toDateKey: string): CoercionSignal[] {
  const rows = db.prepare<[string, string], {
    outlet_id: string; issued: number; printed: number; suppressed: number;
  }>(`SELECT outlet_id, SUM(bills_issued) AS issued, SUM(paper_printed) AS printed,
             SUM(paper_suppressed) AS suppressed
        FROM issuance_stats WHERE date_key BETWEEN ? AND ? GROUP BY outlet_id`)
    .all(fromDateKey, toDateKey);

  return rows
    .map((r) => {
      const total = r.printed + r.suppressed;
      const rate = total === 0 ? 0 : r.suppressed / total;
      const breach = rate >= COERCION_SUPPRESSION_THRESHOLD && r.issued >= 25;
      return {
        outletId: r.outlet_id,
        outletName: registry.getOutlet(db, r.outlet_id)?.name ?? r.outlet_id,
        paperSuppressionRate: rate,
        billsIssued: r.issued,
        breach,
        message: breach
          ? `${Math.round(rate * 100)}% of slips are going unprinted at this outlet. That is higher than customer preference explains. ` +
            'Refusing paper unless a customer scans is a breach of the merchant terms and is enforceable.'
          : 'Within the expected range.',
      };
    })
    .filter((s) => s.breach);
}

export { localDateKey };
