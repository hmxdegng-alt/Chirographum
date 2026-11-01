// Places the characters of a text on pages as a person would write them:
// letters of slightly different size and angle, lines that rise or fall,
// a left margin that wanders and words that get squeezed near the edge.
// It also reports where the text cursor goes for every character, so the
// user can write directly on the page.

import { variantBounds, type Hand } from "./hand";
import { clampedGauss, createRng, deriveSeed, hashString } from "./random";
import {
  BOLD,
  correctionOf,
  decodeParagraph,
  HIGHLIGHT,
  highlightColorIndex,
  isUnder,
  ITALIC,
  runStyleIndex,
  SCRIBBLE,
  scribbleStyleOf,
  STRIKE,
  STYLE_LOOK,
  UNDERLINE,
  type Alignment,
  withRunStyle,
  type RunStyle,
} from "./rich-text";
import { paperFirstLine, paperRuling, type Naturalness, type PageSettings, type PaperSettings } from "./settings";

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
  /** Index of the character in the text. */
  index: number;
  /** Width of the ink on the page, in millimetres. */
  widthMm: number;
  /** Bold: the writer goes over the letter a second time. */
  bold: boolean;
  /** Run style (instrument, colour, size) of the letter; 0 = the document's. */
  style: number;
  /** Rubbed out with an eraser: only a faint trace is left. */
  erased?: boolean;
}

/**
 * Something drawn by hand over or under the text: underline, strikethrough,
 * highlighter, scribble, correction tape or eraser marks.
 */
export interface Decoration {
  kind: "underline" | "strike" | "highlight" | "scribble" | "tipex" | "erased";
  page: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Letter size where it is drawn (x-height in millimetres). */
  xhMm: number;
  /** Highlighter colour (index in HIGHLIGHT_COLORS). */
  color: number;
  /** Run style of the words it is drawn on (instrument and colour). */
  style: number;
  seed: number;
  /** First and last character of the text it covers. */
  start: number;
  end: number;
}

/** Formatting and paper, all optional: without them the text is plain. */
export interface LayoutFormat {
  /** Marks of every character (bold, italic, underline…). */
  marks?: number[];
  /** Format of every paragraph (style and alignment). */
  paragraphs?: number[];
  paper?: PaperSettings;
  /** Titles get a line drawn under them. */
  titleUnderline?: boolean;
  /** Instruments, colours and sizes chosen for parts of the text. */
  runStyles?: RunStyle[];
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
  decorations: Decoration[];
  /** Letters written before correction tape went over them (not part of the text). */
  hidden: PlacedGlyph[];
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
  /** The letter's own deviations from a perfect letter; tiredness makes them grow. */
  sizeDev: number;
  rotation: number;
  /** The writer's slant (and italic), in degrees, and this letter's deviation from it. */
  slantBase: number;
  slantDev: number;
  lift: number;
  spacing: number;
  /** Size chosen by the user for a selection. */
  runSize: number;
  seed: number;
  index: number;
  bold: boolean;
  style: number;
}

/** Size, angle and offsets of a planned letter for a writer this tired (1 = fresh). */
function lookOf(plan: GlyphPlan, tired: number): { size: number; rotation: number; slant: number; lift: number; spacing: number } {
  return {
    size: Math.max(0.25, Math.min(3, 1 + plan.sizeDev * tired)) * plan.runSize,
    rotation: plan.rotation * tired,
    slant: Math.tan(Math.max(-75, Math.min(75, plan.slantBase + plan.slantDev * tired)) * DEG),
    lift: plan.lift * tired,
    spacing: Math.max(-0.9, plan.spacing * tired),
  };
}

interface WordToken {
  kind: "word";
  /** Identity of the first character: the key of a line that starts with this word. */
  key: number;
  plans: (GlyphPlan | null)[];
  chars: string[];
  /** Index in the text of every character of the word. */
  indices: number[];
  paragraph: number;
}
type Token =
  | WordToken
  | { kind: "space"; index: number; seed: number; paragraph: number }
  | { kind: "break"; index: number; key: number; paragraph: number };

