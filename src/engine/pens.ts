// Writing instruments. Each one is a small physical model; the renderer
// reads these numbers and never hard-codes a specific pen. Values were
// tuned against 684 ppp scans of real handwriting (stroke width, tone,
// edges, graphite texture, marker overlaps).

export type PenKind = "gel" | "ballpoint" | "marker" | "pencil";

/** What a pencil's core is made of: graphite (grey, shiny, smudges), coloured wax (translucent, barely smudges) or charcoal (black, powdery). */
export type PencilMaterial = "graphite" | "wax" | "charcoal";

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
  /**
   * How much of the line a highlighter drags along (0 = none): gel and
   * water-based felt tips run, ballpoint oil barely moves, graphite greys.
   */
  smear: number;
  /** How easily the writing hand smudges the line (graphite and wet gel most, ballpoint barely). */
  smudge: number;
  /** How often the tip leaves a lump of ink when "Grumos de tinta" is up (ballpoints most, pencils never). */
  blobProne: number;
  /** Edge softness in millimetres (pencil and felt tips are fuzzier than gel). */
  softnessMm: number;
  /** Running out of ink (0–1): gaps and faint stretches whatever "El boli falla" says. */
  dryness?: number;
  /** A drying felt tip (0–1): pale streaks along the stroke where the fibres are dry. */
  streaks?: number;
  /** Dry media only: what the core is made of. */
  material?: PencilMaterial;
  /** The instrument always writes in this colour (graphite, charcoal): no ink colour to choose. */
  fixedColor?: string;
  /** The only colours it has (the two ends of a red and blue pencil); the first is the default. */
  inkChoices?: InkColor[];
  /**
   * How fast the point gets blunt as you write, relative to an HB pencil (0 =
   * never: pens, markers and mechanical pencils, whose lead keeps its width).
   */
  pointWear?: number;
}

/**
 * The same instrument after a lot of use (0 = new, 1 = nearly finished): a
 * pencil gets a blunt point (wider, softer, lighter, grainier); a felt tip
 * dries out (faint, streaky, broken); a pen runs out of ink (faint, skipping).
 */
