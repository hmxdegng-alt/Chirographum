// Page geometry, naturalness (imperfections) and the factory presets.

import { createRng, deriveSeed } from "./random";

export interface PageSettings {
  widthMm: number;
  heightMm: number;
  marginLeftMm: number;
  marginRightMm: number;
  marginTopMm: number;
  marginBottomMm: number;
  /** Height of a lowercase "x" on paper. Adult handwriting is usually 2.5–3.5 mm. */
  xHeightMm: number;
  lineSpacingMm: number;
  /** Gap between letters, in x-height units. */
  letterSpacing: number;
  /** Width of a space, in x-height units. */
  wordSpacing: number;
}

/** Paper drawn under the text (and printed if wanted). */
export type PaperKind = "blank" | "lined" | "grid4" | "grid5" | "dots";

export interface PaperSettings {
  kind: PaperKind;
  /** Distance between ruled lines (lined paper), in millimetres. */
  lineSpacingMm: number;
  /** Red margin line on the left. */
  marginLine: boolean;
  /** Print the lines too; off = they are only a guide on screen (writing on a real notebook). */
  print: boolean;
}

export const DEFAULT_PAPER: PaperSettings = {
  kind: "blank",
  lineSpacingMm: 8,
  marginLine: false,
  print: true,
};

/** Distance between the lines the text sits on, or null for blank paper. */
export function paperRuling(paper: PaperSettings): number | null {
  switch (paper.kind) {
    case "lined":
      return Math.max(3, paper.lineSpacingMm);
    case "grid4":
      return 4;
    case "grid5":
    case "dots":
      return 5;
    default:
      return null;
  }
}

/** Where the first ruled line is, from the top of the page (lined paper leaves a header). */
export function paperFirstLine(paper: PaperSettings): number {
  return paper.kind === "lined" ? 20 : 0;
}

export const A4: PageSettings = {
  widthMm: 210,
  heightMm: 297,
  marginLeftMm: 25,
  marginRightMm: 20,
  marginTopMm: 25,
  marginBottomMm: 20,
  xHeightMm: 2.8,
  // Measured on real handwritten letters: about 2.7 mm x-height and 10 mm between lines.
  lineSpacingMm: 9.5,
  letterSpacing: 0.14,
  wordSpacing: 1.2,
};

/** Every value goes from 0 (none) to 1 (a lot), except slantDegrees. */
export interface Naturalness {
  sizeVariation: number;
  rotation: number;
  /** Extra slant added to the user's own, in degrees. Positive leans right. */
  slantDegrees: number;
  slantVariation: number;
  baselineWobble: number;
  lineDrift: number;
  spacingVariation: number;
  edgeShrink: number;
  marginDrift: number;
  inkTexture: number;
  /** The writer's habit of writing uphill (positive) or downhill, in degrees. */
  lineSlope: number;
  /** An old pen that skips: gaps and faint stretches inside the line (0–1). */
  inkSkips: number;
  /** The highlighter drags a little fresh ink along with it (0–1). */
  highlighterSmear: number;
  /** The writing hand rubs over fresh ink or graphite now and then (0–1). */
  handSmudges: number;
}

export interface Preset {
  id: string;
  label: string;
  values: Naturalness;
}

export const PRESETS: Preset[] = [
  {
    id: "careful",
    label: "Cuidadoso",
    values: {
      sizeVariation: 0.2,
      rotation: 0.2,
      slantDegrees: 0,
      slantVariation: 0.15,
      baselineWobble: 0.2,
      lineDrift: 0.15,
      spacingVariation: 0.2,
      edgeShrink: 0.2,
      marginDrift: 0.15,
      inkTexture: 0.35,
      lineSlope: 0,
      inkSkips: 0,
      highlighterSmear: 0.2,
      handSmudges: 0,
    },
  },
  {
    id: "normal",
    label: "Normal",
    values: {
      sizeVariation: 0.45,
      rotation: 0.4,
      slantDegrees: 0,
      slantVariation: 0.35,
      baselineWobble: 0.4,
      lineDrift: 0.4,
      spacingVariation: 0.4,
      edgeShrink: 0.45,
      marginDrift: 0.35,
      inkTexture: 0.5,
      lineSlope: 0,
      inkSkips: 0,
      highlighterSmear: 0.45,
      handSmudges: 0.05,
    },
  },
  {
    id: "hurried",
    label: "Con prisa",
    values: {
      sizeVariation: 0.7,
      rotation: 0.65,
      slantDegrees: 4,
      slantVariation: 0.6,
      baselineWobble: 0.65,
      lineDrift: 0.75,
      spacingVariation: 0.7,
      edgeShrink: 0.75,
      marginDrift: 0.6,
      inkTexture: 0.65,
      lineSlope: 0,
      inkSkips: 0,
      highlighterSmear: 0.75,
      handSmudges: 0.15,
    },
  },
];

export const DEFAULT_PRESET_ID = "normal";

export function presetById(id: string): Preset {
  return PRESETS.find((preset) => preset.id === id) ?? PRESETS[1];
}

/**
 * Believable imperfections for one page. A single "hurry" level for the
 * whole page keeps the values coherent (a careful page is careful in
 * everything), with a little independent variation per value.
 */
export function randomNaturalness(seed: number): Naturalness {
  const rng = createRng(deriveSeed(seed, "random-preset"));
  const careful = presetById("careful").values;
  const hurried = presetById("hurried").values;
  const hurry = rng.next();
  const result = { ...careful };
  for (const key of Object.keys(careful) as (keyof Naturalness)[]) {
    const t = Math.max(0, Math.min(1, hurry + (rng.next() - 0.5) * 0.3));
    const value = careful[key] + (hurried[key] - careful[key]) * t;
    result[key] = key === "slantDegrees" ? Math.round(value + (rng.next() - 0.5) * 3) : Math.round(value * 100) / 100;
  }
  // A gentle habit of writing uphill or downhill; the pen never skips by chance.
  result.lineSlope = Math.round((rng.next() * 2 - 1) * 10) / 10;
  result.inkSkips = 0;
  return result;
}

/** Imperfections scaled by the overall "Naturalidad" amount (slant is the writer's, it stays). */
export function scaledNaturalness(values: Naturalness, amount: number): Naturalness {
  const result = { ...values };
  for (const key of Object.keys(values) as (keyof Naturalness)[]) {
    if (key === "slantDegrees") continue;
    result[key] = values[key] * amount;
  }
  return result;
}