const DEG = Math.PI / 180;
const EDGE_ZONE_MM = 35;
const MISSING_GAP = 0.6;
export const MAX_PAGES = 200;
/** Two drawings of the same letter closer than this (in characters) must differ. */
const REPEAT_WINDOW = 40;
/** Italic: extra slant, in degrees. */
const ITALIC_SLANT = 13;
/** Bold letters take a little more room. */
const BOLD_SPACING = 0.05;

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
function planGlyphs(
  text: string,
  ids: number[],
  marks: number[],
  runStyles: RunStyle[],
  hand: Hand,
  nat: Naturalness,
  seed: number,
): { tokens: Token[]; missing: string[] } {
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
    const mark = marks[index] ?? 0;
    const italic = mark & ITALIC ? ITALIC_SLANT : 0;
    const style = runStyleIndex(mark);
    const runSize = style > 0 ? runStyles[style - 1]?.size ?? 1 : 1;
    return {
      char,
      variantIndex: final,
      width: Math.max(0.05, bounds.maxX - bounds.minX),
      offsetX: -bounds.minX,
      sizeDev: z[0] * 0.09 * nat.sizeVariation,
      rotation: z[1] * 4 * DEG * nat.rotation,
      slantBase: nat.slantDegrees + italic,
      slantDev: z[2] * 7 * nat.slantVariation,
      lift: z[3] * 0.07 * nat.baselineWobble,
      spacing: z[4] * 0.45 * nat.spacingVariation,
      runSize,
      seed: deriveSeed(seed, "ink", id),
      index,
      bold: Boolean(mark & BOLD),
      style,
    };
  };

  const flushWord = () => {
    if (word.chars.length === 0) return;
    const plans = word.chars.map((char, i) => planGlyph(char, word.indices[i]));
    const key = ids[word.indices[0]] ?? word.indices[0];
    tokens.push({ kind: "word", key, plans, chars: word.chars, indices: word.indices, paragraph });
    word = { chars: [], indices: [] };
  };

  let index = 0;
  let paragraph = 0;
  for (const char of text) {
    if (char === "\n") {
      flushWord();
      tokens.push({ kind: "break", index, key: ids[index] ?? index, paragraph });
      paragraph++;
    } else if (/\s/.test(char)) {
      flushWord();
      tokens.push({ kind: "space", index, seed: deriveSeed(seed, "space", ids[index] ?? index), paragraph });
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
  /** Letter size of the line's paragraph (1 = normal text). */
  scale: number;
  /** Size that decides the distance to the neighbouring lines (bigger words included). */
  spacingScale: number;
  align: Alignment;
  /** Where this line's glyphs, gaps and cursor stops start, to move them when centring. */
  firstGlyph: number;
  firstGap: number;
  stops: number[];
  baselineMm: number;
  /** How tired the writer is on this line (1 = fresh): multiplies the imperfections. */
  tired: number;
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
  format: LayoutFormat = {},
): LayoutResult {
  const text = normaliseText(rawText);
  const ids = charIds && charIds.length === text.length ? charIds : defaultCharIds(text);
  const marks = format.marks && format.marks.length === text.length ? format.marks : [];
  const paragraphFormats = format.paragraphs ?? [];
  const paragraphOf = (p: number) => decodeParagraph(paragraphFormats[p] ?? 0);
  const runStyles = format.runStyles ?? [];
  const { tokens, missing } = planGlyphs(text, ids, marks, runStyles, hand, nat, seed);
  // Bigger words chosen by the user push the lines of their paragraph apart.
  const paragraphRunSize: number[] = [];
  {
    let p = 0;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) {
        p++;
        continue;
      }
      const style = runStyleIndex(marks[i] ?? 0);
      const size = style > 0 ? runStyles[style - 1]?.size ?? 1 : 1;
      paragraphRunSize[p] = Math.max(paragraphRunSize[p] ?? 1, size);
    }
  }
  const lineScaleOf = (paragraph: number) => STYLE_LOOK[paragraphOf(paragraph).style].scale * Math.max(1, paragraphRunSize[paragraph] ?? 1);
  const baseXh = page.xHeightMm;
  const ruling = format.paper ? paperRuling(format.paper) : null;
  const rulingStart = format.paper ? paperFirstLine(format.paper) : 0;
  const rightMm = page.widthMm - page.marginRightMm;
  const bottomMm = page.heightMm - page.marginBottomMm;
  /** On ruled paper the text sits on the lines. */
  const snap = (y: number, after = -Infinity): number => {
    if (!ruling) return y;
    let k = Math.ceil((y - rulingStart - ruling * 0.45) / ruling);
    while (rulingStart + k * ruling < after + ruling * 0.5) k++;
    return rulingStart + k * ruling;
  };
  const firstBaselineMm = snap(page.marginTopMm + baseXh * lineScaleOf(0) * 2.1);
  const overflowToleranceMm = 1.2 + nat.edgeShrink * 2.5;
  const glyphs: PlacedGlyph[] = [];
  const missingBoxes: MissingBox[] = [];
  const carets: CaretStop[] = new Array(text.length + 1);
  const lineWidthMm = rightMm - page.marginLeftMm;
  // Random drift never makes a line rise or fall more than this, so lines don't collide.
  const maxDrift = (page.lineSpacingMm * 0.28 * Math.max(1, nat.lineDrift)) / Math.max(1, lineWidthMm);
  /** Each letter remembers where it went, to draw underlines and highlighter. */
  const glyphByIndex = new Map<number, PlacedGlyph>();
  // The writer's own habit: every line goes a little uphill (positive) or downhill.
  const tendency = Math.tan((nat.lineSlope ?? 0) * DEG);
  let marginWalk = 0;
  let previousDrift = 0;
  let overflow = false;

  const marginLimit = 5 * Math.max(1, nat.marginDrift);
  // Each line's quirks come from the first thing written on it, so adding a
  // line higher up does not change every line below.
  /** Tiredness grows smoothly down each page and from page to page (it stops growing after a few pages). */
  const tiredAt = (pageIndex: number, baselineMm: number): number => {
    const down = Math.max(0, Math.min(1, (baselineMm - firstBaselineMm) / Math.max(1, bottomMm - firstBaselineMm)));
    return 1 + (nat.fatigue ?? 0) * Math.min(2.5, 0.8 * (pageIndex + down));
  };
  const makeLine = (index: number, pageIndex: number, baselineMm: number, key: number | string, paragraph: number): LineState => {
    const rng = createRng(deriveSeed(seed, "line", key));
    const tired = tiredAt(pageIndex, baselineMm);
    const limit = marginLimit * Math.min(1.6, tired);
    marginWalk = Math.max(-limit, Math.min(limit, marginWalk * 0.8 + clampedGauss(rng) * 1.3 * nat.marginDrift * tired));
    // People copy the angle of the line above, so the drift is correlated.
    const most = maxDrift * Math.min(1.6, tired);
    const drift = Math.max(-most, Math.min(most, previousDrift * 0.6 + Math.tan(clampedGauss(rng) * 0.55 * DEG * nat.lineDrift * tired)));
    previousDrift = drift;
    const format = paragraphOf(paragraph);
    return {
      index,
      page: pageIndex,
      scale: STYLE_LOOK[format.style].scale,
      spacingScale: lineScaleOf(paragraph),
      align: format.align,
      firstGlyph: glyphs.length,
      firstGap: missingBoxes.length,
      stops: [],
      baselineMm,
      tired,
      startXMm: page.marginLeftMm + marginWalk,
      slope: tendency + drift,
      wobbleAmpMm: nat.lineDrift * 0.3 * rng.next() * tired,
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

  /**
   * Places a word starting at startX; returns the glyphs, where each character
   * starts, where the pen goes on from and how far the ink reaches. Letters
   * written over or rubbed out send the pen back to where they began, so what
   * follows is written on top of them.
   */
  const placeWord = (plans: (GlyphPlan | null)[], chars: string[], indices: number[], startX: number, line: LineState, plain = false) => {
    const xh = baseXh * line.scale;
    const placed: PlacedGlyph[] = [];
    const gaps: MissingBox[] = [];
    const starts: number[] = [];
    let x = startX;
    let underFrom: number | null = null;
    let reach = startX;
    plans.forEach((plan, i) => {
      const under = !plain && isUnder(marks[indices[i]] ?? 0);
      if (under && underFrom === null) underFrom = x;
      if (!under && underFrom !== null) {
        reach = Math.max(reach, x);
        x = underFrom;
        underFrom = null;
      }
      starts.push(x);
      if (!plan) {
        gaps.push({ page: line.page, xMm: x, yMm: baselineAt(line, x), widthMm: MISSING_GAP * xh, char: chars[i] });
        x += MISSING_GAP * xh + page.letterSpacing * xh;
        return;
      }
      const look = lookOf(plan, line.tired);
      const scale = look.size * shrinkAt(x) * line.scale;
      const widthMm = plan.width * baseXh * scale;
      placed.push({
        char: plan.char,
        variantIndex: plan.variantIndex,
        page: line.page,
        xMm: x,
        yMm: baselineAt(line, x) - look.lift * xh,
        scale,
        rotation: look.rotation,
        shear: look.slant,
        offsetX: plan.offsetX,
        seed: plan.seed,
        index: plan.index,
        widthMm,
        bold: plan.bold,
        style: plan.style,
        erased: !plain && correctionOf(marks[plan.index] ?? 0) === "erase",
      });
      x += widthMm + page.letterSpacing * baseXh * scale * (1 + look.spacing) + (plan.bold ? BOLD_SPACING * baseXh * scale : 0);
    });
    reach = Math.max(reach, x);
    // Ending on letters to be written over: the next word goes on top of them.
    if (underFrom !== null) return { placed, gaps, starts, endX: underFrom, reach, over: true };
    return { placed, gaps, starts, endX: reach, reach, over: false };
  };

  let lineIndex = 0;
  let pageIndex = 0;
  let line = makeLine(0, 0, firstBaselineMm, "first", 0);
  let cursor = line.startXMm;
  let lineHasWords = false;

  const stopAt = (index: number, xMm: number) => {
    carets[index] = { page: line.page, line: line.index, xMm, yMm: baselineAt(line, xMm) };
    line.stops.push(index);
  };

  /** Centred and right-aligned lines move once they are complete. */
  const finishLine = () => {
    if (line.align === "left") return;
    const lineGlyphs = glyphs.slice(line.firstGlyph);
    const lineGaps = missingBoxes.slice(line.firstGap);
    if (lineGlyphs.length === 0 && lineGaps.length === 0) return;
    const minX = Math.min(...lineGlyphs.map((g) => g.xMm), ...lineGaps.map((g) => g.xMm));
    const maxX = Math.max(...lineGlyphs.map((g) => g.xMm + g.widthMm), ...lineGaps.map((g) => g.xMm + g.widthMm));
    const target = line.align === "center" ? (page.marginLeftMm + rightMm) / 2 - (minX + maxX) / 2 : rightMm - maxX;
    const dy = -line.slope * target;
    for (const g of lineGlyphs) {
      g.xMm += target;
      g.yMm += dy;
    }
    for (const g of lineGaps) {
      g.xMm += target;
      g.yMm += dy;
    }
    for (const i of line.stops) carets[i] = { ...carets[i], xMm: carets[i].xMm + target, yMm: carets[i].yMm + dy };
  };

  /** Next line; `paragraph` is the paragraph it belongs to, `newParagraph` adds the styles' spacing. */
  const nextLine = (key: number, paragraph: number, newParagraph: boolean): boolean => {
    finishLine();
    lineIndex++;
    const rng = createRng(deriveSeed(seed, "spacing", key));
    const previous = line;
    const nextScale = lineScaleOf(paragraph);
    // From the bottom of this line's letters to the top of the next ones.
    let pitch = page.lineSpacingMm * (0.45 * previous.spacingScale + 0.55 * nextScale);
    if (newParagraph) {
      pitch += page.lineSpacingMm * (STYLE_LOOK[paragraphOf(paragraph - 1).style].after + STYLE_LOOK[paragraphOf(paragraph).style].before);
    }
    let baseline = ruling ? snap(previous.baselineMm + pitch, previous.baselineMm) : previous.baselineMm + pitch * (1 + clampedGauss(rng) * 0.035 * nat.lineDrift);
    let pageNow = pageIndex;
    if (baseline > bottomMm) {
      if (pageIndex + 1 >= MAX_PAGES) {
        overflow = true;
        return false;
      }
      pageIndex++;
      pageNow = pageIndex;
      baseline = snap(page.marginTopMm + baseXh * nextScale * 2.1);
    }
    line = makeLine(lineIndex, pageNow, baseline, key, paragraph);
    cursor = line.startXMm;
    lineHasWords = false;
    return true;
  };

  const commit = (token: WordToken, result: ReturnType<typeof placeWord>, from = 0) => {
    glyphs.push(...result.placed);
    for (const g of result.placed) glyphByIndex.set(g.index, g);
    missingBoxes.push(...result.gaps);
    result.starts.forEach((x, i) => stopAt(token.indices[from + i], x));
    cursor = result.endX;
    lineHasWords = true;
  };

  type Between = "above" | "below";
  const betweenAt = (index: number): Between | null => {
    const kind = correctionOf(marks[index] ?? 0);
    return kind === "above" || kind === "below" ? kind : null;
  };
  const betweenWord = (token: Token): Between | null => {
    if (token.kind !== "word") return null;
    const kind = betweenAt(token.indices[0]);
    return kind && token.indices.every((i) => betweenAt(i) === kind) ? kind : null;
  };
  /** After letters to be written over, the space that follows does not move the pen. */
  let writingOver = false;
  /** Where the last space started: an insertion goes in the middle of the gap. */
  let gapStart: number | null = null;

  /**
   * Words added between the lines, above or below this one: smaller, in the
   * space between two lines, centred on where they go in the text.
   */
  const placeBetween = (group: WordToken[], spaceIndices: number[], where: Between) => {
    const insertX = gapStart !== null ? (gapStart + cursor) / 2 : cursor;
    // Half way to the next line, on ruled paper too (where the lines are closer or wider apart).
    const pitch = ruling ?? page.lineSpacingMm;
    const shift = where === "above" ? -pitch * 0.52 : pitch * 0.5;
    const above: LineState = { ...line, scale: line.scale * 0.78, baselineMm: line.baselineMm + shift };
    const lay = (startX: number) => {
      const results: ReturnType<typeof placeWord>[] = [];
      let x = startX;
      group.forEach((token, k) => {
        if (k > 0) x += page.wordSpacing * baseXh * above.scale;
        const result = placeWord(token.plans, token.chars, token.indices, x, above);
        results.push(result);
        x = result.endX;
      });
      return { results, endX: x };
    };
    const width = lay(0).endX;
    const { results } = lay(insertX - width / 2);
    group.forEach((token, k) => {
      const result = results[k];
      glyphs.push(...result.placed);
      for (const g of result.placed) glyphByIndex.set(g.index, g);
      missingBoxes.push(...result.gaps);
      result.starts.forEach((x, i) => {
        carets[token.indices[i]] = { page: line.page, line: line.index, xMm: x, yMm: baselineAt(above, x) };
        line.stops.push(token.indices[i]);
      });
    });
    spaceIndices.forEach((index, k) => {
      const x = results[Math.min(k, results.length - 1)].endX;
      carets[index] = { page: line.page, line: line.index, xMm: x, yMm: baselineAt(above, x) };
      line.stops.push(index);
    });
  };

  outer: for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t];
    if (token.kind === "break") {
      stopAt(token.index, cursor);
      writingOver = false;
      gapStart = null;
      if (!nextLine(token.key, token.paragraph + 1, true)) break;
      continue;
    }
    if (token.kind === "space") {
      stopAt(token.index, cursor);
      if (!lineHasWords || writingOver) {
        writingOver = false;
        continue;
      }
      const rng = createRng(token.seed);
      gapStart = cursor;
      cursor += page.wordSpacing * baseXh * line.scale * Math.max(0.4, 1 + clampedGauss(rng) * 0.3 * nat.spacingVariation);
      continue;
    }
    const where = betweenWord(token);
    if (where && lineHasWords) {
      // The whole run added above (or below): its words and the spaces between them.
      const group: WordToken[] = [token];
      const spaces: number[] = [];
      while (t + 2 < tokens.length && tokens[t + 1].kind === "space" && betweenAt((tokens[t + 1] as { index: number }).index) === where && betweenWord(tokens[t + 2]) === where) {
        spaces.push((tokens[t + 1] as { index: number }).index);
        group.push(tokens[t + 2] as WordToken);
        t += 2;
      }
      placeBetween(group, spaces, where);
      // The gap it goes into stays a single gap: the space after it does not count again.
      if (gapStart !== null) writingOver = true;
      continue;
    }
    gapStart = null;
    let attempt = placeWord(token.plans, token.chars, token.indices, cursor, line);
    if (attempt.reach > rightMm + overflowToleranceMm && lineHasWords) {
      if (!nextLine(token.key, token.paragraph, false)) break;
      attempt = placeWord(token.plans, token.chars, token.indices, cursor, line);
    }
    if (attempt.reach > rightMm + overflowToleranceMm) {
      // A single word longer than the whole line: break it wherever it runs out.
      for (let i = 0; i < token.plans.length; i++) {
        let piece = placeWord([token.plans[i]], [token.chars[i]], [token.indices[i]], cursor, line);
        if (piece.reach > rightMm + overflowToleranceMm && lineHasWords) {
          if (!nextLine(ids[token.indices[i]] ?? token.indices[i], token.paragraph, false)) break outer;
          piece = placeWord([token.plans[i]], [token.chars[i]], [token.indices[i]], cursor, line);
        }
        commit(token, piece, i);
      }
      continue;
    }
    commit(token, attempt);
    writingOver = attempt.over;
  }

  // The end of the text, and anything cut off by the page limit, sits where the pen stopped.
  for (let i = carets.length - 1; i >= 0 && !carets[i]; i--) stopAt(i, cursor);
  finishLine();
  for (let i = 0; i < carets.length; i++) if (!carets[i]) carets[i] = carets[i + 1] ?? carets[i - 1];

  const decorations = decorate(text, ids, marks, runStyles, paragraphFormats, format.titleUnderline ?? false, carets, glyphByIndex, baseXh, seed);
  // What was written before the correction tape went over it, under the first
  // piece of tape of each run (a run that goes on to the next line is one correction).
  const hidden: PlacedGlyph[] = [];
  for (const d of decorations) {
    if (d.kind !== "tipex" || !underTextOf(text, marks, runStyles, d)) continue;
    hidden.push(...placeUnderTape(underTextOf(text, marks, runStyles, d), d, marks[d.start] ?? 0, hand, page, nat, seed, runStyles).glyphs);
  }
  return { glyphs, missing, missingBoxes, decorations, hidden, carets, pageCount: pageIndex + 1, overflow, lineCount: lineIndex + 1 };
}