export function wornPen(pen: PenModel, wear: number): PenModel {
  const w = Math.max(0, Math.min(1, wear));
  if (w <= 0) return pen;
  switch (pen.kind) {
    case "pencil":
      return {
        ...pen,
        widthMm: pen.widthMm * (1 + 0.5 * w),
        softnessMm: pen.softnessMm + 0.025 * w,
        opacity: pen.opacity * (1 - 0.35 * w),
        grain: Math.min(1, pen.grain + 0.3 * w),
        edgeRoughness: pen.edgeRoughness + 0.2 * w,
      };
    case "marker":
      return {
        ...pen,
        opacity: pen.opacity * (1 - 0.55 * w),
        dryness: 0.7 * w,
        streaks: w,
        grain: Math.min(1, pen.grain + 0.4 * w),
        edgeRoughness: pen.edgeRoughness + 0.4 * w,
      };
    default:
      return { ...pen, opacity: pen.opacity * (1 - 0.3 * w), dryness: 0.7 * w };
  }
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

/**
 * Graphite grades, hardest to softest: softer leads lay more graphite (darker,
 * wider, coarser, they smudge more) and wear down faster. 3H is fitted to the
 * owner's 3H letter and HB to the scans; the rest follow the grade charts
 * (Staedtler/JetPens samples): 6B is nearly black and grainy, 2H a light grey.
 */
const GRADES: { grade: string; width: number; pressureWidth: number; opacity: number; pressureTone: number; grain: number; grainScale: number; edge: number; taper: number; smear: number; smudge: number; softness: number; color: string; wear: number }[] = [
  { grade: "3H", width: 0.42, pressureWidth: 0.3, opacity: 0.42, pressureTone: 0.4, grain: 0.9, grainScale: 0.6, edge: 0.3, taper: 0.1, smear: 0.15, smudge: 0.5, softness: 0.03, color: "#46464d", wear: 0.35 },
  { grade: "2H", width: 0.44, pressureWidth: 0.31, opacity: 0.49, pressureTone: 0.41, grain: 0.89, grainScale: 0.62, edge: 0.3, taper: 0.105, smear: 0.19, smudge: 0.62, softness: 0.032, color: "#46464d", wear: 0.45 },
  { grade: "H", width: 0.46, pressureWidth: 0.32, opacity: 0.56, pressureTone: 0.42, grain: 0.88, grainScale: 0.64, edge: 0.3, taper: 0.11, smear: 0.24, smudge: 0.78, softness: 0.034, color: "#46464d", wear: 0.55 },
  { grade: "F", width: 0.49, pressureWidth: 0.335, opacity: 0.64, pressureTone: 0.435, grain: 0.865, grainScale: 0.67, edge: 0.3, taper: 0.115, smear: 0.29, smudge: 0.98, softness: 0.037, color: "#46464d", wear: 0.72 },
  { grade: "HB", width: 0.52, pressureWidth: 0.35, opacity: 0.72, pressureTone: 0.45, grain: 0.85, grainScale: 0.7, edge: 0.3, taper: 0.12, smear: 0.35, smudge: 1.2, softness: 0.04, color: "#46464d", wear: 1 },
  { grade: "B", width: 0.55, pressureWidth: 0.36, opacity: 0.77, pressureTone: 0.46, grain: 0.85, grainScale: 0.73, edge: 0.32, taper: 0.12, smear: 0.4, smudge: 1.4, softness: 0.043, color: "#424248", wear: 1.3 },
  { grade: "2B", width: 0.58, pressureWidth: 0.37, opacity: 0.81, pressureTone: 0.47, grain: 0.84, grainScale: 0.76, edge: 0.34, taper: 0.12, smear: 0.46, smudge: 1.6, softness: 0.046, color: "#3e3e44", wear: 1.7 },
  { grade: "3B", width: 0.61, pressureWidth: 0.38, opacity: 0.85, pressureTone: 0.48, grain: 0.84, grainScale: 0.8, edge: 0.36, taper: 0.12, smear: 0.52, smudge: 1.8, softness: 0.049, color: "#3a3a40", wear: 2.2 },
  { grade: "4B", width: 0.64, pressureWidth: 0.39, opacity: 0.88, pressureTone: 0.49, grain: 0.83, grainScale: 0.84, edge: 0.38, taper: 0.12, smear: 0.58, smudge: 2, softness: 0.052, color: "#35353a", wear: 2.8 },
  { grade: "5B", width: 0.67, pressureWidth: 0.4, opacity: 0.9, pressureTone: 0.5, grain: 0.83, grainScale: 0.89, edge: 0.4, taper: 0.12, smear: 0.64, smudge: 2.2, softness: 0.056, color: "#303035", wear: 3.5 },
  { grade: "6B", width: 0.7, pressureWidth: 0.41, opacity: 0.92, pressureTone: 0.51, grain: 0.82, grainScale: 0.94, edge: 0.42, taper: 0.12, smear: 0.7, smudge: 2.4, softness: 0.06, color: "#2b2b30", wear: 4.3 },
];

/** The grades offered, hardest first. */
export const PENCIL_GRADES = GRADES.map((g) => g.grade);

const GRADE_NOTES: Record<string, string> = { "3H": " (duro)", HB: " (normal)", "6B": " (muy blando)" };

const gradedPencil = (g: (typeof GRADES)[number]): PenModel => ({
  id: `pencil-${g.grade.toLowerCase()}`,
  label: `Lápiz ${g.grade}${GRADE_NOTES[g.grade] ?? ""}`,
  kind: "pencil",
  material: "graphite",
  widthMm: g.width,
  pressureWidth: g.pressureWidth,
  opacity: g.opacity,
  buildsUp: false,
  pressureTone: g.pressureTone,
  grain: g.grain,
  grainScale: g.grainScale,
  edgeRoughness: g.edge,
  taper: g.taper,
  startBlob: 0,
  endBlob: 0,
  skipProne: 0,
  blobProne: 0,
  smear: g.smear,
  smudge: g.smudge,
  softnessMm: g.softness,
  fixedColor: g.color,
  pointWear: g.wear,
});

/** Mechanical pencils with HB lead: the lead keeps its width, so they never need sharpening. */
const mechanical = (size: string, width: number, opacity: number, grain: number, grainScale: number, edge: number, pressureWidth: number, softness: number, smudge: number): PenModel => ({
  id: `mechanical-${size.replace(",", "")}`,
  label: `Portaminas ${size}`,
  kind: "pencil",
  material: "graphite",
  widthMm: width,
  pressureWidth,
  opacity,
  buildsUp: false,
  pressureTone: 0.35,
  grain,
  grainScale,
  edgeRoughness: edge,
  taper: 0.06,
  startBlob: 0,
  endBlob: 0,
  skipProne: 0,
  blobProne: 0,
  smear: 0.25,
  smudge,
  softnessMm: softness,
  fixedColor: PENCIL_COLOR,
});

/** The two ends of a red and blue pencil (the schoolteacher's correcting pencil). */
export const BICOLOR_INKS: InkColor[] = [
  { id: "bicolor-red", label: "Punta roja", value: "#c8262c" },
  { id: "bicolor-blue", label: "Punta azul", value: "#1f4ea6" },
];

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
    startBlob: 0.06,
    endBlob: 0.04,
    skipProne: 0.6,
    blobProne: 0.45,
    smear: 1,
    smudge: 1,
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
    startBlob: 0.06,
    endBlob: 0.04,
    skipProne: 0.6,
    blobProne: 0.4,
    smear: 0.9,
    smudge: 0.9,
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
    blobProne: 1,
    smear: 0.12,
    smudge: 0.2,
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
    blobProne: 0.12,
    smear: 1.2,
    smudge: 0.8,
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
    blobProne: 0.1,
    smear: 0.8,
    smudge: 0.6,
    softnessMm: 0.04,
  },
  ...GRADES.map(gradedPencil),
  {
    // Coloured wax: translucent and grainy, pale unless pressed hard (the owner's
    // green pencil line was barely there); it hardly smudges and the colour is free.
    id: "pencil-color",
    label: "Lápiz de color",
    kind: "pencil",
    material: "wax",
    widthMm: 0.6,
    pressureWidth: 0.35,
    opacity: 0.62,
    buildsUp: false,
    pressureTone: 0.55,
    grain: 0.95,
    grainScale: 0.85,
    edgeRoughness: 0.36,
    taper: 0.12,
    startBlob: 0,
    endBlob: 0,
    skipProne: 0,
    blobProne: 0,
    smear: 0.1,
    smudge: 0.15,
    softnessMm: 0.045,
    pointWear: 1.4,
  },
  {
    // A thick, firm coloured lead with a red end and a blue end.
    id: "pencil-bicolor",
    label: "Lápiz bicolor (rojo y azul)",
    kind: "pencil",
    material: "wax",
    widthMm: 0.72,
    pressureWidth: 0.3,
    opacity: 0.74,
    buildsUp: false,
    pressureTone: 0.45,
    grain: 0.88,
    grainScale: 0.9,
    edgeRoughness: 0.34,
    taper: 0.1,
    startBlob: 0,
    endBlob: 0,
    skipProne: 0,
    blobProne: 0,
    smear: 0.12,
    smudge: 0.2,
    softnessMm: 0.05,
    inkChoices: BICOLOR_INKS,
    pointWear: 1.2,
  },
  {
    // Charcoal pencil: deep matt black where pressed, the paper's tooth showing
    // through as white specks, soft powdery edges; it smudges more than anything.
    id: "charcoal",
    label: "Carboncillo",
    kind: "pencil",
    material: "charcoal",
    widthMm: 0.8,
    pressureWidth: 0.42,
    opacity: 0.93,
    buildsUp: false,
    pressureTone: 0.5,
    grain: 0.85,
    grainScale: 1.3,
    edgeRoughness: 0.55,
    taper: 0.1,
    startBlob: 0,
    endBlob: 0,
    skipProne: 0,
    blobProne: 0,
    smear: 0.9,
    smudge: 2.6,
    softnessMm: 0.075,
    fixedColor: "#1c1b1b",
    pointWear: 5,
  },
  mechanical("0,3", 0.3, 0.55, 0.55, 0.55, 0.12, 0.1, 0.015, 0.6),
  // Fitted to the owner's 0,5 mechanical pencil line.
  mechanical("0,5", 0.4, 0.55, 0.6, 0.6, 0.15, 0.15, 0.02, 0.8),
  mechanical("0,7", 0.58, 0.58, 0.65, 0.65, 0.18, 0.18, 0.025, 1),
  mechanical("0,9", 0.74, 0.6, 0.7, 0.7, 0.2, 0.2, 0.03, 1.1),
];

/** How the instrument list is grouped in the toolbar (group names are in es.ts). */
export const PEN_GROUPS: { id: "pens" | "markers" | "pencils" | "mechanical"; pens: string[] }[] = [
  { id: "pens", pens: PENS.filter((p) => p.kind === "gel" || p.kind === "ballpoint").map((p) => p.id) },
  { id: "markers", pens: PENS.filter((p) => p.kind === "marker").map((p) => p.id) },
  { id: "pencils", pens: PENS.filter((p) => p.kind === "pencil" && !p.id.startsWith("mechanical")).map((p) => p.id) },
  { id: "mechanical", pens: PENS.filter((p) => p.id.startsWith("mechanical")).map((p) => p.id) },
];

export const DEFAULT_PEN_ID = "gel-07";

export function penById(id: string): PenModel {
  return PENS.find((pen) => pen.id === id) ?? PENS[0];
}

/** The colour the instrument really writes in, given the colour chosen for it. */
export function drawnColor(pen: PenModel, chosen: string): string {
  if (pen.fixedColor) return pen.fixedColor;
  if (pen.inkChoices) return pen.inkChoices.find((c) => c.value.toLowerCase() === chosen.toLowerCase())?.value ?? pen.inkChoices[0].value;
  return chosen;
}
