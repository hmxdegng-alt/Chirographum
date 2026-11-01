// Formatting of the text: marks on characters (bold, italic, underline,
// strikethrough, highlighter) and attributes of paragraphs (style and
// alignment). Both follow the text through every edit, the same way the
// letter identities do.

// ----- Character marks (one number per character) -----
// Bits 0–5: flags. Bits 6–8: highlighter colour. Bits 9–16: run style
// (instrument, colour and size chosen for that part of the text).

export const BOLD = 1;
export const ITALIC = 2;
export const UNDERLINE = 4;
export const STRIKE = 8;
export const HIGHLIGHT = 16;
/** Scribbled out, the way people blot a mistake. */
export const SCRIBBLE = 32;
const FLAGS = 63;
const HIGHLIGHT_COLOR_SHIFT = 6;
const STYLE_SHIFT = 9;
export const MAX_RUN_STYLES = 255;

export type MarkFlag = typeof BOLD | typeof ITALIC | typeof UNDERLINE | typeof STRIKE | typeof HIGHLIGHT | typeof SCRIBBLE;

/** Marks of version 0.1 (one byte: flags 0–4, colour 5–7) in the current layout. */
export function upgradeMarkV1(value: number): number {
  return (value & 31) | (((value >> 5) & 7) << HIGHLIGHT_COLOR_SHIFT);
}

/** Ways of scribbling out a word, from the user's own examples. */
export const SCRIBBLE_KINDS = ["zigzag", "lines", "ovals", "cross", "loops"] as const;
export type ScribbleKind = (typeof SCRIBBLE_KINDS)[number];

export interface ScribbleStyle {
  kind: ScribbleKind;
  /** 0 = a calm, light correction; 1 = blotted out in anger. */
  rage: number;
  /** Stroke width relative to the instrument's. */
  width: number;
  /** Each word on its own instead of the whole selection in one go. */
  perWord: boolean;
}

export const DEFAULT_SCRIBBLE: ScribbleStyle = { kind: "zigzag", rage: 0.5, width: 1, perWord: false };

/** An instrument, colour, size or kind of scribble chosen for part of the text; empty fields use the defaults. */
export interface RunStyle {
  penId?: string;
  color?: string;
  /** Letter size relative to the paragraph (1 = as it is). */
  size?: number;
  scribbleKind?: ScribbleKind;
  scribbleRage?: number;
  scribbleWidth?: number;
  scribbleWords?: boolean;
  /** Highlighter lifted at every space instead of one sweep along the line. */
  highlightWords?: boolean;
  /** Round highlighter ends (a worn or bullet tip) instead of the chisel's square ones. */
  highlightRound?: boolean;
}

export function scribbleStyleOf(style: RunStyle | undefined): ScribbleStyle {
  return {
    kind: style?.scribbleKind ?? DEFAULT_SCRIBBLE.kind,
    rage: style?.scribbleRage ?? DEFAULT_SCRIBBLE.rage,
    width: style?.scribbleWidth ?? DEFAULT_SCRIBBLE.width,
    perWord: style?.scribbleWords ?? DEFAULT_SCRIBBLE.perWord,
  };
}

/** The run style fields that give a scribble this look. */
export function scribbleFields(style: ScribbleStyle): RunStyle {
  return { scribbleKind: style.kind, scribbleRage: style.rage, scribbleWidth: style.width, scribbleWords: style.perWord };
}

export function runStyleIndex(marks: number): number {
  return (marks >>> STYLE_SHIFT) & 255;
}

export function withRunStyle(marks: number, index: number): number {
  return (marks & ~(255 << STYLE_SHIFT)) | ((index & 255) << STYLE_SHIFT);
}

export function sameRunStyle(a: RunStyle, b: RunStyle): boolean {
  const sa = scribbleStyleOf(a);
  const sb = scribbleStyleOf(b);
  return (
    a.penId === b.penId &&
    a.color === b.color &&
    (a.size ?? 1) === (b.size ?? 1) &&
    sa.kind === sb.kind &&
    sa.rage === sb.rage &&
    sa.width === sb.width &&
    sa.perWord === sb.perWord &&
    Boolean(a.highlightWords) === Boolean(b.highlightWords) &&
    Boolean(a.highlightRound) === Boolean(b.highlightRound)
  );
}

/** Only the fields that differ from the defaults. */
export function cleanRunStyle(style: RunStyle): RunStyle {
  const clean: RunStyle = {};
  if (style.penId) clean.penId = style.penId;
  if (style.color) clean.color = style.color;
  if (style.size && Math.abs(style.size - 1) > 1e-6) clean.size = style.size;
  if (style.scribbleKind && style.scribbleKind !== DEFAULT_SCRIBBLE.kind) clean.scribbleKind = style.scribbleKind;
  if (style.scribbleRage !== undefined && Math.abs(style.scribbleRage - DEFAULT_SCRIBBLE.rage) > 1e-6) clean.scribbleRage = style.scribbleRage;
  if (style.scribbleWidth !== undefined && Math.abs(style.scribbleWidth - DEFAULT_SCRIBBLE.width) > 1e-6) clean.scribbleWidth = style.scribbleWidth;
  if (style.scribbleWords) clean.scribbleWords = true;
  if (style.highlightWords) clean.highlightWords = true;
  if (style.highlightRound) clean.highlightRound = true;
  return clean;
}

