// Draws a laid-out page with a pen model: variable width from pressure,
// tapered stroke ends, an ink blob where the pen lands, paper grain inside
// the line, and darker ink where strokes cross.

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

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(width));
  canvas.height = Math.max(1, Math.ceil(height));
  return canvas;
}

const grainCache = new Map<number, HTMLCanvasElement>();

/** Tileable speckle texture: where it is dark, ink is missing (paper fibres). */
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
      const alpha = Math.max(0, Math.min(1, (value - 0.5) * 2.4));
      const offset = (y * GRAIN_SIZE + x) * 4;
      image.data[offset + 3] = Math.round(alpha * 255);
    }
  }
  ctx.putImageData(image, 0, 0);
  grainCache.set(seed, canvas);
  return canvas;
}

let scratch: HTMLCanvasElement | null = null;

function scratchCanvas(width: number, height: number): HTMLCanvasElement {
  if (!scratch || scratch.width < width || scratch.height < height) {
    scratch = createCanvas(Math.max(width, scratch?.width ?? 0), Math.max(height, scratch?.height ?? 0));
  }
  return scratch;
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

export function renderPage(
  canvas: HTMLCanvasElement,
  layout: LayoutResult,
  hand: Hand,
  page: PageSettings,
  options: RenderOptions,
): void {
  const { pxPerMm, pen, color, naturalness: nat } = options;
  canvas.width = Math.round(page.widthMm * pxPerMm);
  canvas.height = Math.round(page.heightMm * pxPerMm);
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  if (options.background === "white") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  } else {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  const grain = grainTexture(options.seed);
  const grainStrength = Math.min(1, pen.grain * (0.4 + 0.9 * nat.inkTexture));
  const baseWidthPx = pen.widthMm * pxPerMm;
  const stepPx = Math.max(0.5, pxPerMm * 0.04);
  const softPx = pen.softnessMm * pxPerMm;
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
      const widths = samples.map((sample) => {
        const fromEnd = Math.min(sample.s, length - sample.s);
        return Math.max(0.6, strokeWidth * pressureFactor(pen, sample.p) * taperFactor(fromEnd, taperLength));
      });

      // Draw the stroke opaque on a small scratch canvas, then lay it on the
      // page translucent, so only crossings between strokes get darker.
      // Integer offsets: the scratch is copied pixel for pixel, never resampled,
      // so nothing from outside the stroke's box can bleed onto the page.
      const maxWidth = Math.max(...widths) * (1 + pen.startBlob);
      const pad = Math.ceil(maxWidth + softPx * 3 + 2);
      const minX = Math.floor(Math.min(...samples.map((s) => s.x)) - pad);
      const minY = Math.floor(Math.min(...samples.map((s) => s.y)) - pad);
      const maxX = Math.ceil(Math.max(...samples.map((s) => s.x)) + pad);
      const maxY = Math.ceil(Math.max(...samples.map((s) => s.y)) + pad);
      const width = maxX - minX;
      const height = maxY - minY;
      const work = scratchCanvas(width, height);
      const wctx = work.getContext("2d")!;
      wctx.setTransform(1, 0, 0, 1, 0, 0);
      wctx.globalCompositeOperation = "source-over";
      wctx.globalAlpha = 1;
      wctx.clearRect(0, 0, work.width, work.height);
      wctx.strokeStyle = color;
      wctx.fillStyle = color;
      wctx.lineCap = "round";
      wctx.lineJoin = "round";

      if (samples.length === 1) {
        wctx.beginPath();
        wctx.arc(samples[0].x - minX, samples[0].y - minY, widths[0] / 2, 0, Math.PI * 2);
        wctx.fill();
      }
      for (let i = 1; i < samples.length; i++) {
        wctx.lineWidth = (widths[i - 1] + widths[i]) / 2;
        wctx.beginPath();
        wctx.moveTo(samples[i - 1].x - minX, samples[i - 1].y - minY);
        wctx.lineTo(samples[i].x - minX, samples[i].y - minY);
        wctx.stroke();
      }
      if (pen.startBlob > 0) {
        const blob = (widths[0] / 2) * (1 + pen.startBlob * (0.5 + rng.next()));
        wctx.beginPath();
        wctx.arc(samples[0].x - minX, samples[0].y - minY, blob, 0, Math.PI * 2);
        wctx.fill();
      }

      if (grainStrength > 0) {
        const pattern = wctx.createPattern(grain, "repeat");
        if (pattern) {
          const texel = GRAIN_TEXEL_MM * pxPerMm;
          pattern.setTransform(
            new DOMMatrix().translate(-minX + rng.next() * GRAIN_SIZE * texel, -minY + rng.next() * GRAIN_SIZE * texel).scale(texel),
          );
          wctx.globalCompositeOperation = "destination-out";
          wctx.globalAlpha = grainStrength;
          wctx.fillStyle = pattern;
          wctx.fillRect(0, 0, width, height);
        }
      }

      ctx.save();
      ctx.globalCompositeOperation = options.background === "white" ? "multiply" : "source-over";
      ctx.globalAlpha = Math.max(0.3, Math.min(1, pen.opacity * (1 - 0.12 * nat.inkTexture * rng.next())));
      ctx.imageSmoothingEnabled = false;
      if (softPx > 0.35) ctx.filter = `blur(${softPx.toFixed(2)}px)`;
      ctx.drawImage(work, 0, 0, width, height, minX, minY, width, height);
      ctx.restore();
    });
  }
}
