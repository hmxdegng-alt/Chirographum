// Places the characters of a text on the page as a person would write them:
// letters of slightly different size and angle, lines that rise or fall,
// a left margin that wanders and words that get squeezed near the edge.

import { variantBounds, type Hand } from "./hand";
import { clampedGauss, createRng, deriveSeed } from "./random";
import type { Naturalness, PageSettings } from "./settings";

export interface PlacedGlyph {
  char: string;
  variantIndex: number;
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

export interface LayoutResult {
  glyphs: PlacedGlyph[];
  /** Characters of the text the hand has no drawing for. */
  missing: string[];
  /** True when the text did not fit on the page and was cut. */
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

type Token = { kind: "word"; plans: (GlyphPlan | null)[] } | { kind: "space"; index: number } | { kind: "break" };

const DEG = Math.PI / 180;
const EDGE_ZONE_MM = 35;
const MISSING_GAP = 0.6;

/** Chooses variants and random offsets for every character, independent of line breaks. */
function planGlyphs(text: string, hand: Hand, nat: Naturalness, seed: number): { tokens: Token[]; missing: string[] } {
  const tokens: Token[] = [];
  const missing = new Set<string>();
  const lastVariant = new Map<string, number>();
  let glyphIndex = 0;
  let spaceIndex = 0;
  let word: (GlyphPlan | null)[] = [];

  const flushWord = () => {
    if (word.length > 0) tokens.push({ kind: "word", plans: word });
    word = [];
  };

  for (const char of text.replace(/\r\n?/g, "\n")) {
    if (char === "\n") {
      flushWord();
      tokens.push({ kind: "break" });
      continue;
    }
    if (/\s/.test(char)) {
      flushWord();
      tokens.push({ kind: "space", index: spaceIndex++ });
      continue;
    }
    const variants = hand.glyphs[char] ?? [];
    if (variants.length === 0) {
      missing.add(char);
      word.push(null);
      glyphIndex++;
      continue;
    }
    const rng = createRng(deriveSeed(seed, "glyph", glyphIndex));
    const z = [clampedGauss(rng), clampedGauss(rng), clampedGauss(rng), clampedGauss(rng), clampedGauss(rng)];
    // Never the same drawing twice in a row: that is what gives a fake away.
    const previous = lastVariant.get(char);
    let variantIndex = rng.int(variants.length);
    if (variants.length > 1 && variantIndex === previous) {
      variantIndex = (variantIndex + 1 + rng.int(variants.length - 1)) % variants.length;
    }
    lastVariant.set(char, variantIndex);
    const bounds = variantBounds(variants[variantIndex]);
    word.push({
      char,
      variantIndex,
      width: Math.max(0.05, bounds.maxX - bounds.minX),
      offsetX: -bounds.minX,
      size: Math.max(0.75, Math.min(1.3, 1 + z[0] * 0.09 * nat.sizeVariation)),
      rotation: z[1] * 4 * DEG * nat.rotation,
      slant: Math.tan((nat.slantDegrees + z[2] * 7 * nat.slantVariation) * DEG),
      lift: z[3] * 0.07 * nat.baselineWobble,
      spacing: Math.max(-0.6, z[4] * 0.45 * nat.spacingVariation),
      seed: deriveSeed(seed, "ink", glyphIndex),
    });
    glyphIndex++;
  }
  flushWord();
  return { tokens, missing: [...missing] };
}

interface LineState {
  index: number;
  baselineMm: number;
  startXMm: number;
  slope: number;
  wobbleAmpMm: number;
  wobblePeriodMm: number;
  wobblePhase: number;
}

export function layoutText(text: string, hand: Hand, page: PageSettings, nat: Naturalness, seed: number): LayoutResult {
  const { tokens, missing } = planGlyphs(text, hand, nat, seed);
  const xh = page.xHeightMm;
  const rightMm = page.widthMm - page.marginRightMm;
  const bottomMm = page.heightMm - page.marginBottomMm;
  const overflowToleranceMm = 1.2 + nat.edgeShrink * 2.5;
  const glyphs: PlacedGlyph[] = [];
  const lineWidthMm = rightMm - page.marginLeftMm;
  // A line never rises or falls more than this over its length, so lines don't collide.
  const maxSlope = (page.lineSpacingMm * 0.28) / Math.max(1, lineWidthMm);
  let marginWalk = 0;
  let previousSlope = 0;
  let overflow = false;

  const makeLine = (index: number, baselineMm: number): LineState => {
    const rng = createRng(deriveSeed(seed, "line", index));
    marginWalk = Math.max(-5, Math.min(5, marginWalk * 0.8 + clampedGauss(rng) * 1.3 * nat.marginDrift));
    // People copy the angle of the line above, so the drift is correlated.
    const slope = Math.max(-maxSlope, Math.min(maxSlope, previousSlope * 0.6 + Math.tan(clampedGauss(rng) * 0.55 * DEG * nat.lineDrift)));
    previousSlope = slope;
    return {
      index,
      baselineMm,
      startXMm: page.marginLeftMm + marginWalk,
      slope,
      wobbleAmpMm: nat.lineDrift * 0.3 * rng.next(),
      wobblePeriodMm: 60 + rng.next() * 80,
      wobblePhase: rng.next() * Math.PI * 2,
    };
  };

  const baselineAt = (line: LineState, xMm: number): number => {
    const dx = xMm - line.startXMm;
    return line.baselineMm + line.slope * dx + line.wobbleAmpMm * Math.sin((2 * Math.PI * dx) / line.wobblePeriodMm + line.wobblePhase);
  };

  const shrinkAt = (xMm: number): number => {
    const into = (xMm - (rightMm - EDGE_ZONE_MM)) / EDGE_ZONE_MM;
    return 1 - nat.edgeShrink * 0.22 * Math.max(0, Math.min(1.3, into));
  };

  /** Places a word starting at startX; returns the glyphs and where the pen ends. */
  const placeWord = (plans: (GlyphPlan | null)[], startX: number, line: LineState) => {
    const placed: PlacedGlyph[] = [];
    let x = startX;
    for (const plan of plans) {
      if (!plan) {
        x += MISSING_GAP * xh;
        continue;
      }
      const scale = plan.size * shrinkAt(x);
      placed.push({
        char: plan.char,
        variantIndex: plan.variantIndex,
        xMm: x,
        yMm: baselineAt(line, x) - plan.lift * xh,
        scale,
        rotation: plan.rotation,
        shear: plan.slant,
        offsetX: plan.offsetX,
        seed: plan.seed,
      });
      x += plan.width * xh * scale + page.letterSpacing * xh * scale * (1 + plan.spacing);
    }
    return { placed, endX: x };
  };

  let lineIndex = 0;
  let line = makeLine(0, page.marginTopMm + xh * 2.1);
  let cursor = line.startXMm;
  let lineHasWords = false;

  const nextLine = (): boolean => {
    lineIndex++;
    const rng = createRng(deriveSeed(seed, "spacing", lineIndex));
    const baseline = line.baselineMm + page.lineSpacingMm * (1 + clampedGauss(rng) * 0.035 * nat.lineDrift);
    if (baseline > bottomMm) {
      overflow = true;
      return false;
    }
    line = makeLine(lineIndex, baseline);
    cursor = line.startXMm;
    lineHasWords = false;
    return true;
  };

  outer: for (const token of tokens) {
    if (token.kind === "break") {
      if (!nextLine()) break;
      continue;
    }
    if (token.kind === "space") {
      if (!lineHasWords) continue;
      const rng = createRng(deriveSeed(seed, "space", token.index));
      cursor += page.wordSpacing * xh * Math.max(0.4, 1 + clampedGauss(rng) * 0.3 * nat.spacingVariation);
      continue;
    }
    let attempt = placeWord(token.plans, cursor, line);
    if (attempt.endX > rightMm + overflowToleranceMm && lineHasWords) {
      if (!nextLine()) break;
      attempt = placeWord(token.plans, cursor, line);
    }
    if (attempt.endX > rightMm + overflowToleranceMm) {
      // A single word longer than the whole line: break it wherever it runs out.
      for (const plan of token.plans) {
        let piece = placeWord([plan], cursor, line);
        if (piece.endX > rightMm + overflowToleranceMm && lineHasWords) {
          if (!nextLine()) break outer;
          piece = placeWord([plan], cursor, line);
        }
        glyphs.push(...piece.placed);
        cursor = piece.endX;
        lineHasWords = true;
      }
      continue;
    }
    glyphs.push(...attempt.placed);
    cursor = attempt.endX;
    lineHasWords = true;
  }

  return { glyphs, missing, overflow, lineCount: lineIndex + 1 };
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
