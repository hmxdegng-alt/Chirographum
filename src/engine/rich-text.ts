// Formatting of the text: marks on characters (bold, italic, underline,
// strikethrough, highlighter) and attributes of paragraphs (style and
// alignment). Both follow the text through every edit, the same way the
// letter identities do.

// ----- Character marks (one small number per character) -----

export const BOLD = 1;
export const ITALIC = 2;
export const UNDERLINE = 4;
export const STRIKE = 8;
export const HIGHLIGHT = 16;
/** Bits 5–7: which highlighter colour. */
const HIGHLIGHT_COLOR_SHIFT = 5;

export type MarkFlag = typeof BOLD | typeof ITALIC | typeof UNDERLINE | typeof STRIKE | typeof HIGHLIGHT;

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
    let value = on ? next[i] | flag : next[i] & ~flag;
    if (flag === HIGHLIGHT && on) value = withHighlightColor(value, highlightColor);
    next[i] = value;
  }
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
