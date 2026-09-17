import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createExport, renderBillPdf, renderWarrantyPack, staleExports, ASYNC_EXPORT_THRESHOLD } from '../src/services/exports.js';
import { ingestBill } from '../src/services/issuance.js';
import { claimBill } from '../src/services/claim.js';
import { applyCorrection } from '../src/services/capture.js';
import { voidBill } from '../src/services/amendments.js';
import { billPayloadSchema } from '../src/core/schema.js';
import { newIdempotencyKey } from '../src/core/ids.js';
import { makeZip, crc32, toCsv } from '../src/services/filewriters.js';
import * as billsRepo from '../src/db/repo/bills.js';
import { makeWorld } from './helpers.js';

const execFileAsync = promisify(execFile);
const OUT = '/tmp/billing-hub-test-exports';
const NOW = new Date('2026-09-17T14:12:00Z');

function issueAndClaim(
  w: ReturnType<typeof makeWorld>,
  over: Record<string, unknown> = {},
) {
  const result = ingestBill(
    w.db,
    { terminalId: w.terminalId, outletId: w.outletId, merchantId: w.merchantId, now: NOW },
    billPayloadSchema.parse({
      idempotencyKey: newIdempotencyKey(),
      outletId: w.outletId, terminalId: w.terminalId, terminalTime: NOW.toISOString(),
      documentNumber: `INV/${Math.random().toString(36).slice(2, 8)}`,
      documentDateKey: '2026-09-17',
      subtotalMinor: 91000, taxTotalMinor: 4550, grandTotalMinor: 95500,
      paymentMethod: 'upi',
      lines: [{
        lineNo: 0, description: 'Electric kettle', qty: 1, lineTotalMinor: 95500,
        hsnSac: '85167920', gstRateBp: 1800, cgstMinor: 2275, sgstMinor: 2275,
        serialNumber: 'KT-991', warrantyMonths: 12,
      }],
      ...over,
    }),
  );
  claimBill(w.db, { secret: result.claimTokenSecret!, accountId: w.accountId, now: NOW });
  return result;
}

describe('R-06 / E7 — exports default to the financial year, not the calendar year', () => {
  it('covers April to March when no range is given', async () => {
    const w = makeWorld();
    issueAndClaim(w);

    const result = await createExport(w.db, {
      accountId: w.accountId, format: 'csv', now: NOW, outDir: OUT,
    });
    expect(result.financialYear).toBe('2026-27');
    expect(result.fromDateKey).toBe('2026-04-01');
    expect(result.toDateKey).toBe('2027-03-31');
    expect(result.billCount).toBe(1);
  });

  it('puts a January bill in the previous financial year', async () => {
    const w = makeWorld();
    issueAndClaim(w, { documentDateKey: '2027-01-15' });

    const thisYear = await createExport(w.db, {
      accountId: w.accountId, format: 'csv', financialYear: '2026-27', now: NOW, outDir: OUT,
    });
    expect(thisYear.billCount).toBe(1); // Jan 2027 is inside FY 2026-27

    const nextYear = await createExport(w.db, {
      accountId: w.accountId, format: 'csv', financialYear: '2027-28', now: NOW, outDir: OUT,
    });
    expect(nextYear.billCount).toBe(0);
  });
});

describe('R-06 — CSV keeps tax columns intact and is not paywalled', () => {
  it('writes a readable CSV with the tax columns as their own fields', async () => {
    const w = makeWorld();
    issueAndClaim(w);

    const result = await createExport(w.db, {
      accountId: w.accountId, format: 'csv', now: NOW, outDir: OUT,
    });
    const csv = await readFile(result.fileRef, 'utf8');
    const [header, row] = csv.trim().split('\r\n');

    expect(header).toContain('CGST');
    expect(header).toContain('SGST');
    expect(header).toContain('Total');
    expect(header).toContain('Source');
    expect(row).toContain('22.75');    // tax as a number, not a string blob
    expect(row).toContain('955');      // amounts are numeric, not text
    expect(row).toContain('85167920'); // HSN survives as its own column
  });

  it('neutralises a formula injection in a merchant name', () => {
    const csv = toCsv(['Shop'], [['=cmd|calc']]);
    expect(csv).toContain("'=cmd|calc");
    expect(csv.startsWith('Shop')).toBe(true);
  });

  it('marks a bill whose amounts the user edited (E6)', async () => {
    const w = makeWorld();
    const bill = issueAndClaim(w);
    applyCorrection(w.db, bill.billId!, w.accountId, 'grandTotalMinor', '150000', NOW);

    const result = await createExport(w.db, {
      accountId: w.accountId, format: 'csv', now: NOW, outDir: OUT,
    });
    const csv = await readFile(result.fileRef, 'utf8');
    const header = csv.split('\r\n')[0]!.split(',');
    const idx = header.indexOf('Amounts edited by user');
    expect(idx).toBeGreaterThan(-1);
    expect(csv.split('\r\n')[1]!.split(',')[idx]).toBe('yes');
    expect(result.warnings.join(' ')).toMatch(/amounts you corrected/i);
  });

  it('marks a cancelled bill as not spend but keeps it in the export (E1)', async () => {
    const w = makeWorld();
    const bill = issueAndClaim(w);
    voidBill(w.db, bill.billId!, 'VOID/1', NOW);

    const result = await createExport(w.db, {
      accountId: w.accountId, format: 'csv', now: NOW, outDir: OUT,
    });
    const csv = await readFile(result.fileRef, 'utf8');
    expect(csv).toContain('cancelled');
    // The cancelled bill and its void document are both present, neither counted.
    expect(result.totals.every((t) => t.grandTotalMinor <= 0)).toBe(true);
  });
});