/**
 * Applies a change of instrument, colour or size to a range. The table of
 * run styles grows as needed (index 0 = the document's own); returns the new
 * marks and table.
 */
export function applyRunStyle(
  marks: number[],
  styles: RunStyle[],
  start: number,
  end: number,
  change: RunStyle,
): { marks: number[]; styles: RunStyle[] } {
  let table = styles.slice();
  let next = marks.slice();
  const cache = new Map<number, number>();
  const indexOf = (style: RunStyle): number => {
    const clean = cleanRunStyle(style);
    if (Object.keys(clean).length === 0) return 0;
    const found = table.findIndex((s) => sameRunStyle(s, clean));
    if (found >= 0) return found + 1;
    if (table.length >= MAX_RUN_STYLES) {
      // Full: drop the styles no character uses any more, then try again.
      const compacted = compactRunStyles(next, table);
      next = compacted.marks;
      table = compacted.styles;
      cache.clear();
      if (table.length >= MAX_RUN_STYLES) return 0;
    }
    table.push(clean);
    return table.length;
  };
  for (let i = start; i < end; i++) {
    const old = runStyleIndex(next[i] ?? 0);
    let index = cache.get(old);
    if (index === undefined) {
      const base = old > 0 ? table[old - 1] ?? {} : {};
      index = indexOf({ ...base, ...change });
      cache.set(old, index);
    }
    next[i] = withRunStyle(next[i] ?? 0, index);
  }
  return { marks: next, styles: table };
}

/** Removes run styles nobody uses and renumbers the rest. */
export function compactRunStyles(marks: number[], styles: RunStyle[]): { marks: number[]; styles: RunStyle[] } {
  const used = new Map<number, number>();
  const table: RunStyle[] = [];
  const next = marks.map((m) => {
    const old = runStyleIndex(m);
    if (old === 0 || !styles[old - 1]) return withRunStyle(m, 0);
    let index = used.get(old);
    if (index === undefined) {
      table.push(styles[old - 1]);
      index = table.length;
      used.set(old, index);
    }
    return withRunStyle(m, index);
  });
  return { marks: next, styles: table };
}

export const HIGHLIGHT_COLORS = [
  { id: "yellow", label: "Amarillo", value: "#f5e03a" },
  { id: "green", label: "Verde", value: "#8fe36f" },
  { id: "pink", label: "Rosa", value: "#f79ac4" },
  { id: "blue", label: "Azul", value: "#7fd3f2" },
  { id: "orange", label: "Naranja", value: "#ffb35c" },
];

export function highlightColorIndex(marks: number): number {
  return (marks >> HIGHLIGHT_COLOR_SHIFT) & 7;
}

export function withHighlightColor(marks: number, index: number): number {
  return (marks & ~(7 << HIGHLIGHT_COLOR_SHIFT)) | ((index & 7) << HIGHLIGHT_COLOR_SHIFT);
}

// ----- Paragraph attributes (one small number per paragraph) -----

export const PARAGRAPH_STYLES = ["normal", "title", "subtitle", "h1", "h2", "h3"] as const;
export type ParagraphStyle = (typeof PARAGRAPH_STYLES)[number];
export const ALIGNMENTS = ["left", "center", "right"] as const;
export type Alignment = (typeof ALIGNMENTS)[number];

export interface ParagraphFormat {
  style: ParagraphStyle;
  align: Alignment;
}

export const NORMAL_PARAGRAPH = 0;

export function encodeParagraph(format: ParagraphFormat): number {
  return Math.max(0, PARAGRAPH_STYLES.indexOf(format.style)) + 8 * Math.max(0, ALIGNMENTS.indexOf(format.align));
}

export function decodeParagraph(value: number): ParagraphFormat {
  return { style: PARAGRAPH_STYLES[value % 8] ?? "normal", align: ALIGNMENTS[Math.floor(value / 8) % 4] ?? "left" };
}

/** How a paragraph style looks: letter size and space around it, in lines. */
export const STYLE_LOOK: Record<ParagraphStyle, { scale: number; before: number; after: number }> = {
  normal: { scale: 1, before: 0, after: 0 },
  title: { scale: 1.9, before: 0.2, after: 0.35 },
  subtitle: { scale: 1.3, before: 0, after: 0.3 },
  h1: { scale: 1.55, before: 0.45, after: 0.2 },
  h2: { scale: 1.3, before: 0.35, after: 0.15 },
  h3: { scale: 1.12, before: 0.25, after: 0.1 },
};

