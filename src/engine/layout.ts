// Places the characters of a text on pages as a person would write them:
// letters of slightly different size and angle, lines that rise or fall,
// a left margin that wanders and words that get squeezed near the edge.
// It also reports where the text cursor goes for every character, so the
// user can write directly on the page.

import { variantBounds, type Hand } from "./hand";
import { clampedGauss, createRng, deriveSeed, hashString } from "./random";
import type { Naturalness, PageSettings } from "./settings";

export interface PlacedGlyph {
  char: string;
  variantIndex: number;
  /** Page the glyph is on (0-based). */
  page: number;
  /** Left edge of the glyph's ink, on the page, in millimetres. */
  xMm: number;
  /** Baseline under the glyph, on the page, in millimetres (grows downwards). */
  yMm: number;
  /** Size multiplier on top of the page x-height. */
  scale: number;
  /** Rotation in radians; positive turns the letter anticlockwise. */
  rotation: number;
  /** Horizontal shear (tangent of the slant angle). */
  shear: number;
  /** Shift that moves the drawing's leftmost ink to x = 0, in x-height units. */
  offsetX: number;
  /** Seed for the renderer's per-glyph ink noise. */
  seed: number;
}

/** Where the text cursor stands before a character (or after the last one). */
export interface CaretStop {
  page: number;
  line: number;
  xMm: number;
  /** Baseline at the cursor, in millimetres. */
  yMm: number;
}

/** A character the hand has no drawing for: a gap, marked on screen only. */
export interface MissingBox {
  page: number;
  xMm: number;
  yMm: number;
  widthMm: number;
  char: string;
}

export interface LayoutResult {
  glyphs: PlacedGlyph[];
  /** Characters of the text the hand has no drawing for. */
  missing: string[];
  missingBoxes: MissingBox[];
  /** One stop per character of the text, plus one at the end. */
  carets: CaretStop[];
  pageCount: number;
  /** True when the text needs more than MAX_PAGES pages and was cut. */
  overflow: boolean;
  lineCount: number;
}

interface GlyphPlan {
  char: string;
  variantIndex: number;
  /** Ink width in x-height units, before scaling. */
  width: number;
  offsetX: number;
  size: number;
  rotation: number;
  slant: number;
  lift: number;
  spacing: number;
  seed: number;
}

interface WordToken {
  kind: "word";
  plans: (GlyphPlan | null)[];
  chars: string[];
  /** Index in the text of every character of the word. */
  indices: number[];
}
type Token = WordToken | { kind: "space"; index: number; seed: number } | { kind: "break"; index: number };

const DEG = Math.PI / 180;
const EDGE_ZONE_MM = 35;
const MISSING_GAP = 0.6;
export const MAX_PAGES = 200;

/**
 * Chooses variants and random offsets for every character, independent of
 * line breaks. Seeds come from the word itself (its text and how many times
 * it appeared before), so typing in one place does not rewrite the rest of
 * the page.
 */
function planGlyphs(text: string, hand: Hand, nat: Naturalness, seed: number): { tokens: Token[]; missing: string[] } {
  const tokens: Token[] = [];
  const missing = new Set<string>();
  const lastVariant = new Map<string, number>();
  const occurrences = new Map<string, number>();
  let chars: string[] = [];
  let indices: number[] = [];
  let lastWordKey = "start";

  const flushWord = () => {
    if (chars.length === 0) return;
    const wordText = chars.join("");
    const occurrence = occurrences.get(wordText) ?? 0;
    occurrences.set(wordText, occurrence + 1);
    const wordSeed = deriveSeed(seed, "word", hashString(wordText), occurrence);
    lastWordKey = `${hashString(wordText)}:${occurrence}`;
    const plans = chars.map((char, position): GlyphPlan | null => {
      const variants = hand.glyphs[char] ?? [];
      if (variants.length === 0) {
        missing.add(char);
        return null;
      }
      const rng = createRng(deriveSeed(wordSeed, "glyph", position));
      const z = [clampedGauss(rng), clampedGauss(rng), clampedGauss(rng), clampedGauss(rng), clampedGauss(rng)];
      // Never the same drawing twice in a row: that is what gives a fake away.
      const previous = lastVariant.get(char);
      let variantIndex = rng.int(variants.length);
      if (variants.length > 1 && variantIndex === previous) {
        variantIndex = (variantIndex + 1 + rng.int(variants.length - 1)) % variants.length;
      }
      lastVariant.set(char, variantIndex);
      const bounds = variantBounds(variants[variantIndex]);
      return {
        char,
        variantIndex,
        width: Math.max(0.05, bounds.maxX - bounds.minX),
        offsetX: -bounds.minX,
        size: Math.max(0.75, Math.min(1.3, 1 + z[0] * 0.09 * nat.sizeVariation)),
        rotation: z[1] * 4 * DEG * nat.rotation,
        slant: Math.tan((nat.slantDegrees + z[2] * 7 * nat.slantVariation) * DEG),
        lift: z[3] * 0.07 * nat.baselineWobble,
        spacing: Math.max(-0.6, z[4] * 0.45 * nat.spacingVariation),
        seed: deriveSeed(wordSeed, "ink", position),
      };
    });
    tokens.push({ kind: "word", plans, chars, indices });
    chars = [];
    indices = [];
  };

  let index = 0;
  for (const char of text) {
    if (char === "\n") {
      flushWord();
      tokens.push({ kind: "break", index });
    } else if (/\s/.test(char)) {
      flushWord();
      tokens.push({ kind: "space", index, seed: deriveSeed(seed, "space", lastWordKey) });
      lastWordKey += "+";
    } else {
      chars.push(char);
      indices.push(index);
    }
    index += char.length;
  }
  flushWord();
  return { tokens, missing: [...missing] };
}

