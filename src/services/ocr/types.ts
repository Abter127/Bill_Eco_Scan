/**
 * The OCR boundary.
 *
 * The capture pipeline (R-01) is specified in terms of what the engine must
 * *tell* us, not which engine it is. Every E3 edge case that the pipeline has
 * to handle needs a signal from this layer, so they are all part of the
 * contract rather than things a particular vendor happens to provide:
 *
 *   - per-line confidence          -> field-level gating, not document-level
 *   - detected scripts             -> Devanagari/Gurmukhi/Tamil from day one
 *   - screen detection             -> a photographed display is not an original
 *   - document count               -> two receipts in one photo get split
 *   - annotation regions           -> a handwritten correction over printed text
 *   - stitching report             -> a metre-long grocery receipt, multi-shot
 *   - isReceipt                    -> a menu or a photo of a wall is rejected
 */

export interface OcrLine {
  text: string;
  /** 0..1 for the whole line. */
  confidence: number;
  /** Normalised [x, y, w, h] within the page, for highlighting a flagged field. */
  bbox?: [number, number, number, number];
  /** Which document this line belongs to when several are in one photo. */
  documentIndex?: number;
}

export interface OcrAnnotation {
  /** What was written over the print — the user resolves it against the image. */
  note: string;
  bbox?: [number, number, number, number];
  /** The printed value underneath, where it is still legible. */
  printedValue?: string | null;
}

export interface StitchReport {
  segments: number;
  /** E3: detect and warn on a missing middle section. */
  missingMiddle: boolean;
  overlapConfidence: number;
}

export interface OcrResult {
  lines: OcrLine[];
  /** ISO 15924 codes, e.g. ['Latn', 'Deva']. */
  scripts: string[];
  /** E3: moiré / backlight signature of a photographed display. */
  screenDetected: boolean;
  /** E3: a receipt plus a warranty card plus a serial sticker. */
  documentCount: number;
  /** E3: "not a receipt at all" — reject with a specific reason. */
  isReceipt: boolean;
  rejectReason: string | null;
  annotations: OcrAnnotation[];
  stitch: StitchReport | null;
  /** Engine identifier, recorded on the bill for provenance. */
  engine: string;
}

export interface OcrAdapter {
  readonly name: string;
  recognise(imageRef: string): Promise<OcrResult>;
}

export function emptyOcrResult(engine: string, rejectReason: string): OcrResult {
  return {
    lines: [], scripts: [], screenDetected: false, documentCount: 0,
    isReceipt: false, rejectReason, annotations: [], stitch: null, engine,
  };
}
