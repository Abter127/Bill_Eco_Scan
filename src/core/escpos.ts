/**
 * ESC/POS stream parsing (M-01).
 *
 * The agent registers as a printer, so what arrives is the raw byte stream the
 * POS intended for thermal paper. Nothing about the POS changes; we read what
 * it was already going to print.
 *
 * E1 "Two terminals, one printer": concurrent tills interleave their bytes on a
 * shared spooler. The PRD's rule is explicit — frame on cut commands, and
 * *reject* any fragment that fails structural validation rather than guessing a
 * repair. A rejected fragment goes to the merchant quarantine queue, never to a
 * customer.
 */

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;
const CR = 0x0d;
const HT = 0x09;

export interface EscPosFragment {
  bytes: Buffer;
  /** Decoded, trimmed text lines with control sequences removed. */
  lines: string[];
  /** A fragment ended by GS V is a complete document; a trailing one may not be. */
  terminatedByCut: boolean;
  structurallyValid: boolean;
  validationErrors: string[];
  /** Number of printer-initialise sequences seen inside the fragment body. */
  interleaveSignals: number;
}

/** Codepages seen in Indian retail. Devanagari/Tamil slips are usually UTF-8. */
export type ReceiptEncoding = 'utf8' | 'latin1' | 'cp437';

function decodeBytes(buf: Buffer, encoding: ReceiptEncoding): string {
  if (encoding === 'utf8') {
    const text = buf.toString('utf8');
    // A mis-declared codepage shows up as replacement characters; fall back
    // rather than hand the extractor mojibake it will silently mis-read.
    if (text.includes('�')) return buf.toString('latin1');
    return text;
  }
  return buf.toString('latin1');
}

/**
 * Length of the ESC/POS command starting at `i`, including its parameters.
 * Returns 0 when the byte is not a command introducer.
 */
function commandLength(buf: Buffer, i: number): number {
  const b = buf[i];
  if (b === ESC) {
    const c = buf[i + 1];
    switch (c) {
      case 0x40: return 2;                        // ESC @  initialise
      case 0x21: case 0x2d: case 0x61: case 0x4d: // ESC ! - a M
      case 0x7b: case 0x45: case 0x47: case 0x56:
      case 0x72: case 0x74: case 0x63: case 0x53:
        return 3;
      case 0x44: {                                // ESC D  tab stops, NUL-terminated
        let j = i + 2;
        while (j < buf.length && buf[j] !== 0x00) j++;
        return j - i + 1;
      }
      case 0x64: case 0x4a: case 0x4b: case 0x33: // ESC d J K 3
      case 0x70: return c === 0x70 ? 5 : 3;       // ESC p  pulse
      case 0x24: case 0x5c: return 4;             // ESC $ \  absolute/relative pos
      default: return c === undefined ? 1 : 2;
    }
  }
  if (b === GS) {
    const c = buf[i + 1];
    switch (c) {
      case 0x56: {                                // GS V  cut
        const m = buf[i + 2];
        // GS V m, and GS V m n for the feed-and-cut forms.
        return m === 0x41 || m === 0x42 || m === 0x61 || m === 0x67 || m === 65 || m === 66 ? 4 : 3;
      }
      case 0x21: case 0x42: case 0x62: case 0x66:
      case 0x48: case 0x68: case 0x77: return 3;  // GS ! B b f H h w
      case 0x4c: case 0x57: case 0x50: return 4;  // GS L W P
      case 0x6b: {                                // GS k  barcode
        let j = i + 3;
        const sym = buf[i + 2] ?? 0;
        if (sym >= 65) {                          // GS k m n d1..dn
          const n = buf[i + 3] ?? 0;
          return 4 + n;
        }
        while (j < buf.length && buf[j] !== 0x00) j++; // NUL-terminated form
        return j - i + 1;
      }
      case 0x28: {                                // GS ( fn  pL pH ...
        const pL = buf[i + 2] ?? 0;
        const pH = buf[i + 3] ?? 0;
        return 4 + pL + pH * 256;
      }
      case 0x76: {                                // GS v 0  raster image
        const xL = buf[i + 4] ?? 0, xH = buf[i + 5] ?? 0;
        const yL = buf[i + 6] ?? 0, yH = buf[i + 7] ?? 0;
        return 8 + (xL + xH * 256) * (yL + yH * 256);
      }
      default: return c === undefined ? 1 : 2;
    }
  }
  return 0;
}

