// The point of a wooden pencil (graphite, coloured or charcoal) wears down as
// you write: the line gets wider and lighter, sometimes more on one side, until
// the writer sharpens it at a pause and it is fine again. Soft leads wear much
// faster than hard ones. Mechanical pencils, pens and markers never wear.
//
// Unlike a letter's look, which comes from its identity, this depends on how
// much was written before with that pencil (like "Cansancio"): an edit only
// nudges what follows, and sharpening always happens between words.

import type { LayoutResult } from "./layout";
import type { PenModel } from "./pens";
import { createRng, deriveSeed } from "./random";

/** How worn the point was when a letter was written. */
export interface PointState {
  /** 0 = just sharpened, 1 = completely blunt. */
  blunt: number;
  /** Direction of the flat side worn into the point (radians), when it wore unevenly. */
  facet: number;
  /** How lopsided the wear is (0 = round, evenly worn point). */
  uneven: number;
}

/** Letters an HB pencil writes at 100 % before its point is completely blunt. */
export const LETTERS_TO_BLUNT = 600;
/** Share of sharpenings after which the point wears more on one side. */
const UNEVEN_CHANCE = 0.4;
/** Past its limit, the writer waits for the end of a sentence or a line to sharpen, unless it gets this much blunter. */
const PATIENCE = 0.12;
const SENTENCE_END = /[.,;:!?]/;

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Works out the point of every letter written with a pencil that wears
 * (`point` on the glyph) and removes it from the rest. `amount` is the
 * "Punta que se gasta" setting (0 = always sharp). Each pencil keeps its own
 * point: every grade, and every colour of coloured pencil (the two ends of a
 * two-colour pencil too).
 */
export function applyPointWear(result: LayoutResult, instrumentOf: (style: number) => { pen: PenModel; color: string }, amount: number, seed: number): void {
  interface Point {
    blunt: number;
    /** Blunt enough that the writer sharpens it at the next pause. */
    limit: number;
    sharpenings: number;
    facet: number;
    uneven: number;
  }
  const points = new Map<string, Point>();
  /** What the point is like after each sharpening (from the pencil and how many times it was sharpened). */
  const sharpen = (key: string, n: number) => {
    const rng = createRng(deriveSeed(seed, "sharpen", key, n));
    return {
      limit: 0.55 + 0.45 * rng.next(),
      facet: rng.next() * Math.PI,
      uneven: rng.next() < UNEVEN_CHANCE ? 0.5 + 0.5 * rng.next() : 0,
    };
  };
  const glyphs = [...result.glyphs].sort((a, b) => a.index - b.index);
  let previous: (typeof glyphs)[number] | null = null;
  for (const glyph of glyphs) {
    delete glyph.point;
    const { pen, color } = instrumentOf(glyph.style ?? 0);
    const rate = Math.max(0, amount) * (pen.pointWear ?? 0);
    // A space or a new line before this letter: a moment to sharpen. The end of
    // a sentence or of a line is a better one.
    const pause = !previous || glyph.index > previous.index + 1;
    const newLine = !previous || result.carets[glyph.index]?.line !== result.carets[previous.index]?.line;
    const goodPause = pause && (newLine || (previous !== null && SENTENCE_END.test(previous.char)));
    previous = glyph;
    if (rate <= 0) continue;
    const key = pen.fixedColor ? pen.id : `${pen.id}|${color.toLowerCase()}`;
    let point = points.get(key);
    if (!point) {
      // The text does not start with a freshly sharpened pencil.
      const first = sharpen(key, 0);
      point = { ...first, blunt: first.limit * 0.6 * createRng(deriveSeed(seed, "point-start", key)).next(), sharpenings: 0 };
      points.set(key, point);
    }
    if ((point.blunt >= point.limit && goodPause) || (point.blunt >= point.limit + PATIENCE && pause)) {
      point.sharpenings++;
      Object.assign(point, sharpen(key, point.sharpenings), { blunt: 0 });
    }
    if (point.blunt > 0) glyph.point = { blunt: round3(Math.min(1, point.blunt)), facet: round3(point.facet), uneven: round3(point.uneven) };
    // Bigger letters use up more of the point.
    point.blunt += (rate * glyph.scale) / LETTERS_TO_BLUNT;
  }
}

/** Width multiplier of a worn point for a line going in direction `angle`. */
export function pointWidth(point: PointState, angle: number): number {
  const round = 1 + 0.55 * point.blunt;
  if (point.uneven <= 0) return round;
  // Drawn along the flat side the line stays thin; across it, wide.
  return round * (1 + point.uneven * point.blunt * 0.9 * (Math.abs(Math.sin(angle - point.facet)) - 0.5));
}

/** Tone multiplier of a worn point: the graphite is spread over more paper. */
export function pointTone(point: PointState): number {
  return 1 - 0.25 * point.blunt;
}
