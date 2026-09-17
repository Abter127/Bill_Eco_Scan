import type { Provenance } from './schema.js';

/**
 * Provenance ranking (R-03).
 *
 * Every bill shows its source, every user-corrected field is marked, and the
 * original extraction is always recoverable. When two records turn out to be
 * the same purchase, the higher-provenance one becomes canonical and the other
 * is kept as an attachment — we never discard the evidence, only demote it.
 */

const RANK: Record<Provenance, number> = {
  irp: 100,            // government e-invoice feed — signed at source
  pos_connector: 80,   // vendor integration, structured at source
  print_stream: 70,    // our agent read what the printer was sent
  merchant_manual: 50, // merchant typed it into the PWA
  photo_ocr: 30,       // customer photographed an original document
  photo_screen: 20,    // photograph of a screen — never an original (E3)
  user_manual: 10,     // customer typed it; no document behind it at all
};

export function provenanceRank(p: Provenance): number {
  return RANK[p];
}

export function higherProvenance(a: Provenance, b: Provenance): Provenance {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * Whether a record may be presented as a tax document. A photographed screen
 * is a forgery vector and a kacha bill has no GSTIN, so neither is evidence for
 * input tax credit however good the extraction was.
 */
export function canBeTaxEvidence(p: Provenance, hasGstin: boolean): boolean {
  if (p === 'photo_screen' || p === 'user_manual') return false;
  return hasGstin;
}

export interface ProvenanceBadge {
  label: string;
  /** Shown verbatim on the bill. The customer should never have to guess. */
  detail: string;
  /** Drives the visual weight of the badge, not access control. */
  tone: 'verified' | 'captured' | 'declared' | 'downgraded';
}

export function provenanceBadge(p: Provenance): ProvenanceBadge {
  switch (p) {
    case 'irp':
      return { label: 'e-Invoice', detail: 'Signed by the Invoice Registration Portal', tone: 'verified' };
    case 'pos_connector':
      return { label: 'From the shop', detail: 'Sent directly by the shop’s billing system', tone: 'verified' };
    case 'print_stream':
      return { label: 'From the counter', detail: 'Captured from the printed bill at the counter', tone: 'verified' };
    case 'merchant_manual':
      return { label: 'Entered by the shop', detail: 'Typed in by the shop, not from their billing system', tone: 'declared' };
    case 'photo_ocr':
      return { label: 'From your photo', detail: 'Read from the photo you took of the printed bill', tone: 'captured' };
    case 'photo_screen':
      return {
        label: 'Photo of a screen',
        detail: 'This is a photo of a screen, not of an original bill. It can be kept for reference but is not proof of purchase.',
        tone: 'downgraded',
      };
    case 'user_manual':
      return { label: 'Entered by you', detail: 'You typed these details; there is no document behind them', tone: 'declared' };
  }
}

/**
 * E3 "a photo of a screen showing a digital bill". The capture pipeline hands
 * us screen-detection evidence; provenance is downgraded regardless of how
 * cleanly the text extracted.
 */
export function applyScreenDetection(
  base: Provenance,
  screenDetected: boolean,
): { provenance: Provenance; downgraded: boolean; note: string | null } {
  if (!screenDetected || base !== 'photo_ocr') {
    return { provenance: base, downgraded: false, note: null };
  }
  return {
    provenance: 'photo_screen',
    downgraded: true,
    note: 'moiré/backlight pattern indicates a photograph of a display; provenance downgraded and the record is not treated as an original document',
  };
}
