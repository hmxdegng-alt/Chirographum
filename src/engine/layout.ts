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
  /** Identity of the first character: the key of a line that starts with this word. */
  key: number;
  plans: (GlyphPlan | null)[];
  chars: string[];
  /** Index in the text of every character of the word. */
  indices: number[];
}
type Token = WordToken | { kind: "space"; index: number; seed: number } | { kind: "break"; index: number; key: number };

const DEG = Math.PI / 180;
const EDGE_ZONE_MM = 35;
const MISSING_GAP = 0.6;
export const MAX_PAGES = 200;
/** Two drawings of the same letter closer than this (in characters) must differ. */
const REPEAT_WINDOW = 40;

/**
 * Identity of every character of a text: what keeps a letter looking the same
 * while the user edits around it. Without stored identities (tests, old
 * documents) each position gets one derived from its index.
 */
export function defaultCharIds(text: string): number[] {
  return Array.from({ length: text.length }, (_, i) => hashString(`char:${i}`));
}

/**
 * Chooses variants and random offsets for every character, independent of
 * line breaks. Everything about a letter comes from its own identity, so
 * typing in one place does not rewrite the rest of the page.
 */
function planGlyphs(text: string, ids: number[], hand: Hand, nat: Naturalness, seed: number): { tokens: Token[]; missing: string[] } {
  const tokens: Token[] = [];
  const missing = new Set<string>();
  /** Last occurrence of each letter: where it was, its own first choice and its simple choice. */
  const previous = new Map<string, { index: number; first: number; simple: number }>();
  let word: { chars: string[]; indices: number[] } = { chars: [], indices: [] };

  const planGlyph = (char: string, index: number): GlyphPlan | null => {
    const variants = hand.glyphs[char] ?? [];
    if (variants.length === 0) {
      missing.add(char);
      return null;
    }
    const id = ids[index] ?? hashString(`char:${index}`);
    const rng = createRng(deriveSeed(seed, "glyph", id));
    const z = [clampedGauss(rng), clampedGauss(rng), clampedGauss(rng), clampedGauss(rng), clampedGauss(rng)];
    // Never the same drawing twice in a row: that is what gives a fake away.
    // The choice only depends on this letter and the two before it (never on a
    // whole chain), so an edit changes at most the next two of the same letter.
    const n = variants.length;
    const first = rng.int(n);
    const candidates = Array.from({ length: n }, (_, k) => (first + k) % n);
    const near = previous.get(char);
    const before = near && index - near.index <= REPEAT_WINDOW ? near : null;
    // "Simple" choice: just avoid the previous letter's own first choice.
    const simple = before ? (candidates.find((v) => v !== before.first) ?? first) : first;
    // Final choice: also avoid the drawing the previous letter most likely got.
    const avoid = before ? (n > 2 ? [before.first, before.simple] : [before.simple]) : [];
    const final = candidates.find((v) => !avoid.includes(v)) ?? first;
    previous.set(char, { index, first, simple });
    const bounds = variantBounds(variants[final]);
    return {
      char,
      variantIndex: final,
      width: Math.max(0.05, bounds.maxX - bounds.minX),
      offsetX: -bounds.minX,
      size: Math.max(0.25, Math.min(3, 1 + z[0] * 0.09 * nat.sizeVariation)),
      rotation: z[1] * 4 * DEG * nat.rotation,
      slant: Math.tan(Math.max(-75, Math.min(75, nat.slantDegrees + z[2] * 7 * nat.slantVariation)) * DEG),
      lift: z[3] * 0.07 * nat.baselineWobble,
      spacing: Math.max(-0.9, z[4] * 0.45 * nat.spacingVariation),
      seed: deriveSeed(seed, "ink", id),
    };
  };

  const flushWord = () => {
    if (word.chars.length === 0) return;
    const plans = word.chars.map((char, i) => planGlyph(char, word.indices[i]));
    const key = ids[word.indices[0]] ?? word.indices[0];
    tokens.push({ kind: "word", key, plans, chars: word.chars, indices: word.indices });
    word = { chars: [], indices: [] };
  };

  let index = 0;
  for (const char of text) {
    if (char === "\n") {
      flushWord();
      tokens.push({ kind: "break", index, key: ids[index] ?? index });
    } else if (/\s/.test(char)) {
      flushWord();
      tokens.push({ kind: "space", index, seed: deriveSeed(seed, "space", ids[index] ?? index) });
    } else {
      word.chars.push(char);
      word.indices.push(index);
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

export function layoutText(
  rawText: string,
  hand: Hand,
  page: PageSettings,
  nat: Naturalness,
  seed: number,
  charIds?: number[],
): LayoutResult {
  const text = normaliseText(rawText);
  const ids = charIds && charIds.length === text.length ? charIds : defaultCharIds(text);
  const { tokens, missing } = planGlyphs(text, ids, hand, nat, seed);
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
  const maxDrift = (page.lineSpacingMm * 0.28 * Math.max(1, nat.lineDrift)) / Math.max(1, lineWidthMm);
  // The writer's own habit: every line goes a little uphill (positive) or downhill.
  const tendency = Math.tan((nat.lineSlope ?? 0) * DEG);
  let marginWalk = 0;
  let previousDrift = 0;
  let overflow = false;

  const marginLimit = 5 * Math.max(1, nat.marginDrift);
  // Each line's quirks come from the first thing written on it, so adding a
  // line higher up does not change every line below.
  const makeLine = (index: number, pageIndex: number, baselineMm: number, key: number | string): LineState => {
    const rng = createRng(deriveSeed(seed, "line", key));
    marginWalk = Math.max(-marginLimit, Math.min(marginLimit, marginWalk * 0.8 + clampedGauss(rng) * 1.3 * nat.marginDrift));
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
    return Math.max(0.3, 1 - nat.edgeShrink * 0.22 * Math.max(0, Math.min(1.3, into)));
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
  let line = makeLine(0, 0, firstBaselineMm, "first");
  let cursor = line.startXMm;
  let lineHasWords = false;

  const stopAt = (index: number, xMm: number) => {
    carets[index] = { page: line.page, line: line.index, xMm, yMm: baselineAt(line, xMm) };
  };

  const nextLine = (key: number): boolean => {
    lineIndex++;
    const rng = createRng(deriveSeed(seed, "spacing", key));
    let baseline = line.baselineMm + page.lineSpacingMm * (1 + clampedGauss(rng) * 0.035 * nat.lineDrift);
    if (baseline > bottomMm) {
      if (pageIndex + 1 >= MAX_PAGES) {
        overflow = true;
        return false;
      }
      pageIndex++;
      baseline = firstBaselineMm;
    }
    line = makeLine(lineIndex, pageIndex, baseline, key);
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
      if (!nextLine(token.key)) break;
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
      if (!nextLine(token.key)) break;
      attempt = placeWord(token.plans, token.chars, cursor, line);
    }
    if (attempt.endX > rightMm + overflowToleranceMm) {
      // A single word longer than the whole line: break it wherever it runs out.
      for (let i = 0; i < token.plans.length; i++) {
        let piece = placeWord([token.plans[i]], [token.chars[i]], cursor, line);
        if (piece.endX > rightMm + overflowToleranceMm && lineHasWords) {
          if (!nextLine(ids[token.indices[i]] ?? token.indices[i])) break outer;
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
