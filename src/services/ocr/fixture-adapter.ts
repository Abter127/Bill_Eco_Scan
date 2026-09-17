import { readFile } from 'node:fs/promises';
import { emptyOcrResult, type OcrAdapter, type OcrResult } from './types.js';

/**
 * A deterministic OCR adapter backed by JSON sidecars.
 *
 * This is how the capture pipeline is developed and tested without pinning the
 * product to a vendor. `imageRef` points at a `.ocr.json` file shaped exactly
 * like `OcrResult`, which means every E3 edge case — a faded total, Devanagari
 * script, a photographed screen, two receipts in one frame — is a fixture
 * someone can add, and the pipeline's behaviour on it is a test rather than a
 * claim.
 *
 * A production adapter (a hosted OCR service, or an on-device model) implements
 * the same interface and the pipeline does not change.
 */
export class FixtureOcrAdapter implements OcrAdapter {
  readonly name = 'fixture';

  constructor(private readonly resolve: (imageRef: string) => string = (r) => `${r}.ocr.json`) {}

  async recognise(imageRef: string): Promise<OcrResult> {
    try {
      const raw = await readFile(this.resolve(imageRef), 'utf8');
      const parsed = JSON.parse(raw) as Partial<OcrResult>;
      return {
        lines: parsed.lines ?? [],
        scripts: parsed.scripts ?? ['Latn'],
        screenDetected: parsed.screenDetected ?? false,
        documentCount: parsed.documentCount ?? 1,
        isReceipt: parsed.isReceipt ?? true,
        rejectReason: parsed.rejectReason ?? null,
        annotations: parsed.annotations ?? [],
        stitch: parsed.stitch ?? null,
        engine: parsed.engine ?? this.name,
      };
    } catch (err) {
      return emptyOcrResult(this.name, `could not read OCR fixture: ${(err as Error).message}`);
    }
  }
}

/** In-memory variant for unit tests. */
export class StaticOcrAdapter implements OcrAdapter {
  readonly name = 'static';
  constructor(private readonly result: OcrResult) {}
  async recognise(): Promise<OcrResult> {
    return this.result;
  }
}