/** Correction tape is the same width whatever the size of the letters, in millimetres. */
export const TAPE_WIDTH_MM = 5;

/** Where a piece of correction tape starts and ends along its line, in millimetres. */
export function tapeSpan(d: Decoration): { from: number; to: number } {
  const rng = createRng(deriveSeed(d.seed, "tape-span"));
  return { from: d.x0 - (0.7 + 1.1 * rng.next()), to: d.x1 + (0.8 + 1.4 * rng.next()) };
}

/** Room under a piece of tape for what it hides, in millimetres along the line. */
export function tapeRoom(d: Decoration): { from: number; to: number } {
  const span = tapeSpan(d);
  return { from: span.from + 0.4, to: span.to - 0.4 };
}

/**
 * The text hidden under a piece of correction tape, or "" when there is none
 * or the piece only continues a run that started on the line before.
 */
export function underTextOf(text: string, marks: number[], runStyles: RunStyle[], d: Decoration): string {
  const under = runStyles[runStyleIndex(marks[d.start] ?? 0) - 1]?.tipexUnder ?? "";
  if (!under) return "";
  let k = d.start - 1;
  while (k >= 0 && text[k] !== "\n" && /\s/.test(text[k])) k--;
  if (k >= 0 && text[k] !== "\n" && correctionOf(marks[k] ?? 0) === "tipex") return "";
  return under;
}

