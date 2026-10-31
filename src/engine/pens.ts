// Writing instruments. Each one is a small physical model; the renderer
// reads these numbers and never hard-codes a specific pen.

export type PenKind = "gel" | "ballpoint" | "pencil";

export interface PenModel {
  id: string;
  label: string;
  kind: PenKind;
  /** Width of the line on paper at normal pressure, in millimetres. */
  widthMm: number;
  /** How much pressure changes the width (0 = none, 1 = a lot). */
  pressureWidth: number;
  /** Ink opacity of a single stroke. Overlapping strokes get darker. */
  opacity: number;
  /** Strength of the paper-grain texture inside the line (0–1). */
  grain: number;
  /** Fraction of the stroke length that tapers at the start and the end. */
  taper: number;
  /** Ink blob at the start of a stroke, relative to the line width (0 = none). */
  startBlob: number;
  /** Edge softness in millimetres (pencil and ballpoint are fuzzier than gel). */
  softnessMm: number;
}

export const PENS: PenModel[] = [
  {
    id: "gel-07",
    label: "Gel 0,7",
    kind: "gel",
    widthMm: 0.4,
    pressureWidth: 0.3,
    opacity: 0.93,
    grain: 0.12,
    taper: 0.05,
    startBlob: 0.12,
    softnessMm: 0.01,
  },
  {
    id: "gel-05",
    label: "Gel 0,5",
    kind: "gel",
    widthMm: 0.3,
    pressureWidth: 0.3,
    opacity: 0.93,
    grain: 0.14,
    taper: 0.05,
    startBlob: 0.1,
    softnessMm: 0.01,
  },
  {
    id: "ballpoint-10",
    label: "Bola media 1,0",
    kind: "ballpoint",
    widthMm: 0.36,
    pressureWidth: 0.25,
    opacity: 0.82,
    grain: 0.42,
    taper: 0.1,
    startBlob: 0.28,
    softnessMm: 0.02,
  },
  {
    id: "pencil-hb",
    label: "Lápiz HB",
    kind: "pencil",
    widthMm: 0.45,
    pressureWidth: 0.4,
    opacity: 0.72,
    grain: 0.7,
    taper: 0.12,
    startBlob: 0,
    softnessMm: 0.035,
  },
];

export const DEFAULT_PEN_ID = "gel-07";

export function penById(id: string): PenModel {
  return PENS.find((pen) => pen.id === id) ?? PENS[0];
}

export interface InkColor {
  id: string;
  label: string;
  value: string;
}

/** Typical pen colours, shown first in the colour picker. */
export const INK_COLORS: InkColor[] = [
  { id: "blue", label: "Azul", value: "#22399a" },
  { id: "black", label: "Negro", value: "#1c1c22" },
  { id: "red", label: "Rojo", value: "#b42128" },
  { id: "green", label: "Verde", value: "#1e6a3c" },
];

export const PENCIL_COLOR = "#3b3b3e";
