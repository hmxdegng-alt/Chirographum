// Page geometry, naturalness (imperfections) and the factory presets.

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

export const A4: PageSettings = {
  widthMm: 210,
  heightMm: 297,
  marginLeftMm: 25,
  marginRightMm: 20,
  marginTopMm: 25,
  marginBottomMm: 20,
  xHeightMm: 2.8,
  lineSpacingMm: 8.5,
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
    },
  },
];

export const DEFAULT_PRESET_ID = "normal";

export function presetById(id: string): Preset {
  return PRESETS.find((preset) => preset.id === id) ?? PRESETS[1];
}