/**
 * Places text under a piece of correction tape, on the tape's line and in the
 * same hand and size as the words on it. Letters past the end of the tape are
 * left out. Also says how long the whole text is and how much room there is.
 */
export function placeUnderTape(
  rawText: string,
  d: Decoration,
  mark: number,
  hand: Hand,
  page: PageSettings,
  nat: Naturalness,
  seed: number,
  runStyles: RunStyle[],
): { glyphs: PlacedGlyph[]; widthMm: number; roomMm: number } {
  const text = rawText.replace(/\s+/g, " ").trim();
  const room = tapeRoom(d);
  const roomMm = Math.max(0, room.to - room.from);
  if (!text) return { glyphs: [], widthMm: 0, roomMm };
  const style = runStyleIndex(mark);
  const charMark = withRunStyle(mark & (BOLD | ITALIC), style);
  const ids = Array.from({ length: text.length }, (_, k) => deriveSeed(d.seed, "under", k));
  const { tokens } = planGlyphs(text, ids, new Array(text.length).fill(charMark), runStyles, hand, nat, seed);
  const baseXh = page.xHeightMm;
  const runSize = style > 0 ? runStyles[style - 1]?.size ?? 1 : 1;
  const lineScale = d.xhMm / baseXh / runSize;
  const xh = baseXh * lineScale;
  const slope = (d.y1 - d.y0) / Math.max(0.01, d.x1 - d.x0);
  const baselineAt = (x: number) => d.y0 + slope * (x - d.x0);
  const glyphs: PlacedGlyph[] = [];
  let x = room.from;
  let inkEnd = room.from;
  let fits = true;
  for (const token of tokens) {
    if (token.kind === "space") {
      const rng = createRng(token.seed);
      x += page.wordSpacing * xh * Math.max(0.4, 1 + clampedGauss(rng) * 0.3 * nat.spacingVariation);
      continue;
    }
    if (token.kind !== "word") continue;
    token.plans.forEach((plan) => {
      if (!plan) {
        x += MISSING_GAP * xh + page.letterSpacing * xh;
        inkEnd = x;
        return;
      }
      const look = lookOf(plan, 1);
      const scale = look.size * lineScale;
      const widthMm = plan.width * baseXh * scale;
      inkEnd = x + widthMm;
      if (inkEnd > room.to) fits = false;
      if (fits) {
        glyphs.push({
          char: plan.char,
          variantIndex: plan.variantIndex,
          page: d.page,
          xMm: x,
          yMm: baselineAt(x) - look.lift * xh,
          scale,
          rotation: look.rotation,
          shear: look.slant,
          offsetX: plan.offsetX,
          seed: plan.seed,
          index: d.start,
          widthMm,
          bold: plan.bold,
          style: plan.style,
        });
      }
      x += widthMm + page.letterSpacing * baseXh * scale * (1 + look.spacing) + (plan.bold ? BOLD_SPACING * baseXh * scale : 0);
    });
  }
  return { glyphs, widthMm: inkEnd - room.from, roomMm };
}

