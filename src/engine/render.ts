// Draws a laid-out page with a pen model: variable width from pressure,
// tapered stroke ends, an ink blob where the pen lands and paper grain.
//
// Pens and pencils do not get darker where strokes cross, so all strokes
// go into one tone mask first (brightness = how much ink), merged with
// "lighten" (the darker of two inks wins, they never add up). The mask is
// then turned into coloured ink with a single opacity.

import { resample } from "./geometry";
import type { Hand } from "./hand";
import { glyphPointToPage, type LayoutResult } from "./layout";
import type { PenModel } from "./pens";
import { createRng, deriveSeed } from "./random";
import type { Naturalness, PageSettings } from "./settings";

export interface RenderOptions {
  pxPerMm: number;
  pen: PenModel;
  color: string;
  naturalness: Naturalness;
  seed: number;
  /** "white" for the on-screen preview, "transparent" for printing (the paper is the background). */
  background: "white" | "transparent";
}

/** Size of one texel of the grain texture on paper, in millimetres. */
const GRAIN_TEXEL_MM = 0.03;
const GRAIN_SIZE = 256;
/** Rows converted per pass from tone mask to ink, to keep memory low at 600 dpi. */
const BAND_ROWS = 256;
/** Tone levels used for stroke colours (avoids building thousands of colour strings). */
const TONE_LEVELS = 64;

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(width));
  canvas.height = Math.max(1, Math.ceil(height));
  return canvas;
}

const grainCache = new Map<number, HTMLCanvasElement>();

/**
 * Tileable paper texture, opaque grey: white where the paper takes ink,
 * darker where fibres leave tiny gaps. Multiplied over the tone mask.
 */