function isCutAt(buf: Buffer, i: number): boolean {
  return buf[i] === GS && buf[i + 1] === 0x56;
}

function isInitAt(buf: Buffer, i: number): boolean {
  return buf[i] === ESC && buf[i + 1] === 0x40;
}

/**
 * Splits a raw spool buffer into fragments on cut boundaries. The cut itself
 * belongs to the fragment it terminates.
 */
export function splitOnCutBoundaries(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let start = 0;
  let i = 0;
  while (i < buf.length) {
    if (isCutAt(buf, i)) {
      const len = commandLength(buf, i);
      out.push(buf.subarray(start, i + len));
      i += len;
      start = i;
      continue;
    }
    const len = commandLength(buf, i);
    i += len > 0 ? len : 1;
  }
  if (start < buf.length) out.push(buf.subarray(start));
  return out.filter((b) => b.length > 0);
}

/** Strips control sequences and returns printable text lines. */
export function decodeFragment(
  buf: Buffer,
  encoding: ReceiptEncoding = 'utf8',
): { lines: string[]; terminatedByCut: boolean; interleaveSignals: number } {
  const text: number[] = [];
  let terminatedByCut = false;
  let interleaveSignals = 0;
  let i = 0;
  let sawPrintable = false;

  while (i < buf.length) {
    const b = buf[i]!;
    if (isCutAt(buf, i)) {
      terminatedByCut = true;
      i += commandLength(buf, i);
      continue;
    }
    if (isInitAt(buf, i)) {
      // An initialise after content has already been printed means a second
      // print job spliced into this one.
      if (sawPrintable) interleaveSignals++;
      i += 2;
      continue;
    }
    const len = commandLength(buf, i);
    if (len > 0) {
      i += len;
      continue;
    }
    if (b === LF || b === CR) {
      text.push(LF);
      i++;
      continue;
    }
    if (b === HT) {
      text.push(0x20);
      i++;
      continue;
    }
    if (b < 0x20) {
      i++; // any remaining control byte is not content
      continue;
    }
    text.push(b);
    sawPrintable = true;
    i++;
  }

  const decoded = decodeBytes(Buffer.from(text), encoding);
  const lines = decoded
    .split('\n')
    .map((l) => l.replace(/\s+$/g, '').replace(/^\s+/, (m) => ' '.repeat(Math.min(m.length, 40))))
    .map((l) => l.trimEnd());

  // Collapse the run of blank lines a printer feeds before the cut.
  while (lines.length && lines[lines.length - 1]!.trim() === '') lines.pop();
  while (lines.length && lines[0]!.trim() === '') lines.shift();

  return { lines, terminatedByCut, interleaveSignals };
}

export interface ParseStreamOptions {
  encoding?: ReceiptEncoding;
  /** Minimum printable lines before a fragment can be a document at all. */
  minLines?: number;
}

/**
 * Frames and validates a spool buffer. Invalid fragments come back with
 * `structurallyValid: false` and their reasons — the caller quarantines them.
 */
export function parseEscPosStream(
  buf: Buffer,
  opts: ParseStreamOptions = {},
): EscPosFragment[] {
  const encoding = opts.encoding ?? 'utf8';
  const minLines = opts.minLines ?? 3;

  return splitOnCutBoundaries(buf).map((bytes) => {
    const { lines, terminatedByCut, interleaveSignals } = decodeFragment(bytes, encoding);
    const nonEmpty = lines.filter((l) => l.trim() !== '');
    const errors: string[] = [];

    if (nonEmpty.length < minLines) errors.push('too-few-printable-lines');
    if (interleaveSignals > 0) errors.push('interleaved-print-jobs');
    if (!terminatedByCut) errors.push('no-cut-boundary');
    // A document whose bytes are mostly unprintable is a raster logo or a
    // truncated splice, not a receipt.
    const printableRatio = nonEmpty.join('').length / Math.max(bytes.length, 1);
    if (printableRatio < 0.05) errors.push('insufficient-text-content');

    return {
      bytes,
      lines,
      terminatedByCut,
      interleaveSignals,
      structurallyValid: errors.length === 0,
      validationErrors: errors,
    };
  });
}