/**
 * Underlines, strikethroughs and highlighter, one stroke per run of marked
 * characters on the same line (spaces between marked words included, not
 * at the ends).
 */
function decorate(
  text: string,
  ids: number[],
  marks: number[],
  runStyles: RunStyle[],
  paragraphs: number[],
  titleUnderline: boolean,
  carets: CaretStop[],
  glyphByIndex: Map<number, PlacedGlyph>,
  baseXh: number,
  seed: number,
): Decoration[] {
  const result: Decoration[] = [];
  const paragraphAt: number[] = [];
  let p = 0;
  for (let i = 0; i < text.length; i++) {
    paragraphAt.push(p);
    if (text.charCodeAt(i) === 10) p++;
  }
  const effective = (i: number) => {
    let m = marks[i] ?? 0;
    if (titleUnderline && decodeParagraph(paragraphs[paragraphAt[i]] ?? 0).style === "title") m |= UNDERLINE;
    return m;
  };
  const flagged = (flag: number) => (i: number) => Boolean(effective(i) & flag);
  const corrected = (kind: string) => (i: number) => correctionOf(marks[i] ?? 0) === kind;
  const kinds: [Decoration["kind"], (i: number) => boolean][] = [
    ["highlight", flagged(HIGHLIGHT)],
    ["underline", flagged(UNDERLINE)],
    ["strike", flagged(STRIKE)],
    ["scribble", flagged(SCRIBBLE)],
    ["tipex", corrected("tipex")],
    ["erased", corrected("erase")],
  ];
  const styleAt = (i: number) => runStyleIndex(marks[i] ?? 0);
  for (const [kind, has] of kinds) {
    let i = 0;
    while (i < text.length) {
      if (!has(i) || text[i] === "\n") {
        i++;
        continue;
      }
      // A run: same flag, same line, no line break.
      let j = i;
      // A line is drawn with one pen: a change of instrument or colour starts a new one;
      // the highlighter only cares about its own colour and how it is used.
      const highlightWords = (k: number) => Boolean(runStyles[styleAt(k) - 1]?.highlightWords);
      const highlightRound = (k: number) => Boolean(runStyles[styleAt(k) - 1]?.highlightRound);
      const sameInk = (k: number) =>
        kind === "highlight"
          ? highlightColorIndex(marks[k] ?? 0) === highlightColorIndex(marks[i] ?? 0) &&
            highlightWords(k) === highlightWords(i) &&
            highlightRound(k) === highlightRound(i)
          : kind === "tipex" || kind === "erased" || styleAt(k) === styleAt(i) || /\s/.test(text[k]);
      // Some people blot out or highlight word by word: then a space ends the line.
      const wordByWord = kind === "scribble" ? scribbleStyleOf(runStyles[styleAt(i) - 1]).perWord : kind === "highlight" && highlightWords(i);
      if (wordByWord && /\s/.test(text[i])) {
        i++;
        continue;
      }
      const goesOn = (k: number) => !(wordByWord && /\s/.test(text[k]));
      while (j + 1 < text.length && has(j + 1) && text[j + 1] !== "\n" && carets[j + 1].line === carets[i].line && sameInk(j + 1) && goesOn(j + 1)) j++;
      let a = i;
      let b = j;
      while (a <= b && /\s/.test(text[a])) a++;
      while (b >= a && /\s/.test(text[b])) b--;
      if (a <= b) {
        const start = carets[a];
        const last = glyphByIndex.get(b);
        const endX = last ? last.xMm + last.widthMm : (carets[b + 1]?.line === start.line ? carets[b + 1].xMm : carets[b].xMm + baseXh * 0.6);
        const endStop = carets[b];
        const slope = endStop.xMm !== start.xMm ? (endStop.yMm - start.yMm) / (endStop.xMm - start.xMm) : 0;
        const runSize = styleAt(a) > 0 ? runStyles[styleAt(a) - 1]?.size ?? 1 : 1;
        const scale = STYLE_LOOK[decodeParagraph(paragraphs[paragraphAt[a]] ?? 0).style].scale * runSize;
        result.push({
          kind,
          page: start.page,
          x0: start.xMm,
          y0: start.yMm,
          x1: endX,
          y1: start.yMm + slope * (endX - start.xMm),
          xhMm: baseXh * scale,
          color: highlightColorIndex(marks[a] ?? 0),
          style: styleAt(a),
          seed: deriveSeed(seed, kind, ids[a] ?? a),
          start: a,
          end: b,
        });
      }
      i = j + 1;
    }
  }
  return result;
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