function grainTexture(seed: number): HTMLCanvasElement {
  const cached = grainCache.get(seed);
  if (cached) return cached;
  const rng = createRng(deriveSeed(seed, "grain"));
  const coarseSize = 32;
  const coarse = Array.from({ length: coarseSize * coarseSize }, () => rng.next());
  const canvas = createCanvas(GRAIN_SIZE, GRAIN_SIZE);
  const ctx = canvas.getContext("2d")!;
  const image = ctx.createImageData(GRAIN_SIZE, GRAIN_SIZE);
  const cell = GRAIN_SIZE / coarseSize;
  const sample = (gx: number, gy: number) => coarse[((gy + coarseSize) % coarseSize) * coarseSize + ((gx + coarseSize) % coarseSize)];
  for (let y = 0; y < GRAIN_SIZE; y++) {
    for (let x = 0; x < GRAIN_SIZE; x++) {
      const fx = x / cell;
      const fy = y / cell;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      const top = sample(x0, y0) * (1 - tx) + sample(x0 + 1, y0) * tx;
      const bottom = sample(x0, y0 + 1) * (1 - tx) + sample(x0 + 1, y0 + 1) * tx;
      const smooth = top * (1 - ty) + bottom * ty;
      const value = 0.55 * smooth + 0.45 * rng.next();
      const gap = Math.max(0, Math.min(1, (value - 0.5) * 2.4));
      const grey = Math.round((1 - gap) * 255);
      const offset = (y * GRAIN_SIZE + x) * 4;
      image.data[offset] = grey;
      image.data[offset + 1] = grey;
      image.data[offset + 2] = grey;
      image.data[offset + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  grainCache.set(seed, canvas);
  return canvas;
}

const toneStyles = Array.from({ length: TONE_LEVELS + 1 }, (_, i) => {
  const v = Math.round((i / TONE_LEVELS) * 255);
  return `rgb(${v},${v},${v})`;
});

/** Grey for a tone between 0 (no ink) and 1 (full ink). */
function toneStyle(tone: number): string {
  return toneStyles[Math.round(Math.max(0, Math.min(1, tone)) * TONE_LEVELS)];
}

/** Width multiplier from pressure (0.3–1). */
function pressureFactor(pen: PenModel, pressure: number): number {
  return 1 - pen.pressureWidth + pen.pressureWidth * (0.35 + 0.9 * pressure);
}

/** Thin at the very start and end of a stroke, full width in the middle. */
function taperFactor(distanceFromEnd: number, taperLength: number): number {
  if (taperLength <= 0) return 1;
  const k = Math.min(1, distanceFromEnd / taperLength);
  return 0.45 + 0.55 * Math.pow(k, 0.6);
}

function parseHex(color: string): [number, number, number] {
  const hex = color.replace("#", "");
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex.padEnd(6, "0");
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) || 0) as [number, number, number];
}

export function renderPage(
  canvas: HTMLCanvasElement,
  layout: LayoutResult,
  hand: Hand,
  page: PageSettings,
  options: RenderOptions,
): void {
  const { pxPerMm, pen, naturalness: nat } = options;
  canvas.width = Math.round(page.widthMm * pxPerMm);
  canvas.height = Math.round(page.heightMm * pxPerMm);
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = "none";
  ctx.globalAlpha = 1;

  // 1. Tone mask: black = no ink, white = full ink.
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.globalCompositeOperation = "lighten";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const baseWidthPx = pen.widthMm * pxPerMm;
  const stepPx = Math.max(0.5, pxPerMm * 0.04);
  const xh = page.xHeightMm;

  for (const glyph of layout.glyphs) {
    const variant = hand.glyphs[glyph.char]?.[glyph.variantIndex];
    if (!variant) continue;
    variant.strokes.forEach((stroke, strokeIndex) => {
      if (stroke.length === 0) return;
      const rng = createRng(deriveSeed(glyph.seed, "stroke", strokeIndex));
      const pagePoints = stroke.map((point) => {
        const mapped = glyphPointToPage(glyph, xh, point.x, point.y);
        return { x: mapped.x * pxPerMm, y: mapped.y * pxPerMm, p: point.p };
      });
      const samples = resample(pagePoints, stepPx);
      const length = samples[samples.length - 1].s;
      const taperLength = pen.taper * Math.max(length, xh * pxPerMm);
      const strokeWidth = baseWidthPx * (1 + rng.gauss() * 0.04 * nat.inkTexture);
      // Each stroke carries slightly more or less ink; pressure lightens the tone.
      const strokeTone = 1 - 0.07 * nat.inkTexture * rng.next();
      const toneAt = (pressure: number) => strokeTone * (1 - pen.pressureTone * (1 - pressure) * (0.6 + 0.8 * nat.inkTexture));
      const widths = samples.map((sample) => {
        const fromEnd = Math.min(sample.s, length - sample.s);
        return Math.max(0.6, strokeWidth * pressureFactor(pen, sample.p) * taperFactor(fromEnd, taperLength));
      });

      if (samples.length === 1) {
        ctx.fillStyle = toneStyle(toneAt(samples[0].p));
        ctx.beginPath();
        ctx.arc(samples[0].x, samples[0].y, widths[0] / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      for (let i = 1; i < samples.length; i++) {
        ctx.strokeStyle = toneStyle(toneAt((samples[i - 1].p + samples[i].p) / 2));
        ctx.lineWidth = (widths[i - 1] + widths[i]) / 2;
        ctx.beginPath();
        ctx.moveTo(samples[i - 1].x, samples[i - 1].y);
        ctx.lineTo(samples[i].x, samples[i].y);
        ctx.stroke();
      }
      if (pen.startBlob > 0) {
        // The pen rests a moment where it lands: a little wider and full tone.
        const blob = (widths[0] / 2) * (1 + pen.startBlob * (0.5 + rng.next()));
        ctx.fillStyle = toneStyle(1);
        ctx.beginPath();
        ctx.arc(samples[0].x, samples[0].y, blob, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }

  // 2. Paper grain: the same paper under every stroke.
  const grainStrength = Math.min(1, pen.grain * (0.4 + 0.9 * nat.inkTexture));
  if (grainStrength > 0) {
    const pattern = ctx.createPattern(grainTexture(options.seed), "repeat");
    if (pattern) {
      const texel = GRAIN_TEXEL_MM * pxPerMm;
      const rng = createRng(deriveSeed(options.seed, "grain-offset"));
      pattern.setTransform(new DOMMatrix().translate(rng.next() * GRAIN_SIZE * texel, rng.next() * GRAIN_SIZE * texel).scale(texel));
      ctx.globalCompositeOperation = "multiply";
      ctx.globalAlpha = grainStrength;
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.globalAlpha = 1;
    }
  }

  // 3. Soft edges (pencil, ballpoint), still on the opaque mask.
  const softPx = pen.softnessMm * pxPerMm;
  if (softPx > 0.35) {
    ctx.globalCompositeOperation = "copy";
    ctx.filter = `blur(${softPx.toFixed(2)}px)`;
    ctx.drawImage(canvas, 0, 0);
    ctx.filter = "none";
  }

  // 4. Mask to coloured ink, in bands.
  ctx.globalCompositeOperation = "source-over";
  const [r, g, b] = parseHex(options.color);
  const opacity = Math.max(0, Math.min(1, pen.opacity));
  const white = options.background === "white";
  for (let top = 0; top < canvas.height; top += BAND_ROWS) {
    const rows = Math.min(BAND_ROWS, canvas.height - top);
    const band = ctx.getImageData(0, top, canvas.width, rows);
    const data = band.data;
    for (let i = 0; i < data.length; i += 4) {
      const a = (data[i] / 255) * opacity;
      if (white) {
        // Ink over white paper.
        data[i] = Math.round(255 + (r - 255) * a);
        data[i + 1] = Math.round(255 + (g - 255) * a);
        data[i + 2] = Math.round(255 + (b - 255) * a);
        data[i + 3] = 255;
      } else {
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = Math.round(a * 255);
      }
    }
    ctx.putImageData(band, 0, top);
  }
}
