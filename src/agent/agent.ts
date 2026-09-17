import { connect, createServer, type Server, type Socket } from 'node:net';
import { newClaimTokenSecret, newId } from '../core/ids.js';
import { parseEscPosStream } from '../core/escpos.js';
import { classifyDocument, documentTypeForStream } from '../core/classify.js';
import { extractBillFromText } from '../core/extract.js';
import { billPayloadSchema, type BillPayload } from '../core/schema.js';
import { Outbox } from './queue.js';

/**
 * The print-stream capture agent (M-01, M-03).
 *
 * Its acceptance criterion is that nobody notices it: "An unmodified legacy POS
 * produces structured bills; staff notice no difference."
 *
 * So it listens on TCP 9100 — the raw-printing port every Windows POS already
 * knows how to talk to — and forwards the bytes onward to the real printer.
 * The POS configuration changes by one line (the printer's host), the billing
 * software does not change at all, and the cashier's workflow is untouched.
 *
 * Everything expensive happens after the bytes have been passed through. The
 * paper comes out at the same speed whether we are online, offline, or on fire.
 */

export interface AgentConfig {
  serverUrl: string;
  terminalId: string;
  terminalSecret: string;
  outletId: string;
  /** Port to listen on for raw print jobs. 9100 is the convention. */
  listenPort?: number;
  /** Where to forward the bytes so paper still comes out. */
  printerHost?: string;
  printerPort?: number;
  queuePath?: string;
  flushIntervalMs?: number;
  heartbeatIntervalMs?: number;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface CaptureOutcome {
  fragments: number;
  enqueued: number;
  quarantinedLocally: number;
  /** Tokens minted locally because we could not reach the server. */
  offlineTokens: number;
  reasons: string[];
}

export class CaptureAgent {
  private readonly outbox: Outbox;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private flushTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private listener: Server | null = null;
  /** Set false by a failed flush, true by a successful one. */
  private online = true;

  constructor(private readonly config: AgentConfig) {
    this.outbox = new Outbox(config.queuePath);
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.now = config.now ?? (() => new Date());
  }

  // -------------------------------------------------------------------------
  // Capture
  // -------------------------------------------------------------------------

  /**
   * Handles one spool buffer. Never throws into the print path: an agent that
   * can crash a till is worse than no agent.
   */
  capture(bytes: Buffer): CaptureOutcome {
    const outcome: CaptureOutcome = {
      fragments: 0, enqueued: 0, quarantinedLocally: 0, offlineTokens: 0, reasons: [],
    };

    let fragments;
    try {
      fragments = parseEscPosStream(bytes);
    } catch (err) {
      outcome.reasons.push(`stream parse failed: ${(err as Error).message}`);
      return outcome;
    }
    outcome.fragments = fragments.length;

    for (const fragment of fragments) {
      try {
        if (!fragment.structurallyValid) {
          // E1 "two terminals, one printer": reject rather than guess. The
          // fragment is reported to the server as a quarantine event; it is
          // never turned into a customer bill.
          outcome.quarantinedLocally++;
          outcome.reasons.push(`invalid fragment: ${fragment.validationErrors.join(', ')}`);
          continue;
        }

        const classification = classifyDocument(fragment.lines);
        if (classification.quarantine) {
          // M-05's acceptance criterion, enforced at the edge so a restaurant's
          // kitchen tickets never even leave the premises.
          outcome.quarantinedLocally++;
          outcome.reasons.push(`${classification.streamClass}: ${classification.reason}`);
          continue;
        }

        const extracted = extractBillFromText(fragment.lines, {
          source: 'printed',
          captureDate: this.now(),
          merchantDateOrder: 'DMY',
        });
        if (extracted.grandTotalMinor === null) {
          outcome.quarantinedLocally++;
          outcome.reasons.push('no total on the slip');
          continue;
        }

        const subType = documentTypeForStream(fragment.lines);
        const payload: BillPayload = billPayloadSchema.parse({
          // The idempotency key is minted here, once, and never regenerated on
          // retry. This is what makes a four-hour replay safe.
          idempotencyKey: newId(),
          outletId: this.config.outletId,
          terminalId: this.config.terminalId,
          documentType: subType ?? (extracted.gstin ? 'tax_invoice' : 'bill_of_supply'),
          documentNumber: extracted.documentNumber,
          terminalTime: this.now().toISOString(),
          documentDateKey: extracted.documentDateKey,
          currency: extracted.currency,
          subtotalMinor: extracted.subtotalMinor,
          taxTotalMinor: extracted.taxTotalMinor,
          discountTotalMinor: extracted.discountTotalMinor,
          roundOffMinor: extracted.roundOffMinor,
          grandTotalMinor: extracted.grandTotalMinor,
          paymentMethod: extracted.paymentMethod,
          lines: extracted.lines,
          enqueuedAt: this.now().toISOString(),
        });

        // M-03: while offline we mint the claim token ourselves so the QR on
        // the slip is real. The server registers it on reconnect.
        const offline = this.online
          ? undefined
          : { secret: newClaimTokenSecret(), issuedAt: this.now().toISOString() };
        if (offline) outcome.offlineTokens++;

        this.outbox.enqueue(payload, offline, this.now());
        outcome.enqueued++;
      } catch (err) {
        outcome.reasons.push(`fragment failed: ${(err as Error).message}`);
      }
    }

    return outcome;
  }

