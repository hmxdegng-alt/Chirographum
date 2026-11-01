// A Chirographum document (.chiro): the text, the identity of every letter
// (so it looks exactly the same when opened again) and the sheet settings.
// It is written with whatever hand is loaded; the hand is its own file.

import { compactRunStyles, decodeBytes, paragraphCount, parseRunStyle, upgradeMarkV1, type RunStyle } from "./rich-text";
import { DEFAULT_PAPER, type Naturalness, type PageSettings, type PaperKind, type PaperSettings } from "./settings";

export const DOCUMENT_FORMAT = "chirographum-document";
export const DOCUMENT_VERSION = 1;
export const DOCUMENT_EXTENSION = "chiro";

export interface PenTuning {
  widthScale: number;
  inkStrength: number;
  /** How used the instrument is (0 = new): see wornPen. */
  wear: number;
}

export interface SheetSettings {
  penId: string;
  inkColor: string;
  penTuning: PenTuning;
  page: PageSettings;
  presetId: string;
  naturalness: Naturalness;
  seed: number;
  paper: PaperSettings;
  /** Titles get a line drawn under them. */
  titleUnderline: boolean;
  /** Overall amount of imperfections (1 = the values as they are). */
  naturalnessAmount: number;
  /** Written with the left hand: the hand runs over what was just written. */
  leftHanded: boolean;
  /** Hand smudges also land on underlines, strikethroughs and scribbles. */
  smudgeMarks: boolean;
  /** The highlighter also drags the ink of underlines, strikethroughs and scribbles. */
  smearMarks: boolean;
}

export interface ChiroDocument {
  text: string;
  charIds: number[];
  /** Bold, italic, underline… of every character. */
  marks: number[];
  /** Style and alignment of every paragraph. */
  paragraphs: number[];
  /** Instruments, colours and sizes chosen for parts of the text (marks point here). */
  runStyles: RunStyle[];
  settings: SheetSettings;
}

export class DocumentFormatError extends Error {
  constructor(readonly reason: "json" | "format" | "version" | "content") {
    super(`Invalid document: ${reason}`);
    this.name = "DocumentFormatError";
  }
}