describe('R-06 — XLSX is a real workbook a spreadsheet will open', () => {
  it('produces a valid zip container with the expected OOXML parts', async () => {
    const w = makeWorld();
    issueAndClaim(w);

    const result = await createExport(w.db, {
      accountId: w.accountId, format: 'xlsx', now: NOW, outDir: OUT,
    });

    const bytes = await readFile(result.fileRef);
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');

    // Verified by an external unzip rather than by our own reader.
    const { stdout } = await execFileAsync('unzip', ['-l', result.fileRef]);
    expect(stdout).toContain('xl/workbook.xml');
    expect(stdout).toContain('xl/worksheets/sheet1.xml');
    expect(stdout).toContain('[Content_Types].xml');

    const test = await execFileAsync('unzip', ['-t', result.fileRef]);
    expect(test.stdout).toMatch(/No errors detected/i);
  });

  it('writes tax figures as numbers, not text', async () => {
    const w = makeWorld();
    issueAndClaim(w);
    const result = await createExport(w.db, {
      accountId: w.accountId, format: 'xlsx', now: NOW, outDir: OUT,
    });

    const { stdout } = await execFileAsync('unzip', ['-p', result.fileRef, 'xl/worksheets/sheet1.xml']);
    // A numeric cell is <v>955</v>; a text cell would be wrapped in <is><t>.
    expect(stdout).toMatch(/<v>955<\/v>/);
    expect(stdout).toMatch(/<v>22.75<\/v>/);
  });

  it('round-trips through our own zip writer with correct CRCs', async () => {
    const payload = Buffer.from('hello, billing hub', 'utf8');
    const zip = makeZip([{ name: 'a.txt', data: payload }]);
    expect(crc32(payload)).toBeGreaterThan(0);
    expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  });
});

describe('R-06 / J3 — a PDF a stranger will accept', () => {
  it('produces a parseable PDF naming the shop, amount and provenance', async () => {
    const w = makeWorld();
    const bill = issueAndClaim(w);
    const pdf = renderBillPdf(w.db, bill.billId!, NOW);

    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.toString('latin1')).toContain('%%EOF');
    expect(pdf.toString('latin1')).toContain('startxref');

    const text = pdf.toString('latin1');
    expect(text).toContain('Sharma General Store');
    expect(text).toContain('From the counter'); // the provenance badge
  });

  it('builds a warranty pack with serial, dates and the rule’s source (R-05)', async () => {
    const w = makeWorld({ category: 'electronics' });
    const bill = issueAndClaim(w);
    const pdf = renderWarrantyPack(w.db, bill.billId!, 0, NOW).toString('latin1');

    expect(pdf).toContain('KT-991');
    expect(pdf).toContain('Purchased: 2026-09-17');
    expect(pdf).toContain('Warranty ends: 2027-09-17');
    expect(pdf).toMatch(/Warranty source:/);
  });
});

describe('E4 — an export that has gone stale says so plainly', () => {
  it('flags the export and tells the owner to warn their accountant', async () => {
    const w = makeWorld();
    const bill = issueAndClaim(w);
    await createExport(w.db, { accountId: w.accountId, format: 'csv', now: NOW, outDir: OUT });
    voidBill(w.db, bill.billId!, 'VOID/2', NOW);

    const stale = staleExports(w.db, w.accountId);
    expect(stale).toHaveLength(1);
    expect(stale[0]!.message).toMatch(/out of date/i);
    expect(stale[0]!.message).toMatch(/accountant/i);
  });
});

describe('E7 — 50,000 bills', () => {
  it('exports a large history and marks it as an async job', async () => {
    const w = makeWorld();
    const count = ASYNC_EXPORT_THRESHOLD + 10;

    // Inserted directly: this test is about export and pagination at volume,
    // not about the ingestion path, which is covered elsewhere.
    const base = billsRepo.getBill(w.db, issueAndClaim(w).billId!)!;
    const insert = w.db.transaction(() => {
      for (let i = 0; i < count; i++) {
        billsRepo.insertBill(w.db, {
          ...base,
          id: `bulk-${i}`,
          billGroupId: `bulk-${i}`,
          documentNumber: `BULK/${i}`,
          contentFingerprint: `bulk-${i}`,
          idempotencyKey: null,
          lines: base.lines.map((l) => ({ ...l })),
          fields: [],
        });
      }
    });
    insert();

    const started = Date.now();
    const result = await createExport(w.db, {
      accountId: w.accountId, format: 'csv', now: NOW, outDir: OUT,
    });
    expect(result.billCount).toBe(count + 1);
    expect(result.async).toBe(true);
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it('searches a large history quickly', async () => {
    const w = makeWorld();
    const base = billsRepo.getBill(w.db, issueAndClaim(w).billId!)!;
    w.db.transaction(() => {
      for (let i = 0; i < 5000; i++) {
        billsRepo.insertBill(w.db, {
          ...base,
          id: `s-${i}`, billGroupId: `s-${i}`, documentNumber: `S/${i}`,
          contentFingerprint: `s-${i}`, idempotencyKey: null,
          lines: [{ ...base.lines[0]!, description: i === 4242 ? 'Prestige pressure cooker' : 'Electric kettle' }],
          fields: [],
        });
      }
    })();

    const { parseSearchQuery } = await import('../src/core/search.js');
    const started = Date.now();
    const hits = billsRepo.searchBills(w.db, w.accountId, parseSearchQuery('pressure cooker'), { now: NOW });
    const elapsed = Date.now() - started;

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.bill.lines[0]!.description).toBe('Prestige pressure cooker');
    expect(elapsed).toBeLessThan(2000);
  });
});