// ----- Following edits -----

export interface TextEdit {
  /** Characters kept at the start. */
  prefix: number;
  /** Characters kept at the end. */
  suffix: number;
  /** Characters typed in between. */
  inserted: number;
}

export function diffTexts(oldText: string, newText: string): TextEdit {
  const max = Math.min(oldText.length, newText.length);
  let prefix = 0;
  while (prefix < max && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && oldText.charCodeAt(oldText.length - 1 - suffix) === newText.charCodeAt(newText.length - 1 - suffix)) suffix++;
  return { prefix, suffix, inserted: newText.length - prefix - suffix };
}

/** Marks after an edit: typed characters get `typing` (the marks at the cursor). */
export function updateMarks(oldText: string, oldMarks: number[], newText: string, typing: number): number[] {
  const marks = oldMarks.length === oldText.length ? oldMarks : new Array<number>(oldText.length).fill(0);
  const { prefix, suffix, inserted } = diffTexts(oldText, newText);
  return [...marks.slice(0, prefix), ...new Array<number>(inserted).fill(typing), ...marks.slice(marks.length - suffix)];
}

const countBreaks = (text: string, from = 0, to = text.length) => {
  let n = 0;
  for (let i = from; i < to; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
};

export function paragraphCount(text: string): number {
  return countBreaks(text) + 1;
}

/**
 * Paragraph attributes after an edit. The paragraph where the edit starts
 * keeps its format and passes it to new paragraphs typed inside it, except
 * pressing Enter at the end of a title or heading, which continues with
 * normal text, as in any word processor.
 */
export function updateParagraphs(oldText: string, oldParagraphs: number[], newText: string): number[] {
  const paragraphs = oldParagraphs.length === paragraphCount(oldText) ? oldParagraphs : new Array<number>(paragraphCount(oldText)).fill(NORMAL_PARAGRAPH);
  const { prefix, suffix, inserted } = diffTexts(oldText, newText);
  const before = countBreaks(oldText, 0, prefix);
  const after = countBreaks(oldText, oldText.length - suffix);
  const newBreaks = countBreaks(newText, prefix, prefix + inserted);
  const current = paragraphs[before] ?? NORMAL_PARAGRAPH;
  const endOfParagraph = prefix + inserted >= newText.length || newText.charCodeAt(prefix + inserted) === 10;
  const continued = decodeParagraph(current).style !== "normal" && endOfParagraph ? NORMAL_PARAGRAPH : current;
  return [...paragraphs.slice(0, before + 1), ...new Array<number>(newBreaks).fill(continued), ...paragraphs.slice(paragraphs.length - after)];
}

/** Paragraph index of every character (the line break belongs to the paragraph it ends). */
export function paragraphOfIndex(text: string, index: number): number {
  return countBreaks(text, 0, Math.min(index, text.length));
}

/** Paragraphs touched by a selection. */
export function paragraphsInRange(text: string, start: number, end: number): { first: number; last: number } {
  const first = paragraphOfIndex(text, start);
  const last = end > start ? paragraphOfIndex(text, end - 1) : first;
  return { first, last: Math.max(first, last) };
}

/** True when every non-space character of the range has the flag. */
export function rangeHasMark(text: string, marks: number[], start: number, end: number, flag: number): boolean {
  let any = false;
  for (let i = start; i < end; i++) {
    if (/\s/.test(text[i])) continue;
    any = true;
    if (!((marks[i] ?? 0) & flag)) return false;
  }
  return any;
}

/** Adds or removes a flag on a range; returns new marks. */
export function setMark(marks: number[], start: number, end: number, flag: number, on: boolean, highlightColor = 0): number[] {
  const next = marks.slice();
  for (let i = start; i < end; i++) {
    let value = on ? next[i] | flag : next[i] & ~(flag & FLAGS);
    if (flag === HIGHLIGHT && on) value = withHighlightColor(value, highlightColor);
    next[i] = value;
  }
  return next;
}

/** Removes every flag and the highlighter, keeping the instrument, colour and size. */
export function clearFlags(marks: number[], start: number, end: number): number[] {
  const next = marks.slice();
  for (let i = start; i < end; i++) next[i] = next[i] & ~(FLAGS | (7 << HIGHLIGHT_COLOR_SHIFT));
  return next;
}

// ----- Compact storage in documents -----

export function encodeBytes(values: number[]): string {
  let binary = "";
  for (let i = 0; i < values.length; i += 0x8000) binary += String.fromCharCode(...values.slice(i, i + 0x8000).map((v) => v & 255));
  return btoa(binary);
}

export function decodeBytes(encoded: string): number[] {
  return Array.from(atob(encoded), (c) => c.charCodeAt(0));
}
