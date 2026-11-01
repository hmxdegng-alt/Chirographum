// A Chirographum document (.chiro): the text, the identity of every letter
// (so it looks exactly the same when opened again) and the sheet settings.
// It is written with whatever hand is loaded; the hand is its own file.

import type { Naturalness, PageSettings } from "./settings";

export const DOCUMENT_FORMAT = "chirographum-document";
export const DOCUMENT_VERSION = 1;
export const DOCUMENT_EXTENSION = "chiro";

export interface PenTuning {
  widthScale: number;
  inkStrength: number;
}

export interface SheetSettings {
  penId: string;
  inkColor: string;
  penTuning: PenTuning;
  page: PageSettings;
  presetId: string;
  naturalness: Naturalness;
  seed: number;
}

export interface ChiroDocument {
  text: string;
  charIds: number[];
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
  return JSON.stringify(
    {
      format: DOCUMENT_FORMAT,
      version: DOCUMENT_VERSION,
      text: doc.text,
      charIds: encodeIds(doc.charIds),
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

  const raw = isObject(data.settings) ? data.settings : {};
  const settings: SheetSettings = {
    penId: typeof raw.penId === "string" ? raw.penId : defaults.penId,
    inkColor: typeof raw.inkColor === "string" && /^#[0-9a-f]{6}$/i.test(raw.inkColor) ? raw.inkColor : defaults.inkColor,
    penTuning: { ...defaults.penTuning, ...(numbersOnly(raw.penTuning) ? (raw.penTuning as Partial<PenTuning>) : {}) },
    page: { ...defaults.page, ...(numbersOnly(raw.page) ? (raw.page as Partial<PageSettings>) : {}) },
    presetId: typeof raw.presetId === "string" ? raw.presetId : defaults.presetId,
    naturalness: { ...defaults.naturalness, ...(numbersOnly(raw.naturalness) ? (raw.naturalness as Partial<Naturalness>) : {}) },
    seed: typeof raw.seed === "number" && Number.isFinite(raw.seed) ? raw.seed >>> 0 : defaults.seed,
  };
  return { text, charIds, settings };
}

/** File name without folder or extension, for the window title. */
export function documentTitle(fileName: string | null): string | null {
  if (!fileName) return null;
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  return base.replace(new RegExp(`\\.${DOCUMENT_EXTENSION}$`, "i"), "");
}
