// A "hand" (mano) is a personal handwriting font: for every character, one
// or more variants, each made of the strokes the user actually drew.
// Coordinates are in x-height units: 1 = height of a lowercase "x",
// y grows upwards from the baseline.

import { boundsOf, type Bounds, type StrokePoint } from "./geometry";

export const HAND_FORMAT = "chirographum-hand";
export const HAND_VERSION = 1;

export type Stroke = StrokePoint[];

export interface GlyphVariant {
  strokes: Stroke[];
}

export type HandStyle = "separate" | "cursive";

export interface Hand {
  format: typeof HAND_FORMAT;
  version: typeof HAND_VERSION;
  name: string;
  style: HandStyle;
  createdAt: string;
  updatedAt: string;
  glyphs: Record<string, GlyphVariant[]>;
}

export class HandFormatError extends Error {
  constructor(readonly reason: "json" | "format" | "version" | "content") {
    super(`Invalid hand file: ${reason}`);
    this.name = "HandFormatError";
  }
}

export function createHand(name: string, now = new Date()): Hand {
  const stamp = now.toISOString();
  return {
    format: HAND_FORMAT,
    version: HAND_VERSION,
    name,
    style: "separate",
    createdAt: stamp,
    updatedAt: stamp,
    glyphs: {},
  };
}

/** Rounds coordinates so saved files stay small and diffable. */
function compactPoint(point: StrokePoint): StrokePoint {
  return {
    x: Math.round(point.x * 1000) / 1000,
    y: Math.round(point.y * 1000) / 1000,
    p: Math.round(point.p * 100) / 100,
    t: Math.round(point.t),
  };
}

export function serializeHand(hand: Hand): string {
  const glyphs: Record<string, GlyphVariant[]> = {};
  for (const [char, variants] of Object.entries(hand.glyphs)) {
    glyphs[char] = variants.map((variant) => ({
      strokes: variant.strokes.map((stroke) => stroke.map(compactPoint)),
    }));
  }
  return JSON.stringify({ ...hand, glyphs });
}

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function isPoint(value: unknown): value is StrokePoint {
  if (typeof value !== "object" || value === null) return false;
  const point = value as Record<string, unknown>;
  return isFiniteNumber(point.x) && isFiniteNumber(point.y) && isFiniteNumber(point.p) && isFiniteNumber(point.t);
}

export function parseHand(text: string): Hand {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HandFormatError("json");
  }
  if (typeof data !== "object" || data === null) throw new HandFormatError("format");
  const raw = data as Record<string, unknown>;
  if (raw.format !== HAND_FORMAT) throw new HandFormatError("format");
  if (raw.version !== HAND_VERSION) throw new HandFormatError("version");
  if (typeof raw.glyphs !== "object" || raw.glyphs === null) throw new HandFormatError("content");

  const glyphs: Record<string, GlyphVariant[]> = {};
  for (const [char, variants] of Object.entries(raw.glyphs as Record<string, unknown>)) {
    if ([...char].length !== 1 || !Array.isArray(variants)) throw new HandFormatError("content");
    glyphs[char] = variants.map((variant) => {
      const strokes = (variant as { strokes?: unknown }).strokes;
      if (!Array.isArray(strokes)) throw new HandFormatError("content");
      return {
        strokes: strokes.map((stroke) => {
          if (!Array.isArray(stroke) || !stroke.every(isPoint)) throw new HandFormatError("content");
          return stroke.map((point) => ({ ...point, p: Math.max(0, Math.min(1, point.p)) }));
        }),
      };
    });
  }

  const now = new Date().toISOString();
  return {
    format: HAND_FORMAT,
    version: HAND_VERSION,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name : "Mi mano",
    style: raw.style === "cursive" ? "cursive" : "separate",
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : now,
    glyphs,
  };
}

export function withVariantAdded(hand: Hand, char: string, variant: GlyphVariant): Hand {
  const existing = hand.glyphs[char] ?? [];
  return {
    ...hand,
    updatedAt: new Date().toISOString(),
    glyphs: { ...hand.glyphs, [char]: [...existing, variant] },
  };
}

export function withVariantRemoved(hand: Hand, char: string, index: number): Hand {
  const existing = hand.glyphs[char] ?? [];
  const remaining = existing.filter((_, i) => i !== index);
  const glyphs = { ...hand.glyphs };
  if (remaining.length > 0) glyphs[char] = remaining;
  else delete glyphs[char];
  return { ...hand, updatedAt: new Date().toISOString(), glyphs };
}

/** Distinct characters of a text that need a drawing (spaces and line breaks excluded). */
export function charactersNeeded(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const char of text) {
    if (/\s/.test(char) || seen.has(char)) continue;
    seen.add(char);
    result.push(char);
  }
  return result;
}

export function missingCharacters(hand: Hand, text: string): string[] {
  return charactersNeeded(text).filter((char) => (hand.glyphs[char]?.length ?? 0) === 0);
}

export function variantBounds(variant: GlyphVariant): Bounds {
  return boundsOf(variant.strokes) ?? { minX: 0, maxX: 0.3, minY: 0, maxY: 0.3 };
}

/**
 * The hyphen added when a word is split at the end of a line. The hand's own
 * "-" is used when it has one; otherwise this character stands for a short
 * stroke drawn like a quick hand-made dash (it never comes from typed text).
 */
export const AUTO_HYPHEN = "‐";

const dash = (x0: number, y0: number, x1: number, y1: number, sag: number): GlyphVariant => ({
  strokes: [
    Array.from({ length: 7 }, (_, i) => {
      const t = i / 6;
      return {
        x: x0 + (x1 - x0) * t,
        y: y0 + (y1 - y0) * t - sag * Math.sin(Math.PI * t),
        // Firm at the start, lighter as the pen lifts.
        p: 0.95 - 0.12 * t,
        t: Math.round(t * 120),
      };
    }),
  ],
});

const FALLBACK_HYPHEN: GlyphVariant[] = [dash(0.12, 0.47, 0.66, 0.52, 0.015), dash(0.1, 0.5, 0.6, 0.53, -0.01), dash(0.14, 0.44, 0.7, 0.51, 0.02)];

/** The drawings for a character, including the automatic hyphen when the hand has no "-". */
export function variantsOf(hand: Hand, char: string): GlyphVariant[] {
  if (char === AUTO_HYPHEN) return hand.glyphs["-"]?.length ? hand.glyphs["-"] : FALLBACK_HYPHEN;
  return hand.glyphs[char] ?? [];
}
