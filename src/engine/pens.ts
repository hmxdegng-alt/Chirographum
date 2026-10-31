// Writing instruments. Each one is a small physical model; the renderer
// reads these numbers and never hard-codes a specific pen. Values were
// tuned against 684 ppp scans of real handwriting (stroke width, tone,
// edges, graphite texture, marker overlaps).

export type PenKind = "gel" | "ballpoint" | "marker" | "pencil";

export interface PenModel {
  id: string;
  label: string;
  kind: PenKind;
  /** Width of the line on paper at normal pressure, in millimetres. */
  widthMm: number;
  /** How much pressure changes the width (0 = none, 1 = a lot). */
  pressureWidth: number;
  /** Opacity of the ink (of one layer, for markers). */
  opacity: number;
  /**
   * Markers build up: where two strokes cross the ink gets darker. Pens and
   * pencils never do (the darker of the two wins).
   */
  buildsUp: boolean;
  /** How much lighter the line gets at low pressure (0 = constant tone). */
  pressureTone: number;
  /** Strength of the paper-grain texture inside the line (0–1). */
  grain: number;
  /** Size of the grain: below 1 is finer (graphite), above 1 coarser (felt tips). */
  grainScale: number;
  /** Bumpy, irregular edges (0 = perfectly smooth). */
  edgeRoughness: number;
  /** Fraction of the stroke length that tapers at the start and the end. */
  taper: number;
  /** Ink pooling where the pen lands and lifts, relative to the line width. */
  startBlob: number;
  endBlob: number;
  /** How easily the pen skips when "El boli falla" is up (0 = never). */
  skipProne: number;
  /** Edge softness in millimetres (pencil and felt tips are fuzzier than gel). */
  softnessMm: number;
}

export const PENS: PenModel[] = [
  {
    id: "gel-07",
    label: "Gel 0,7",
    kind: "gel",
    widthMm: 0.42,
    pressureWidth: 0.25,
    opacity: 0.9,
    buildsUp: false,
    pressureTone: 0.1,
    grain: 0.1,
    grainScale: 1,
    edgeRoughness: 0.14,
    taper: 0,
    startBlob: 0.14,
    endBlob: 0.1,
    skipProne: 0.6,
    softnessMm: 0.012,
  },
  {
    id: "gel-05",
    label: "Gel 0,5",
    kind: "gel",
    widthMm: 0.32,
    pressureWidth: 0.25,
    opacity: 0.9,
    buildsUp: false,
    pressureTone: 0.1,
    grain: 0.12,
    grainScale: 1,
    edgeRoughness: 0.14,
    taper: 0,
    startBlob: 0.12,
    endBlob: 0.08,
    skipProne: 0.6,
    softnessMm: 0.012,
  },
  {
    id: "ballpoint-10",
    label: "Bola media 1,0",
    kind: "ballpoint",
    widthMm: 0.36,
    pressureWidth: 0.2,
    opacity: 0.86,
    buildsUp: false,
    pressureTone: 0.25,
    grain: 0.42,
    grainScale: 1,
    edgeRoughness: 0.1,
    taper: 0.08,
    startBlob: 0.28,
    endBlob: 0,
    skipProne: 1,
    softnessMm: 0.02,
  },
  {
    id: "fineliner",
    label: "Rotulador fino",
    kind: "marker",
    widthMm: 0.45,
    pressureWidth: 0.12,
    opacity: 0.8,
    buildsUp: true,
    pressureTone: 0.06,
    grain: 0.14,
    grainScale: 1.3,
    edgeRoughness: 0.1,
    taper: 0,
    startBlob: 0.18,
    endBlob: 0.12,
    skipProne: 0.5,
    softnessMm: 0.03,
  },
  {
    id: "marker-medium",
    label: "Rotulador mediano",
    kind: "marker",
    widthMm: 0.95,
    pressureWidth: 0.15,
    opacity: 0.82,
    buildsUp: true,
    pressureTone: 0.08,
    grain: 0.2,
    grainScale: 1.6,
    edgeRoughness: 0.08,
    taper: 0,
    startBlob: 0.1,
    endBlob: 0.06,
    skipProne: 0.8,
    softnessMm: 0.04,
  },
  {
    id: "pencil-hb",
    label: "Lápiz HB",
    kind: "pencil",
    widthMm: 0.52,
    pressureWidth: 0.35,
    opacity: 0.62,
    buildsUp: false,
    pressureTone: 0.45,
    grain: 0.85,
    grainScale: 0.7,
    edgeRoughness: 0.3,
    taper: 0.12,
    startBlob: 0,
    endBlob: 0,
    skipProne: 0,
    softnessMm: 0.04,
  },
  {
    id: "mechanical-05",
    label: "Portaminas 0,5",
    kind: "pencil",
    widthMm: 0.4,
    pressureWidth: 0.15,
    opacity: 0.55,
    buildsUp: false,
    pressureTone: 0.35,
    grain: 0.6,
    grainScale: 0.6,
    edgeRoughness: 0.15,
    taper: 0.06,
    startBlob: 0,
    endBlob: 0,
    skipProne: 0,
    softnessMm: 0.02,
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

/** Typical pen colours, shown first in the colour picker. Real black ink is a very dark grey. */
export const INK_COLORS: InkColor[] = [
  { id: "blue", label: "Azul", value: "#22399a" },
  { id: "black", label: "Negro", value: "#232327" },
  { id: "red", label: "Rojo", value: "#b42128" },
  { id: "green", label: "Verde", value: "#1e6a3c" },
];

/** Graphite: a neutral grey with a faint cool sheen. */
export const PENCIL_COLOR = "#46464d";
