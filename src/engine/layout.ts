// Places the characters of a text on pages as a person would write them:
// letters of slightly different size and angle, lines that rise or fall,
// a left margin that wanders and words that get squeezed near the edge.
// It also reports where the text cursor goes for every character, so the
// user can write directly on the page.

import { variantBounds, type Hand } from "./hand";
import { clampedGauss, createRng, deriveSeed, hashString } from "./random";
import {
  BOLD,
  decodeParagraph,
  HIGHLIGHT,
  highlightColorIndex,
  ITALIC,
  runStyleIndex,
  SCRIBBLE,
  scribbleStyleOf,
  STRIKE,
  STYLE_LOOK,
  UNDERLINE,
  type Alignment,
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
}

/** A line drawn by hand over the text: underline, strikethrough or highlighter. */
export interface Decoration {
  kind: "underline" | "strike" | "highlight" | "scribble";
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
  index: number;
  bold: boolean;
  style: number;
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
      size: Math.max(0.25, Math.min(3, 1 + z[0] * 0.09 * nat.sizeVariation)) * runSize,
      rotation: z[1] * 4 * DEG * nat.rotation,
      slant: Math.tan(Math.max(-75, Math.min(75, nat.slantDegrees + italic + z[2] * 7 * nat.slantVariation)) * DEG),
      lift: z[3] * 0.07 * nat.baselineWobble,
      spacing: Math.max(-0.9, z[4] * 0.45 * nat.spacingVariation),
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
  const makeLine = (index: number, pageIndex: number, baselineMm: number, key: number | string, paragraph: number): LineState => {
    const rng = createRng(deriveSeed(seed, "line", key));
    marginWalk = Math.max(-marginLimit, Math.min(marginLimit, marginWalk * 0.8 + clampedGauss(rng) * 1.3 * nat.marginDrift));
    // People copy the angle of the line above, so the drift is correlated.
    const drift = Math.max(-maxDrift, Math.min(maxDrift, previousDrift * 0.6 + Math.tan(clampedGauss(rng) * 0.55 * DEG * nat.lineDrift)));
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
    const xh = baseXh * line.scale;
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
      const scale = plan.size * shrinkAt(x) * line.scale;
      const widthMm = plan.width * baseXh * scale;
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
        index: plan.index,
        widthMm,
        bold: plan.bold,
        style: plan.style,
      });
      x += widthMm + page.letterSpacing * baseXh * scale * (1 + plan.spacing) + (plan.bold ? BOLD_SPACING * baseXh * scale : 0);
    });
    return { placed, gaps, starts, endX: x };
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

  outer: for (const token of tokens) {
    if (token.kind === "break") {
      stopAt(token.index, cursor);
      if (!nextLine(token.key, token.paragraph + 1, true)) break;
      continue;
    }
    if (token.kind === "space") {
      stopAt(token.index, cursor);
      if (!lineHasWords) continue;
      const rng = createRng(token.seed);
      cursor += page.wordSpacing * baseXh * line.scale * Math.max(0.4, 1 + clampedGauss(rng) * 0.3 * nat.spacingVariation);
      continue;
    }
    let attempt = placeWord(token.plans, token.chars, cursor, line);
    if (attempt.endX > rightMm + overflowToleranceMm && lineHasWords) {
      if (!nextLine(token.key, token.paragraph, false)) break;
      attempt = placeWord(token.plans, token.chars, cursor, line);
    }
    if (attempt.endX > rightMm + overflowToleranceMm) {
      // A single word longer than the whole line: break it wherever it runs out.
      for (let i = 0; i < token.plans.length; i++) {
        let piece = placeWord([token.plans[i]], [token.chars[i]], cursor, line);
        if (piece.endX > rightMm + overflowToleranceMm && lineHasWords) {
          if (!nextLine(ids[token.indices[i]] ?? token.indices[i], token.paragraph, false)) break outer;
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
  finishLine();
  for (let i = 0; i < carets.length; i++) if (!carets[i]) carets[i] = carets[i + 1] ?? carets[i - 1];

  const decorations = decorate(text, ids, marks, runStyles, paragraphFormats, format.titleUnderline ?? false, carets, glyphByIndex, baseXh, seed);
  return { glyphs, missing, missingBoxes, decorations, carets, pageCount: pageIndex + 1, overflow, lineCount: lineIndex + 1 };
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
  const kinds: [Decoration["kind"], number][] = [
    ["highlight", HIGHLIGHT],
    ["underline", UNDERLINE],
    ["strike", STRIKE],
    ["scribble", SCRIBBLE],
  ];
  const styleAt = (i: number) => runStyleIndex(marks[i] ?? 0);
  for (const [kind, flag] of kinds) {
    let i = 0;
    while (i < text.length) {
      if (!(effective(i) & flag) || text[i] === "\n") {
        i++;
        continue;
      }
      // A run: same flag, same line, no line break.
      let j = i;
      // A line is drawn with one pen: a change of instrument or colour starts a new one;
      // the highlighter only cares about its own colour and how it is used.
      const highlightWords = (k: number) => Boolean(runStyles[styleAt(k) - 1]?.highlightWords);
      const sameInk = (k: number) =>
        kind === "highlight"
          ? highlightColorIndex(marks[k] ?? 0) === highlightColorIndex(marks[i] ?? 0) && highlightWords(k) === highlightWords(i)
          : styleAt(k) === styleAt(i) || /\s/.test(text[k]);
      // Some people blot out or highlight word by word: then a space ends the line.
      const wordByWord = kind === "scribble" ? scribbleStyleOf(runStyles[styleAt(i) - 1]).perWord : kind === "highlight" && highlightWords(i);
      if (wordByWord && /\s/.test(text[i])) {
        i++;
        continue;
      }
      const goesOn = (k: number) => !(wordByWord && /\s/.test(text[k]));
      while (j + 1 < text.length && effective(j + 1) & flag && text[j + 1] !== "\n" && carets[j + 1].line === carets[i].line && sameInk(j + 1) && goesOn(j + 1)) j++;
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