interface LineState {
  index: number;
  page: number;
  baselineMm: number;
  startXMm: number;
  slope: number;
  wobbleAmpMm: number;
  wobblePeriodMm: number;
  wobblePhase: number;
}

/** Text with Windows or old Mac line endings normalised; the editor and the layout use the same string. */
export function normaliseText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function layoutText(rawText: string, hand: Hand, page: PageSettings, nat: Naturalness, seed: number): LayoutResult {
  const text = normaliseText(rawText);
  const { tokens, missing } = planGlyphs(text, hand, nat, seed);
  const xh = page.xHeightMm;
  const rightMm = page.widthMm - page.marginRightMm;
  const bottomMm = page.heightMm - page.marginBottomMm;
  const firstBaselineMm = page.marginTopMm + xh * 2.1;
  const overflowToleranceMm = 1.2 + nat.edgeShrink * 2.5;
  const glyphs: PlacedGlyph[] = [];
  const missingBoxes: MissingBox[] = [];
  const carets: CaretStop[] = new Array(text.length + 1);
  const lineWidthMm = rightMm - page.marginLeftMm;
  // Random drift never makes a line rise or fall more than this, so lines don't collide.
  const maxDrift = (page.lineSpacingMm * 0.28) / Math.max(1, lineWidthMm);
  // The writer's own habit: every line goes a little uphill (positive) or downhill.
  const tendency = Math.tan((nat.lineSlope ?? 0) * DEG);
  let marginWalk = 0;
  let previousDrift = 0;
  let overflow = false;

  const makeLine = (index: number, pageIndex: number, baselineMm: number): LineState => {
    const rng = createRng(deriveSeed(seed, "line", index));
    marginWalk = Math.max(-5, Math.min(5, marginWalk * 0.8 + clampedGauss(rng) * 1.3 * nat.marginDrift));
    // People copy the angle of the line above, so the drift is correlated.
    const drift = Math.max(-maxDrift, Math.min(maxDrift, previousDrift * 0.6 + Math.tan(clampedGauss(rng) * 0.55 * DEG * nat.lineDrift)));
    previousDrift = drift;
    return {
      index,
      page: pageIndex,
      baselineMm,
      startXMm: page.marginLeftMm + marginWalk,
      slope: tendency + drift,
      wobbleAmpMm: nat.lineDrift * 0.3 * rng.next(),
      wobblePeriodMm: 60 + rng.next() * 80,
      wobblePhase: rng.next() * Math.PI * 2,
    };
  };

  const baselineAt = (line: LineState, xMm: number): number => {
    const dx = xMm - line.startXMm;
    return line.baselineMm - line.slope * dx + line.wobbleAmpMm * Math.sin((2 * Math.PI * dx) / line.wobblePeriodMm + line.wobblePhase);
  };

  const shrinkAt = (xMm: number): number => {
    const into = (xMm - (rightMm - EDGE_ZONE_MM)) / EDGE_ZONE_MM;
    return 1 - nat.edgeShrink * 0.22 * Math.max(0, Math.min(1.3, into));
  };

  /** Places a word starting at startX; returns the glyphs, where each character starts and where the pen ends. */
  const placeWord = (plans: (GlyphPlan | null)[], chars: string[], startX: number, line: LineState) => {
    const placed: PlacedGlyph[] = [];
    const gaps: MissingBox[] = [];
    const starts: number[] = [];
    let x = startX;
    plans.forEach((plan, i) => {
      starts.push(x);
      if (!plan) {
        gaps.push({ page: line.page, xMm: x, yMm: baselineAt(line, x), widthMm: MISSING_GAP * xh, char: chars[i] });
        x += MISSING_GAP * xh + page.letterSpacing * xh;
        return;
      }
      const scale = plan.size * shrinkAt(x);
      placed.push({
        char: plan.char,
        variantIndex: plan.variantIndex,
        page: line.page,
        xMm: x,
        yMm: baselineAt(line, x) - plan.lift * xh,
        scale,
        rotation: plan.rotation,
        shear: plan.slant,
        offsetX: plan.offsetX,
        seed: plan.seed,
      });
      x += plan.width * xh * scale + page.letterSpacing * xh * scale * (1 + plan.spacing);
    });
    return { placed, gaps, starts, endX: x };
  };

  let lineIndex = 0;
  let pageIndex = 0;
  let line = makeLine(0, 0, firstBaselineMm);
  let cursor = line.startXMm;
  let lineHasWords = false;

  const stopAt = (index: number, xMm: number) => {
    carets[index] = { page: line.page, line: line.index, xMm, yMm: baselineAt(line, xMm) };
  };

  const nextLine = (): boolean => {
    lineIndex++;
    const rng = createRng(deriveSeed(seed, "spacing", lineIndex));
    let baseline = line.baselineMm + page.lineSpacingMm * (1 + clampedGauss(rng) * 0.035 * nat.lineDrift);
    if (baseline > bottomMm) {
      if (pageIndex + 1 >= MAX_PAGES) {
        overflow = true;
        return false;
      }
      pageIndex++;
      baseline = firstBaselineMm;
    }
    line = makeLine(lineIndex, pageIndex, baseline);
    cursor = line.startXMm;
    lineHasWords = false;
    return true;
  };

  const commit = (token: WordToken, result: ReturnType<typeof placeWord>, from = 0) => {
    glyphs.push(...result.placed);
    missingBoxes.push(...result.gaps);
    result.starts.forEach((x, i) => stopAt(token.indices[from + i], x));
    cursor = result.endX;
    lineHasWords = true;
  };

  outer: for (const token of tokens) {
    if (token.kind === "break") {
      stopAt(token.index, cursor);
      if (!nextLine()) break;
      continue;
    }
    if (token.kind === "space") {
      stopAt(token.index, cursor);
      if (!lineHasWords) continue;
      const rng = createRng(token.seed);
      cursor += page.wordSpacing * xh * Math.max(0.4, 1 + clampedGauss(rng) * 0.3 * nat.spacingVariation);
      continue;
    }
    let attempt = placeWord(token.plans, token.chars, cursor, line);
    if (attempt.endX > rightMm + overflowToleranceMm && lineHasWords) {
      if (!nextLine()) break;
      attempt = placeWord(token.plans, token.chars, cursor, line);
    }
    if (attempt.endX > rightMm + overflowToleranceMm) {
      // A single word longer than the whole line: break it wherever it runs out.
      for (let i = 0; i < token.plans.length; i++) {
        let piece = placeWord([token.plans[i]], [token.chars[i]], cursor, line);
        if (piece.endX > rightMm + overflowToleranceMm && lineHasWords) {
          if (!nextLine()) break outer;
          piece = placeWord([token.plans[i]], [token.chars[i]], cursor, line);
        }
        commit(token, piece, i);
      }
      continue;
    }
    commit(token, attempt);
  }

  // The end of the text, and anything cut off by the page limit, sits where the pen stopped.
  for (let i = carets.length - 1; i >= 0 && !carets[i]; i--) stopAt(i, cursor);
  for (let i = 0; i < carets.length; i++) if (!carets[i]) carets[i] = carets[i + 1] ?? carets[i - 1];

  return { glyphs, missing, missingBoxes, carets, pageCount: pageIndex + 1, overflow, lineCount: lineIndex + 1 };
}

/** Maps a point of a glyph drawing (x-height units, y up) to the page (mm, y down). */
export function glyphPointToPage(glyph: PlacedGlyph, xhMm: number, x: number, y: number): { x: number; y: number } {
  const u = x + glyph.offsetX + glyph.shear * y;
  const size = xhMm * glyph.scale;
  const su = u * size;
  const sv = y * size;
  const cos = Math.cos(glyph.rotation);
  const sin = Math.sin(glyph.rotation);
  return {
    x: glyph.xMm + su * cos - sv * sin,
    y: glyph.yMm - (su * sin + sv * cos),
  };
}