/** Letter identities as base64 of little-endian 32-bit numbers: compact and exact. */
export function encodeIds(ids: number[]): string {
  const bytes = new Uint8Array(ids.length * 4);
  const view = new DataView(bytes.buffer);
  ids.forEach((id, i) => view.setUint32(i * 4, id >>> 0, true));
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function decodeIds(encoded: string): number[] {
  const binary = atob(encoded);
  if (binary.length % 4 !== 0) throw new DocumentFormatError("content");
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  return Array.from({ length: bytes.length / 4 }, (_, i) => view.getUint32(i * 4, true));
}

export function serializeDocument(doc: ChiroDocument): string {
  // Styles no letter uses any more (after undo or a change of mind) are not saved.
  const { marks, styles } = compactRunStyles(doc.marks, doc.runStyles);
  return JSON.stringify(
    {
      format: DOCUMENT_FORMAT,
      version: DOCUMENT_VERSION,
      text: doc.text,
      charIds: encodeIds(doc.charIds),
      marks32: encodeIds(marks),
      paragraphs: doc.paragraphs,
      runStyles: styles,
      settings: doc.settings,
    },
    null,
    1,
  );
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const numbersOnly = (value: unknown): boolean => isObject(value) && Object.values(value).every((v) => typeof v === "number" && Number.isFinite(v));

/**
 * Reads a document. Settings missing from older files are filled from
 * `defaults`, so a document always opens even after new settings appear.
 */
export function parseDocument(json: string, defaults: SheetSettings): ChiroDocument {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new DocumentFormatError("json");
  }
  if (!isObject(data) || data.format !== DOCUMENT_FORMAT) throw new DocumentFormatError("format");
  if (typeof data.version !== "number" || data.version > DOCUMENT_VERSION) throw new DocumentFormatError("version");
  if (typeof data.text !== "string") throw new DocumentFormatError("content");
  const text = data.text.replace(/\r\n?/g, "\n");

  let charIds: number[] = [];
  if (typeof data.charIds === "string") {
    try {
      charIds = decodeIds(data.charIds);
    } catch {
      charIds = [];
    }
  }
  if (charIds.length !== text.length) charIds = [];

  let marks: number[] = [];
  try {
    if (typeof data.marks32 === "string") marks = decodeIds(data.marks32);
    else if (typeof data.marks === "string") marks = decodeBytes(data.marks).map(upgradeMarkV1);
  } catch {
    marks = [];
  }
  // A damaged entry stays in its place (empty), so the indices in the marks still match.
  const runStyles: RunStyle[] = Array.isArray(data.runStyles) ? data.runStyles.map(parseRunStyle) : [];
  if (marks.length !== text.length) marks = new Array<number>(text.length).fill(0);
  let paragraphs = Array.isArray(data.paragraphs) ? data.paragraphs.map((v) => (typeof v === "number" && Number.isFinite(v) ? v & 31 : 0)) : [];
  if (paragraphs.length !== paragraphCount(text)) paragraphs = new Array<number>(paragraphCount(text)).fill(0);

  const raw = isObject(data.settings) ? data.settings : {};
  const rawPaper = isObject(raw.paper) ? raw.paper : {};
  const kinds: PaperKind[] = ["blank", "lined", "grid4", "grid5", "dots"];
  const settings: SheetSettings = {
    penId: typeof raw.penId === "string" ? raw.penId : defaults.penId,
    inkColor: typeof raw.inkColor === "string" && /^#[0-9a-f]{6}$/i.test(raw.inkColor) ? raw.inkColor : defaults.inkColor,
    penTuning: { ...defaults.penTuning, ...(numbersOnly(raw.penTuning) ? (raw.penTuning as Partial<PenTuning>) : {}) },
    page: { ...defaults.page, ...(numbersOnly(raw.page) ? (raw.page as Partial<PageSettings>) : {}) },
    presetId: typeof raw.presetId === "string" ? raw.presetId : defaults.presetId,
    naturalness: { ...defaults.naturalness, ...(numbersOnly(raw.naturalness) ? (raw.naturalness as Partial<Naturalness>) : {}) },
    seed: typeof raw.seed === "number" && Number.isFinite(raw.seed) ? raw.seed >>> 0 : defaults.seed,
    paper: {
      kind: kinds.includes(rawPaper.kind as PaperKind) ? (rawPaper.kind as PaperKind) : (defaults.paper ?? DEFAULT_PAPER).kind,
      lineSpacingMm: typeof rawPaper.lineSpacingMm === "number" ? rawPaper.lineSpacingMm : (defaults.paper ?? DEFAULT_PAPER).lineSpacingMm,
      marginLine: typeof rawPaper.marginLine === "boolean" ? rawPaper.marginLine : (defaults.paper ?? DEFAULT_PAPER).marginLine,
      print: typeof rawPaper.print === "boolean" ? rawPaper.print : (defaults.paper ?? DEFAULT_PAPER).print,
    },
    titleUnderline: typeof raw.titleUnderline === "boolean" ? raw.titleUnderline : defaults.titleUnderline,
    leftHanded: typeof raw.leftHanded === "boolean" ? raw.leftHanded : (defaults.leftHanded ?? false),
    smudgeMarks: typeof raw.smudgeMarks === "boolean" ? raw.smudgeMarks : (defaults.smudgeMarks ?? true),
    smearMarks: typeof raw.smearMarks === "boolean" ? raw.smearMarks : (defaults.smearMarks ?? true),
    naturalnessAmount:
      typeof raw.naturalnessAmount === "number" && Number.isFinite(raw.naturalnessAmount) ? Math.max(0, Math.min(3, raw.naturalnessAmount)) : defaults.naturalnessAmount,
  };
  return { text, charIds, marks, paragraphs, runStyles, settings };
}

/** File name without folder or extension, for the window title. */
export function documentTitle(fileName: string | null): string | null {
  if (!fileName) return null;
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  return base.replace(new RegExp(`\\.${DOCUMENT_EXTENSION}$`, "i"), "");
}