  // -------------------------------------------------------------------------
  // Flush
  // -------------------------------------------------------------------------

  async flush(limit = 50): Promise<{ sent: number; failed: number; online: boolean }> {
    const due = this.outbox.due(this.now(), limit);
    let sent = 0;
    let failed = 0;

    for (const item of due) {
      try {
        const res = await this.fetchImpl(`${this.config.serverUrl}/api/v1/bills`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-terminal-id': this.config.terminalId,
            'x-terminal-secret': this.config.terminalSecret,
            'idempotency-key': item.idempotencyKey,
            ...(item.offlineClaimTokenSecret ? { 'x-offline-signed': 'true' } : {}),
          },
          body: JSON.stringify({
            ...item.payload,
            ...(item.offlineClaimTokenSecret
              ? {
                  offlineClaimToken: {
                    secret: item.offlineClaimTokenSecret,
                    issuedAt: item.offlineTokenIssuedAt,
                  },
                }
              : {}),
          }),
        });

        if (res.ok) {
          this.outbox.markSent(item.id, this.now());
          sent++;
          this.online = true;
          continue;
        }

        // A 4xx other than 429 will never succeed on retry; a 5xx or 429 will.
        // Retrying a permanent rejection forever would keep the outbox growing
        // and hide the real problem from the console, so it ends here.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          this.outbox.markRejected(item.id, `server rejected this bill with ${res.status}`);
          this.online = true;
          failed++;
          continue;
        }
        this.outbox.markFailed(item.id, `server returned ${res.status}`, this.now());
        failed++;
      } catch (err) {
        // Network failure. This is the four-hour-outage path: mark failed with
        // backoff and keep the row. Nothing is dropped.
        this.outbox.markFailed(item.id, (err as Error).message, this.now());
        this.online = false;
        failed++;
      }
    }

    return { sent, failed, online: this.online };
  }

  async heartbeat(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.config.serverUrl}/api/v1/heartbeat`, {
        method: 'POST',
        headers: {
          'x-terminal-id': this.config.terminalId,
          'x-terminal-secret': this.config.terminalSecret,
        },
      });
      this.online = res.ok;
      return res.ok;
    } catch {
      this.online = false;
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Listens on the raw-printing port and passes every byte through to the real
   * printer before doing anything with it.
   */
  listen(): Promise<number> {
    const port = this.config.listenPort ?? 9100;
    return new Promise((resolve, reject) => {
      this.listener = createServer((socket) => {
        const chunks: Buffer[] = [];
        const upstream = this.config.printerHost
          ? connectUpstream(this.config.printerHost, this.config.printerPort ?? 9100)
          : null;

        socket.on('data', (chunk: Buffer) => {
          // Paper first, always.
          upstream?.then((s) => s.write(chunk)).catch(() => undefined);
          chunks.push(chunk);
        });
        socket.on('error', () => undefined);
        socket.on('end', () => {
          upstream?.then((s) => s.end()).catch(() => undefined);
          const bytes = Buffer.concat(chunks);
          if (bytes.length > 0) {
            try {
              this.capture(bytes);
            } catch {
              // Never let capture failure reach the till.
            }
          }
        });
      });

      this.listener.once('error', reject);
      this.listener.listen(port, () => resolve(port));
    });
  }

  start(): void {
    const flushInterval = this.config.flushIntervalMs ?? 5_000;
    const heartbeatInterval = this.config.heartbeatIntervalMs ?? 60_000;

    this.flushTimer = setInterval(() => { void this.flush(); }, flushInterval);
    this.heartbeatTimer = setInterval(() => { void this.heartbeat(); }, heartbeatInterval);
    this.flushTimer.unref();
    this.heartbeatTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.listener) await new Promise<void>((r) => this.listener!.close(() => r()));
    this.outbox.close();
  }

  status(): ReturnType<Outbox['stats']> & { online: boolean } {
    return { ...this.outbox.stats(this.now()), online: this.online };
  }

  /** Test seam: force the agent into its offline behaviour. */
  setOnline(online: boolean): void {
    this.online = online;
  }
}

function connectUpstream(host: string, port: number): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = connect({ host, port }, () => resolve(socket));
    socket.once('error', reject);
  });
}
