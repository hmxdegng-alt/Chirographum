// Draws one page of a layout with a pen model: variable width from
// pressure, bumpy edges, round ink-pooled ends, paper grain and, for old
// pens, skips.
//
// Pens and pencils do not get darker where strokes cross, so all strokes
// go into one tone mask first (brightness = how much ink), merged with
// "lighten" (the darker of two inks wins, they never add up). The mask is
// then turned into coloured ink with a single opacity. Markers do build up:
// each stroke becomes its own translucent layer.

import { resample, type Sample } from "./geometry";
import type { Hand } from "./hand";
import { glyphPointToPage, type Decoration, type LayoutResult } from "./layout";
import { PENCIL_COLOR, penById, wornPen, type PenModel } from "./pens";
import { createRng, deriveSeed, type Rng } from "./random";
import { HIGHLIGHT_COLORS, scribbleStyleOf, type RunStyle } from "./rich-text";
import { scribbleStrokes } from "./scribble";
import { paperFirstLine, paperRuling, type Naturalness, type PageSettings, type PaperSettings } from "./settings";

export interface RenderOptions {
  pxPerMm: number;
  pen: PenModel;
  color: string;
  naturalness: Naturalness;
  seed: number;
  /** Page of the layout to draw (0-based). */
  pageIndex: number;
  /** "white" for the on-screen preview, "transparent" for printing (the paper is the background). */
  background: "white" | "transparent";
  /** Line width multiplier set by the user ("Grosor"), 1 = the pen as it is. */
  widthScale?: number;
  /** Ink amount multiplier ("Intensidad"), 1 = the pen as it is. */
  inkStrength?: number;
  /** How used the instruments are (0 = new): see wornPen. */
  wear?: number;
  /** Screen only: imitate how an inkjet printer lays the ink (fibres, dots). */
  printedLook?: boolean;
  paper?: PaperSettings;
  /** Draw the paper's lines (always on screen; when printing, only if the user wants them). */
  drawPaper?: boolean;
  /** Instruments and colours chosen for parts of the text (glyph.style points here). */
  runStyles?: RunStyle[];
  /** Left-handed writers drag the hand over fresh ink: more and longer smudges. */
  leftHanded?: boolean;
}

/** Pixel box around all the ink of the page, or null for an empty page. */
export interface InkBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Size of one texel of the grain texture on paper, in millimetres. */
const GRAIN_TEXEL_MM = 0.03;
const GRAIN_SIZE = 256;
/** Rows converted per pass from tone mask to ink, to keep memory low at 600 dpi. */
const BAND_ROWS = 256;
/** Tone levels used for stroke colours (avoids building thousands of colour strings). */
const TONE_LEVELS = 64;
/** Wavelength of the edge bumps and of pen skips, in millimetres. */
const EDGE_NOISE_MM = 0.09;
const SKIP_NOISE_MM = 0.45;

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

/** Smooth 1D noise in [-1, 1] along a distance, with the given wavelength. */
function noise1D(rng: Rng, wavelength: number): (s: number) => number {
  const values: number[] = [];
  return (s: number) => {
    const t = s / wavelength;
    const i = Math.floor(t);
    while (values.length <= i + 1) values.push(rng.next() * 2 - 1);
    const k = t - i;
    const smooth = k * k * (3 - 2 * k);
    return values[i] * (1 - smooth) + values[i + 1] * smooth;
  };
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

interface StrokeGeometry {
  samples: Sample[];
  widths: number[];
  tones: number[];
  startBlob: number;
  endBlob: number;
  /**
   * A chisel tip (highlighters): the direction of its edge, a unit vector, and
   * the seed of the irregular ends. The stroke is then a band instead of round dabs.
   */
  chisel?: { x: number; y: number; seed: number; poolStart: number; poolEnd: number };
  /** Seed for what is drawn over the stroke afterwards (dry streaks), from the letter's identity. */
  seed?: number;
}

/**
 * A drying felt tip leaves pale streaks along the stroke: a few thin lines of
 * "no ink" drawn into the tone mask (black = no ink), each covering part of it.
 */
function drawStreaks(ctx: CanvasRenderingContext2D, strokes: StrokeGeometry[], amount: number, dx: number, dy: number): void {
  if (amount <= 0) return;
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const g of strokes) {
    const n = g.samples.length;
    if (n < 3) continue;
    const rng = createRng(deriveSeed(g.seed ?? 0, "streaks"));
    const width = g.widths.reduce((sum, w) => sum + w, 0) / n;
    // Scratchy: many fine pale lines anywhere across the width, edges included,
    // each of its own strength and length, like dry felt fibres dragged along.
    const lines = 5 + Math.round(amount * 6 + rng.next() * 2);
    for (let l = 0; l < lines; l++) {
      const offset = rng.next() - 0.5;
      const from = Math.floor(rng.next() * 0.6 * n);
      const to = Math.min(n, from + Math.ceil((0.3 + 0.7 * rng.next()) * n));
      ctx.strokeStyle = `rgba(0,0,0,${Math.min(1, amount * (0.25 + 0.6 * rng.next())).toFixed(3)})`;
      ctx.lineWidth = Math.max(0.5, width * (0.04 + 0.08 * rng.next()) * (0.6 + amount));
      ctx.beginPath();
      for (let i = from; i < to; i++) {
        const a = g.samples[Math.max(0, i - 1)];
        const b = g.samples[Math.min(n - 1, i + 1)];
        const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const nx = -(b.y - a.y) / length;
        const ny = (b.x - a.x) / length;
        const x = g.samples[i].x - dx + nx * offset * g.widths[i];
        const y = g.samples[i].y - dy + ny * offset * g.widths[i];
        if (i === from) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Part of a stroke, between two distances along it. */
function sliceGeometry(g: StrokeGeometry, from: number, to: number): StrokeGeometry | null {
  const keep = g.samples.map((s, i) => (s.s >= from && s.s <= to ? i : -1)).filter((i) => i >= 0);
  if (keep.length < 2) return null;
  return {
    samples: keep.map((i) => g.samples[i]),
    widths: keep.map((i) => g.widths[i]),
    tones: keep.map((i) => g.tones[i]),
    startBlob: 0,
    endBlob: 0,
    chisel: g.chisel,
  };
}

/**
 * A chisel-tip stroke: one band, a little darker along its edges where the ink
 * dries. The ends are roughly straight but never neat: each one leans its own
 * way, bulges or dips a little, wobbles and has softened corners, as on the
 * owner's sample sheet.
 */
function drawChisel(ctx: CanvasRenderingContext2D, g: StrokeGeometry, dx: number, dy: number): void {
  const { samples, widths, tones } = g;
  const edge = g.chisel!;
  const rng = createRng(edge.seed);
  const n = samples.length;
  const side = (sign: number) => samples.map((s, i) => ({ x: s.x - dx + sign * edge.x * (widths[i] / 2), y: s.y - dy + sign * edge.y * (widths[i] / 2) }));
  const top = side(1);
  const bottom = side(-1);
  const unit = (a: Sample, b: Sample) => {
    const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
  };
  const width = widths.reduce((sum, w) => sum + w, 0) / n;
  /** The outline of one end, from corner `a` to corner `b`, pushed out along `out`. */
  const cap = (a: { x: number; y: number }, b: { x: number; y: number }, out: { x: number; y: number }) => {
    // Each corner stops a little earlier or later: the end leans its own way.
    const shiftA = (rng.next() - 0.5) * 0.55 * width;
    const shiftB = (rng.next() - 0.5) * 0.55 * width;
    const bulge = (-0.1 + 0.28 * rng.next()) * width;
    const wobble = noise1D(rng, 0.18 * width);
    const corner = 0.06 + 0.16 * rng.next();
    const points: { x: number; y: number }[] = [];
    const STEPS = 10;
    for (let k = 0; k <= STEPS; k++) {
      const u = k / STEPS;
      const shift = shiftA + (shiftB - shiftA) * u;
      // Softened corners: the outline curls back in at both ends of the cap.
      const near = Math.min(u, 1 - u);
      const round = near < corner ? -((1 - near / corner) ** 2) * 0.12 * width : 0;
      const push = shift + bulge * Math.sin(Math.PI * u) ** 0.7 + 0.08 * width * wobble(u * width) + round;
      points.push({ x: a.x + (b.x - a.x) * u + out.x * push, y: a.y + (b.y - a.y) * u + out.y * push });
    }
    return points;
  };
  const back = unit(samples[1], samples[0]);
  const ahead = unit(samples[n - 2], samples[n - 1]);
  const startCap = cap(bottom[0], top[0], back);
  const endCap = cap(top[n - 1], bottom[n - 1], ahead);
  const tone = tones.reduce((sum, t) => sum + t, 0) / tones.length;
  const outline = new Path2D();
  startCap.forEach((p, i) => (i === 0 ? outline.moveTo(p.x, p.y) : outline.lineTo(p.x, p.y)));
  for (let i = 1; i < n - 1; i++) outline.lineTo(top[i].x, top[i].y);
  for (const p of endCap) outline.lineTo(p.x, p.y);
  for (let i = n - 2; i >= 1; i--) outline.lineTo(bottom[i].x, bottom[i].y);
  outline.closePath();
  const base = tone * 0.8;
  ctx.fillStyle = toneStyle(base);
  ctx.fill(outline);
  // Where the tip rested a moment, more ink soaked in: darker towards that end.
  const pool = (at: Sample, out: { x: number; y: number }, length: number) => {
    if (length <= 0) return;
    const gradient = ctx.createLinearGradient(at.x - dx - out.x * length, at.y - dy - out.y * length, at.x - dx + out.x * 0.2 * width, at.y - dy + out.y * 0.2 * width);
    gradient.addColorStop(0, toneStyle(base));
    gradient.addColorStop(0.55, toneStyle(Math.min(1, tone * 0.93)));
    gradient.addColorStop(1, toneStyle(1));
    ctx.save();
    ctx.clip(outline);
    ctx.fillStyle = gradient;
    const reach = length + 2 * width;
    ctx.fillRect(at.x - dx - reach, at.y - dy - reach, 2 * reach, 2 * reach);
    ctx.restore();
  };
  pool(samples[0], back, edge.poolStart);
  pool(samples[n - 1], ahead, edge.poolEnd);
  // Darker borders along the sides and round the ends.
  ctx.strokeStyle = toneStyle(tone * 0.95);
  ctx.lineWidth = Math.max(0.6, width * 0.05);
  ctx.lineJoin = "round";
  ctx.stroke(outline);
}

/** Turns one drawn stroke into page samples with width and tone at each one. */
function strokeGeometry(
  stroke: { x: number; y: number; p: number }[],
  rng: Rng,
  pen: PenModel,
  nat: Naturalness,
  pxPerMm: number,
  xhMm: number,
  widthScale: number,
): StrokeGeometry {
  const samples = resample(stroke, Math.max(0.5, pxPerMm * 0.04));
  const length = samples[samples.length - 1].s;
  const taperLength = pen.taper * Math.max(length, xhMm * pxPerMm);
  const strokeWidth = pen.widthMm * widthScale * pxPerMm * (1 + rng.gauss() * 0.04 * nat.inkTexture);
  const edge = noise1D(rng, EDGE_NOISE_MM * pxPerMm);
  const edgeAmount = pen.edgeRoughness * (0.5 + 0.8 * nat.inkTexture);
  const skips = noise1D(rng, SKIP_NOISE_MM * pxPerMm * (0.6 + rng.next()));
  const skipLevel = Math.max(nat.inkSkips * pen.skipProne, (pen.dryness ?? 0) * 0.85);
  // Each stroke carries slightly more or less ink; pressure lightens the tone.
  const strokeTone = 1 - 0.07 * nat.inkTexture * rng.next();

  const widths: number[] = [];
  const tones: number[] = [];
  for (const sample of samples) {
    const fromEnd = Math.min(sample.s, length - sample.s);
    const bump = 1 + edge(sample.s) * edgeAmount;
    widths.push(Math.max(0.6, strokeWidth * pressureFactor(pen, sample.p) * taperFactor(fromEnd, taperLength) * bump));
    let tone = strokeTone * (1 - pen.pressureTone * (1 - sample.p) * (0.6 + 0.8 * nat.inkTexture));
    if (skipLevel > 0) {
      // An old pen leaves gaps and faint stretches; worse in long, fast strokes.
      // Sharp gaps with a faint trace left in them, like a dry ballpoint.
      const n = (skips(sample.s) + 1) / 2;
      const threshold = skipLevel * 0.75;
      const k = Math.max(0, Math.min(1, (n - threshold + 0.08) / 0.08));
      tone *= 0.06 + 0.94 * k * k;
    }
    tones.push(tone);
  }
  return {
    samples,
    widths,
    tones,
    startBlob: pen.startBlob > 0 ? (widths[0] / 2) * (1 + pen.startBlob * (0.5 + rng.next())) : 0,
    endBlob: pen.endBlob > 0 ? (widths[widths.length - 1] / 2) * (1 + pen.endBlob * (0.3 + rng.next())) : 0,
  };
}

/** Draws a stroke as tone (grey levels) with "lighten", so it never darkens itself. */
function drawTone(ctx: CanvasRenderingContext2D, g: StrokeGeometry, dx: number, dy: number): void {
  if (g.chisel && g.samples.length > 1) {
    drawChisel(ctx, g, dx, dy);
    return;
  }
  const { samples, widths, tones } = g;
  if (samples.length === 1) {
    ctx.fillStyle = toneStyle(tones[0]);
    ctx.beginPath();
    ctx.arc(samples[0].x - dx, samples[0].y - dy, widths[0] / 2, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 1; i < samples.length; i++) {
    ctx.strokeStyle = toneStyle((tones[i - 1] + tones[i]) / 2);
    ctx.lineWidth = (widths[i - 1] + widths[i]) / 2;
    ctx.beginPath();
    ctx.moveTo(samples[i - 1].x - dx, samples[i - 1].y - dy);
    ctx.lineTo(samples[i].x - dx, samples[i].y - dy);
    ctx.stroke();
  }
  // The pen rests a moment where it lands and lifts: a little ink pools there.
  const last = samples[samples.length - 1];
  if (g.startBlob > 0) {
    ctx.fillStyle = toneStyle(Math.max(tones[0], 0.9));
    ctx.beginPath();
    ctx.arc(samples[0].x - dx, samples[0].y - dy, g.startBlob, 0, Math.PI * 2);
    ctx.fill();
  }
  if (g.endBlob > 0) {
    ctx.fillStyle = toneStyle(tones[tones.length - 1]);
    ctx.beginPath();
    ctx.arc(last.x - dx, last.y - dy, g.endBlob, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Multiplies the paper grain over a tone mask; offsets keep it fixed to the page. */
function applyGrain(ctx: CanvasRenderingContext2D, options: RenderOptions, offsetX: number, offsetY: number, width: number, height: number): void {
  const { pen, naturalness: nat, pxPerMm } = options;
  const strength = Math.min(1, pen.grain * (0.4 + 0.9 * nat.inkTexture));
  if (strength <= 0) return;
  const pattern = ctx.createPattern(grainTexture(options.seed), "repeat");
  if (!pattern) return;
  const texel = GRAIN_TEXEL_MM * pen.grainScale * pxPerMm;
  const rng = createRng(deriveSeed(options.seed, "grain-offset", options.pageIndex));
  pattern.setTransform(
    new DOMMatrix().translate(rng.next() * GRAIN_SIZE * texel - offsetX, rng.next() * GRAIN_SIZE * texel - offsetY).scale(texel),
  );
  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  ctx.globalAlpha = strength;
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

/** How strongly the printed look applies: it only shows when zoomed in enough to see fibres. */
function printedStrength(options: RenderOptions): number {
  if (!options.printedLook) return 0;
  return Math.max(0, Math.min(1, (options.pxPerMm - 5) / 10));
}

function softPx(options: RenderOptions): number {
  // An inkjet's drops spread a little into the paper before they dry.
  const spreadMm = 0.06 * printedStrength(options);
  return Math.max(options.pen.softnessMm, spreadMm) * options.pxPerMm;
}

const FIBRE_SIZE = 512;
let fibreTexture: Float32Array | null = null;

/**
 * Paper fibres seen at 1200 ppp: thin random strands. Printer ink (and, less,
 * pen ink) creeps along them, which gives printed lines their hairy edges.
 */
function fibres(): Float32Array {
  if (fibreTexture) return fibreTexture;
  const canvas = createCanvas(FIBRE_SIZE, FIBRE_SIZE);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, FIBRE_SIZE, FIBRE_SIZE);
  const rng = createRng(0x5eed);
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  for (let i = 0; i < 4200; i++) {
    const x = rng.next() * FIBRE_SIZE;
    const y = rng.next() * FIBRE_SIZE;
    const angle = rng.next() * Math.PI;
    const length = 6 + rng.next() * 26;
    const dx = (Math.cos(angle) * length) / 2;
    const dy = (Math.sin(angle) * length) / 2;
    const v = Math.round(60 + rng.next() * 120);
    ctx.strokeStyle = `rgb(${v},${v},${v})`;
    ctx.lineWidth = 0.8 + rng.next() * 1.2;
    // Drawn on the 9 neighbouring tiles too, so the texture wraps seamlessly.
    for (const ox of [-FIBRE_SIZE, 0, FIBRE_SIZE]) {
      for (const oy of [-FIBRE_SIZE, 0, FIBRE_SIZE]) {
        ctx.beginPath();
        ctx.moveTo(x - dx + ox, y - dy + oy);
        ctx.lineTo(x + dx + ox, y + dy + oy);
        ctx.stroke();
      }
    }
  }
  const data = ctx.getImageData(0, 0, FIBRE_SIZE, FIBRE_SIZE).data;
  const values = new Float32Array(FIBRE_SIZE * FIBRE_SIZE);
  for (let i = 0; i < values.length; i++) values[i] = Math.min(1, data[i * 4] / 255 + 0.25 * rng.next());
  fibreTexture = values;
  return values;
}

/** Cheap integer hash → [0, 1): the dot pattern of an inkjet at 600 dpi. */
function dotNoise(cx: number, cy: number): number {
  let h = Math.imul(cx, 0x27d4eb2d) ^ Math.imul(cy, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

interface InkStyle {
  color: string;
  opacity: number;
  onWhite: boolean;
  printed: number;
  pxPerMm: number;
}

/**
 * Converts a tone mask region into coloured ink (in place). With the printed
 * look, ink creeps along paper fibres (hairy edges) and shows the printer's
 * dot pattern inside. originX/Y: where the region sits on the page, so the
 * paper texture stays put.
 */
function toneToInk(ctx: CanvasRenderingContext2D, box: InkBox, style: InkStyle, originX = 0, originY = 0): void {
  const [r, g, b] = parseHex(style.color);
  const { opacity, onWhite, printed, pxPerMm } = style;
  const fibre = printed > 0 ? fibres() : null;
  // Fibre texel: 0.01 mm, never finer than half a screen pixel.
  const texel = Math.max(0.01, 0.5 / pxPerMm) * pxPerMm;
  const dotCell = 0.042 * pxPerMm;
  for (let top = box.y; top < box.y + box.height; top += BAND_ROWS) {
    const rows = Math.min(BAND_ROWS, box.y + box.height - top);
    const band = ctx.getImageData(box.x, top, box.width, rows);
    const data = band.data;
    for (let row = 0; row < rows; row++) {
      const py = top + row + originY;
      const fy = (((Math.floor(py / texel) % FIBRE_SIZE) + FIBRE_SIZE) % FIBRE_SIZE) * FIBRE_SIZE;
      for (let col = 0; col < box.width; col++) {
        const i = (row * box.width + col) * 4;
        let t = data[i] / 255;
        if (fibre && t > 0.01) {
          const px = box.x + col + originX;
          const f = fibre[fy + (((Math.floor(px / texel) % FIBRE_SIZE) + FIBRE_SIZE) % FIBRE_SIZE)];
          // Threshold lowered along fibres: the edge reaches out along them.
          const th = 0.55 - 0.75 * (f - 0.35);
          const k = Math.max(0, Math.min(1, (t - th + 0.08) / 0.16));
          // Printed black is a little lighter and mottled by the printer's dots.
          let printedTone = k * k * (3 - 2 * k) * Math.max(t, 0.86) * 1.05;
          // Mostly solid, with scattered pale specks where drops did not land.
          const u = dotNoise(Math.floor(px / dotCell), Math.floor(py / dotCell));
          printedTone *= 1 - (u > 0.82 ? 0.15 + (2.5 * (u - 0.82)) : 0.08 * u);
          t = t + (printedTone - t) * printed;
        }
        const a = Math.min(1, t * opacity);
        if (onWhite) {
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
    }
    ctx.putImageData(band, box.x, top);
  }
}

/** The smallest box holding both (either may be missing). */
function unionBox(a: InkBox | null, b: InkBox | null, width: number, height: number): InkBox | null {
  if (!a || !b) return a ?? b;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return clampBox({ x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y }, width, height);
}

function clampBox(box: InkBox, width: number, height: number): InkBox | null {
  const x = Math.max(0, Math.floor(box.x));
  const y = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(width, Math.ceil(box.x + box.width));
  const y1 = Math.min(height, Math.ceil(box.y + box.height));
  return x1 > x && y1 > y ? { x, y, width: x1 - x, height: y1 - y } : null;
}

/** Blurs a region of an opaque tone mask in place. */
function blurRegion(ctx: CanvasRenderingContext2D, box: InkBox, radiusPx: number): void {
  if (radiusPx <= 0.35) return;
  const copy = createCanvas(box.width, box.height);
  copy.getContext("2d")!.drawImage(ctx.canvas, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "#000000";
  ctx.fillRect(box.x, box.y, box.width, box.height);
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.width, box.height);
  ctx.clip();
  ctx.filter = `blur(${radiusPx.toFixed(2)}px)`;
  ctx.drawImage(copy, box.x, box.y);
  ctx.restore();
}

/**
 * Splits marker strokes into layers in which no two strokes touch. Each layer
 * is converted to ink once; layers are stacked translucent, so crossings
 * darken. A page needs only a handful of layers instead of one per stroke.
 */
function markerLayers(strokes: StrokeGeometry[], cellPx: number): StrokeGeometry[][] {
  const layers: { strokes: StrokeGeometry[]; cells: Set<number> }[] = [];
  for (const g of strokes) {
    const reach = Math.ceil((Math.max(...g.widths) / 2 + Math.max(g.startBlob, g.endBlob)) / cellPx) + 1;
    const cells = new Set<number>();
    for (const s of g.samples) {
      const cx = Math.floor(s.x / cellPx);
      const cy = Math.floor(s.y / cellPx);
      for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) cells.add((cy + dy) * 100003 + cx + dx);
    }
    let layer = layers.find((candidate) => ![...cells].some((cell) => candidate.cells.has(cell)));
    if (!layer) {
      layer = { strokes: [], cells: new Set() };
      layers.push(layer);
    }
    layer.strokes.push(g);
    for (const cell of cells) layer.cells.add(cell);
  }
  return layers.map((layer) => layer.strokes);
}

function strokesBox(strokes: StrokeGeometry[], extra: number, width: number, height: number): InkBox | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const g of strokes) {
    const pad = Math.max(...g.widths) + Math.max(g.startBlob, g.endBlob) + extra;
    for (const s of g.samples) {
      x0 = Math.min(x0, s.x - pad);
      y0 = Math.min(y0, s.y - pad);
      x1 = Math.max(x1, s.x + pad);
      y1 = Math.max(y1, s.y + pad);
    }
  }
  return clampBox({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, width, height);
}

/** Highlighter: a wide translucent felt tip whose layers darken where they overlap. */
const HIGHLIGHTER: PenModel = {
  id: "highlighter",
  label: "Subrayador",
  kind: "marker",
  widthMm: 3,
  pressureWidth: 0.05,
  opacity: 0.62,
  buildsUp: true,
  pressureTone: 0.05,
  grain: 0.25,
  grainScale: 1.6,
  edgeRoughness: 0.04,
  taper: 0,
  startBlob: 0.05,
  endBlob: 0.05,
  skipProne: 0,
  smear: 0,
  smudge: 0,
  softnessMm: 0.05,
};

/**
 * A line drawn by hand under, through or over some words: it overshoots a
 * little, is never perfectly straight and lightens where the pen lifts.
 */
function handLine(d: Decoration, pxPerMm: number, span?: { from: number; to: number; seed: number }): { x: number; y: number; p: number }[] {
  const rng = createRng(span?.seed ?? d.seed);
  const xh = d.xhMm;
  const offset = d.kind === "underline" ? 0.32 * xh : d.kind === "strike" ? -0.48 * xh : -0.5 * xh;
  const startX = span?.from ?? d.x0 - (d.kind === "highlight" ? 0.3 : 0.1 + rng.next() * 0.4) * xh;
  const endX = span?.to ?? d.x1 + (d.kind === "highlight" ? 0.3 : rng.next() * 0.5) * xh;
  const length = Math.max(0.5, endX - startX);
  const tilt = Math.tan((rng.next() - 0.5) * 1.4 * DEG);
  const bow = (rng.next() - 0.5) * 0.12 * xh * Math.min(1, length / 40);
  const wobble = noise1D(rng, 6);
  const jitter = (rng.next() - 0.5) * 0.12 * xh;
  const points: { x: number; y: number; p: number }[] = [];
  const steps = Math.max(4, Math.ceil((endX - startX) / 0.8));
  for (let i = 0; i <= steps; i++) {
    const k = i / steps;
    const x = startX + (endX - startX) * k;
    const baseline = d.y0 + ((d.y1 - d.y0) * (x - d.x0)) / Math.max(0.01, d.x1 - d.x0);
    const y = baseline + offset + jitter + tilt * (x - startX) + bow * Math.sin(Math.PI * k) + wobble(x) * 0.04 * xh;
    const p = 0.55 + 0.35 * Math.sin(Math.PI * Math.min(1, k * 1.15));
    points.push({ x: x * pxPerMm, y: y * pxPerMm, p });
  }
  return points;
}

const DEG = Math.PI / 180;

/** Width of the highlighter's band, in x-heights. */
const HIGHLIGHT_TIP = 1.65;

/** How far one sweep of the highlighter goes before the hand is lifted, in millimetres. */
const SWEEP_MM = [30, 70];

/**
 * A highlighted run the way people do it: sweeps of a few centimetres; the
 * hand is lifted and put back a little behind where it stopped, so the
 * restart overlaps (and shows darker) and sits at a slightly different height.
 */
function highlighterSweeps(d: Decoration, pxPerMm: number, wordByWord: boolean, round: boolean): { x: number; y: number; p: number }[][] {
  const rng = createRng(deriveSeed(d.seed, "sweeps"));
  const xh = d.xhMm;
  // Word by word, the tip stops close to each word so the spaces stay clean.
  // A round end reaches half the tip's width further than where it stops.
  const cap = round ? (HIGHLIGHT_TIP / 2) * xh : 0;
  let start: number;
  let end: number;
  if (wordByWord) {
    start = d.x0 + cap - (0.05 + 0.1 * rng.next()) * xh;
    end = d.x1 - cap + (0.05 + 0.1 * rng.next()) * xh;
  } else if (round) {
    start = d.x0 - 0.3 * xh;
    end = d.x1 + 0.3 * xh;
  } else {
    start = d.x0 - (0.5 + 0.4 * rng.next()) * xh;
    end = d.x1 + (0.5 + 0.5 * rng.next()) * xh;
  }
  if (end - start < 0.1 * xh) start = end = (start + end) / 2;
  const sweeps: { x: number; y: number; p: number }[][] = [];
  let from = start;
  for (let n = 0; n < 50; n++) {
    let to = from + SWEEP_MM[0] + (SWEEP_MM[1] - SWEEP_MM[0]) * rng.next();
    // No tiny last sweep: stretch this one to the end instead.
    if (end - to < 12) to = end;
    sweeps.push(handLine(d, pxPerMm, { from, to: Math.min(to, end), seed: deriveSeed(d.seed, "sweep", n) }));
    if (to >= end) break;
    from = to - (0.8 + 2.4 * rng.next());
  }
  return sweeps;
}

/** Translucent marker strokes on a layer of their own (layers stacked so overlaps darken). */
function renderMarkerStrokes(
  target: CanvasRenderingContext2D,
  strokes: StrokeGeometry[],
  options: RenderOptions,
  style: InkStyle,
  soft: number,
): void {
  const { canvas } = target;
  const layerCanvas = createCanvas(canvas.width, canvas.height);
  const lctx = layerCanvas.getContext("2d")!;
  lctx.lineCap = "round";
  lctx.lineJoin = "round";
  for (const layer of markerLayers(strokes, Math.max(2, options.pxPerMm))) {
    const lb = strokesBox(layer, 3 + soft * 3, canvas.width, canvas.height);
    if (!lb) continue;
    lctx.globalCompositeOperation = "source-over";
    lctx.fillStyle = "#000000";
    lctx.fillRect(lb.x, lb.y, lb.width, lb.height);
    lctx.save();
    lctx.beginPath();
    lctx.rect(lb.x, lb.y, lb.width, lb.height);
    lctx.clip();
    lctx.globalCompositeOperation = "lighten";
    for (const g of layer) drawTone(lctx, g, 0, 0);
    drawStreaks(lctx, layer, options.pen.streaks ?? 0, 0, 0);
    lctx.globalCompositeOperation = "lighten";
    applyGrain(lctx, options, 0, 0, canvas.width, canvas.height);
    lctx.restore();
    blurRegion(lctx, lb, soft);
    toneToInk(lctx, lb, style);
    target.globalCompositeOperation = "source-over";
    target.drawImage(layerCanvas, lb.x, lb.y, lb.width, lb.height, lb.x, lb.y, lb.width, lb.height);
  }
  layerCanvas.width = 0;
}

/** Ruled lines, grid or dots, and the red margin, drawn behind everything. */
function drawPaper(ctx: CanvasRenderingContext2D, paper: PaperSettings, page: PageSettings, pxPerMm: number): void {
  const ruling = paperRuling(paper);
  const w = page.widthMm * pxPerMm;
  const h = page.heightMm * pxPerMm;
  ctx.save();
  ctx.globalCompositeOperation = "destination-over";
  if (paper.marginLine) {
    ctx.strokeStyle = "rgba(214, 86, 86, 0.75)";
    ctx.lineWidth = Math.max(0.6, 0.2 * pxPerMm);
    const x = Math.max(4, page.marginLeftMm - 4) * pxPerMm;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  if (ruling) {
    const step = ruling * pxPerMm;
    const first = paperFirstLine(paper) * pxPerMm;
    if (paper.kind === "dots") {
      ctx.fillStyle = "rgba(120, 128, 145, 0.55)";
      const r = Math.max(0.5, 0.18 * pxPerMm);
      for (let y = first; y < h; y += step) for (let x = 0; x < w; x += step) ctx.fillRect(x - r / 2, y - r / 2, r, r);
    } else {
      const grid = paper.kind !== "lined";
      ctx.strokeStyle = grid ? "rgba(120, 150, 200, 0.45)" : "rgba(95, 130, 190, 0.55)";
      ctx.lineWidth = Math.max(0.5, (grid ? 0.1 : 0.15) * pxPerMm);
      ctx.beginPath();
      const bottom = paper.kind === "lined" ? h - 10 * pxPerMm : h;
      for (let y = first; y <= bottom; y += step) {
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
      }
      if (grid) {
        for (let x = 0; x <= w; x += step) {
          ctx.moveTo(x, 0);
          ctx.lineTo(x, h);
        }
      }
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Renders one page and returns the box that holds its ink (null if empty). */
export function renderPage(
  canvas: HTMLCanvasElement,
  layout: LayoutResult,
  hand: Hand,
  page: PageSettings,
  options: RenderOptions,
): InkBox | null {
  const { pxPerMm, pen, naturalness: nat } = options;
  canvas.width = Math.round(page.widthMm * pxPerMm);
  canvas.height = Math.round(page.heightMm * pxPerMm);
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = "none";
  ctx.globalAlpha = 1;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const widthScale = options.widthScale ?? 1;
  const runStyles = options.runStyles ?? [];

  /** Instrument and colour of a run style (0 = the document's). */
  interface InkGroup {
    pen: PenModel;
    color: string;
    strokes: StrokeGeometry[];
  }
  const groups = new Map<string, InkGroup>();
  const groupFor = (style: number): InkGroup => {
    const run = style > 0 ? runStyles[style - 1] : undefined;
    const groupPen = wornPen(run?.penId ? penById(run.penId) : pen, options.wear ?? 0);
    const color = groupPen.kind === "pencil" ? PENCIL_COLOR : (run?.color ?? options.color);
    const key = `${groupPen.id}|${color}`;
    let group = groups.get(key);
    if (!group) {
      group = { pen: groupPen, color, strokes: [] };
      groups.set(key, group);
    }
    return group;
  };

  // Geometry of every stroke on this page: letters (bold ones twice) and hand-drawn lines.
  const highlights: { geometry: StrokeGeometry; color: number; smear: number; seed: number }[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let strokeCount = 0;
  const include = (group: InkGroup, g: StrokeGeometry, seed: number) => {
    g.seed = seed;
    const pad = Math.max(...g.widths) + Math.max(g.startBlob, g.endBlob) + softPx({ ...options, pen: group.pen }) * 3 + 2;
    for (const sample of g.samples) {
      minX = Math.min(minX, sample.x - pad);
      minY = Math.min(minY, sample.y - pad);
      maxX = Math.max(maxX, sample.x + pad);
      maxY = Math.max(maxY, sample.y + pad);
    }
    group.strokes.push(g);
    strokeCount++;
  };
  for (const glyph of layout.glyphs) {
    if (glyph.page !== options.pageIndex) continue;
    const variant = hand.glyphs[glyph.char]?.[glyph.variantIndex];
    if (!variant) continue;
    const group = groupFor(glyph.style ?? 0);
    // Bold: the writer goes over the letter again, a hair off the first pass.
    const passes = glyph.bold ? 2 : 1;
    const boldRng = createRng(deriveSeed(glyph.seed, "bold"));
    const angle = boldRng.next() * Math.PI * 2;
    const shift = group.pen.widthMm * widthScale * (0.45 + 0.2 * boldRng.next()) * pxPerMm;
    for (let pass = 0; pass < passes; pass++) {
      const dx = pass === 0 ? 0 : Math.cos(angle) * shift;
      const dy = pass === 0 ? 0 : Math.sin(angle) * shift;
      variant.strokes.forEach((stroke, strokeIndex) => {
        if (stroke.length === 0) return;
        const rng = createRng(deriveSeed(glyph.seed, "stroke", strokeIndex, pass));
        const points = stroke.map((point) => {
          const mapped = glyphPointToPage(glyph, page.xHeightMm, point.x, point.y);
          return { x: mapped.x * pxPerMm + dx, y: mapped.y * pxPerMm + dy, p: point.p };
        });
        include(group, strokeGeometry(points, rng, group.pen, nat, pxPerMm, page.xHeightMm, widthScale * (glyph.bold ? 1.12 : 1)), deriveSeed(glyph.seed, "stroke", strokeIndex, pass));
      });
    }
  }
  for (const d of layout.decorations) {
    if (d.page !== options.pageIndex) continue;
    const rng = createRng(deriveSeed(d.seed, "ink"));
    if (d.kind === "scribble") {
      const group = groupFor(d.style ?? 0);
      const look = scribbleStyleOf(d.style > 0 ? runStyles[d.style - 1] : undefined);
      // People press harder when they blot something out.
      const width = widthScale * 1.1 * look.width;
      for (const stroke of scribbleStrokes(d, look)) {
        const points = stroke.map((point) => ({ x: point.x * pxPerMm, y: point.y * pxPerMm, p: point.p }));
        if (points.length > 1) include(group, strokeGeometry(points, rng, group.pen, nat, pxPerMm, d.xhMm, width), d.seed);
      }
      continue;
    }
    if (d.kind === "highlight") {
      const tip = { ...HIGHLIGHTER, widthMm: HIGHLIGHT_TIP * d.xhMm };
      // How much ink it drags depends on the instrument underneath.
      const smear = (nat.highlighterSmear ?? 0) * groupFor(d.style ?? 0).pen.smear;
      const look = d.style > 0 ? runStyles[d.style - 1] : undefined;
      const round = Boolean(look?.highlightRound);
      highlighterSweeps(d, pxPerMm, Boolean(look?.highlightWords), round).forEach((sweep, n) => {
        const geometry = strokeGeometry(sweep, rng, tip, nat, pxPerMm, d.xhMm, 1);
        const sweepRng = createRng(deriveSeed(d.seed, "chisel", n));
        if (!round) {
          // The chisel is held at a slant; its ends are drawn rough by drawChisel.
          const lean = (4 + 18 * sweepRng.next()) * DEG;
          geometry.chisel = { x: Math.sin(lean), y: -Math.cos(lean), seed: deriveSeed(d.seed, "ends", n), poolStart: 0, poolEnd: 0 };
        }
        highlights.push({ geometry, color: d.color, smear, seed: deriveSeed(d.seed, "smear", n) });
        // Where the tip rests a moment, more ink soaks in: darker there, more often at the end.
        const length = geometry.samples[geometry.samples.length - 1]?.s ?? 0;
        const pool = (1 + 2 * sweepRng.next()) * pxPerMm;
        const poolEnd = length > 3 * pool && sweepRng.next() < 0.6 ? pool : 0;
        const poolStart = length > 3 * pool && sweepRng.next() < 0.2 ? pool * 0.6 : 0;
        if (geometry.chisel) {
          geometry.chisel.poolEnd = poolEnd;
          geometry.chisel.poolStart = poolStart;
        } else {
          // As light as the chisel's band (which is drawn at 80 % of its tone).
          geometry.tones = geometry.tones.map((tone) => tone * 0.82);
          // Round ends: a darker layer over that stretch.
          const end = poolEnd > 0 ? sliceGeometry(geometry, length - poolEnd, length) : null;
          if (end) highlights.push({ geometry: end, color: d.color, smear: 0, seed: 0 });
          const start = poolStart > 0 ? sliceGeometry(geometry, 0, poolStart) : null;
          if (start) highlights.push({ geometry: start, color: d.color, smear: 0, seed: 0 });
        }
      });
    } else {
      const group = groupFor(d.style ?? 0);
      include(group, strokeGeometry(handLine(d, pxPerMm), rng, group.pen, nat, pxPerMm, d.xhMm, widthScale), d.seed);
    }
  }

  const box = strokeCount > 0 ? clampBox({ x: minX, y: minY, width: maxX - minX, height: maxY - minY }, canvas.width, canvas.height) : null;

  /** One instrument and colour: its ink, transparent around it, drawn into `target`; returns the box it used. */
  const drawGroup = (target: CanvasRenderingContext2D, group: InkGroup): InkBox | null => {
    const groupOptions = { ...options, pen: group.pen };
    const style: InkStyle = {
      color: group.color,
      opacity: Math.max(0, Math.min(1, group.pen.opacity * (options.inkStrength ?? 1))),
      onWhite: false,
      printed: printedStrength(options),
      pxPerMm,
    };
    const soft = softPx(groupOptions);
    if (group.pen.buildsUp) {
      // Markers: strokes that touch go to different layers, stacked translucent.
      renderMarkerStrokes(target, group.strokes, groupOptions, style, soft);
      return strokesBox(group.strokes, 3 + soft * 3, canvas.width, canvas.height);
    }
    const gb = strokesBox(group.strokes, soft * 3 + 2, canvas.width, canvas.height);
    if (!gb) return null;
    // Tone mask inside the ink box: black = no ink, white = full ink.
    target.fillStyle = "#000000";
    target.fillRect(gb.x, gb.y, gb.width, gb.height);
    target.save();
    target.beginPath();
    target.rect(gb.x, gb.y, gb.width, gb.height);
    target.clip();
    target.globalCompositeOperation = "lighten";
    for (const g of group.strokes) drawTone(target, g, 0, 0);
    drawStreaks(target, group.strokes, group.pen.streaks ?? 0, 0, 0);
    target.globalCompositeOperation = "lighten";
    // Paper grain: the same paper under every stroke.
    applyGrain(target, groupOptions, 0, 0, canvas.width, canvas.height);
    target.restore();
    // Soft edges (pencil, felt tips, printer ink spread), still on the opaque mask.
    blurRegion(target, gb, soft);
    target.globalCompositeOperation = "source-over";
    toneToInk(target, gb, style);
    return gb;
  };

  // 1. The ink. One instrument draws straight on the page; several each get a layer.
  const inkGroups = [...groups.values()].filter((group) => group.strokes.length > 0);
  if (inkGroups.length === 1) {
    drawGroup(ctx, inkGroups[0]);
  } else if (inkGroups.length > 1) {
    const layer = createCanvas(canvas.width, canvas.height);
    const lctx = layer.getContext("2d")!;
    lctx.lineCap = "round";
    lctx.lineJoin = "round";
    for (const group of inkGroups) {
      lctx.globalCompositeOperation = "source-over";
      const used = drawGroup(lctx, group);
      if (!used) continue;
      ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(layer, used.x, used.y, used.width, used.height, used.x, used.y, used.width, used.height);
      lctx.clearRect(used.x, used.y, used.width, used.height);
    }
    layer.width = 0;
  }
  const style: InkStyle = {
    color: options.color,
    opacity: Math.max(0, Math.min(1, pen.opacity * (options.inkStrength ?? 1))),
    onWhite: false,
    printed: printedStrength(options),
    pxPerMm,
  };

  // 1b. A water-based highlighter drags a little fresh ink along: a faint
  // trail after each letter, inside the band, in the direction it was drawn.
  if (box) {
    const STEPS = 8;
    for (const item of highlights) {
      if (item.smear < 0.01) continue;
      const hb = strokesBox([item.geometry], 2, canvas.width, canvas.height);
      if (!hb) continue;
      const reach = (0.3 + 0.8 * item.smear) * pxPerMm;
      const strength = Math.min(0.7, 0.5 * item.smear);
      const trail = createCanvas(hb.width, hb.height);
      const tctx = trail.getContext("2d")!;
      tctx.filter = `blur(${Math.max(0.3, 0.1 * pxPerMm).toFixed(2)}px)`;
      for (let i = 1; i <= STEPS; i++) {
        tctx.globalAlpha = ((2 * strength) / STEPS) * (1 - (i - 1) / STEPS);
        tctx.drawImage(canvas, hb.x - (reach * i) / STEPS, hb.y, hb.width, hb.height, 0, 0, hb.width, hb.height);
      }
      tctx.filter = "none";
      tctx.globalAlpha = 1;
      // Only where the highlighter went, and more in some places than others
      // (the tip loads up, then runs clean again).
      const band = createCanvas(hb.width, hb.height);
      const bctx = band.getContext("2d")!;
      bctx.lineCap = "round";
      bctx.lineJoin = "round";
      drawTone(bctx, item.geometry, hb.x, hb.y);
      const rng = createRng(deriveSeed(item.seed, "smear"));
      const patches = bctx.createLinearGradient(0, 0, hb.width, 0);
      const stops = Math.max(2, Math.ceil(hb.width / (3 * pxPerMm)));
      for (let s = 0; s <= stops; s++) patches.addColorStop(s / stops, `rgba(0,0,0,${(0.25 + 0.75 * rng.next()).toFixed(3)})`);
      bctx.globalCompositeOperation = "destination-in";
      bctx.fillStyle = patches;
      bctx.fillRect(0, 0, hb.width, hb.height);
      tctx.globalCompositeOperation = "destination-in";
      tctx.drawImage(band, 0, 0);
      band.width = 0;
      ctx.save();
      ctx.globalCompositeOperation = "destination-over";
      ctx.drawImage(trail, hb.x, hb.y);
      ctx.restore();
      trail.width = 0;
    }
  }

  // 1c. Smudges: now and then the writing hand rubs fresh ink or graphite. A
  // left hand runs over what it has just written and drags it to the right;
  // a right hand only catches the line above, down and to the right.
  // The slider's 100 % is a clearly visible amount; past it, bigger and darker.
  const smudgeAmount = (nat.handSmudges ?? 0) * 3;
  const smudging = smudgeAmount * (options.leftHanded ? 3 : 1);
  const smudgeExtra = Math.max(0, smudgeAmount - 3);
  /** What smudges add outside the ink, so the printed page keeps it. */
  let marksBox: InkBox | null = null;
  if (box && smudging > 0.005) {
    const STEPS = 6;
    const left = Boolean(options.leftHanded);
    for (const glyph of layout.glyphs) {
      if (glyph.page !== options.pageIndex) continue;
      const pen = groupFor(glyph.style ?? 0).pen;
      const rng = createRng(deriveSeed(glyph.seed, "smudge"));
      if (rng.next() > Math.min(0.6, smudging * pen.smudge * (left ? 0.027 : 0.025))) continue;
      const grow = 1 + 0.15 * smudgeExtra;
      const xh = page.xHeightMm * glyph.scale;
      const cx = (glyph.xMm + glyph.widthMm * (0.2 + 0.6 * rng.next())) * pxPerMm;
      const cy = (glyph.yMm - xh * (left ? 0.2 + 0.4 * rng.next() : 0.5 + 0.5 * rng.next())) * pxPerMm;
      const rx = xh * (left ? 0.8 + 1.0 * rng.next() : 0.7 + 0.8 * rng.next()) * pxPerMm * grow;
      const ry = xh * (0.45 + 0.35 * rng.next()) * pxPerMm;
      const angle = left ? (rng.next() - 0.5) * 0.3 : Math.PI * (0.25 + 0.2 * rng.next());
      const reach = xh * (left ? 0.6 + 1.0 * rng.next() : 0.4 + 0.7 * rng.next()) * pxPerMm * grow;
      const strength = Math.min(0.95, (0.3 + 0.3 * rng.next()) * Math.min(1, pen.smudge) * (1 + 0.12 * smudgeExtra));
      const dx = Math.cos(angle) * reach;
      const dy = Math.sin(angle) * reach;
      const sb = clampBox({ x: cx - rx - reach, y: cy - rx - reach, width: 2 * (rx + reach), height: 2 * (rx + reach) }, canvas.width, canvas.height);
      if (!sb) continue;
      marksBox = unionBox(marksBox, sb, canvas.width, canvas.height);
      const patch = createCanvas(sb.width, sb.height);
      const pctx = patch.getContext("2d")!;
      pctx.filter = `blur(${Math.max(0.4, 0.15 * pxPerMm).toFixed(2)}px)`;
      for (let i = 1; i <= STEPS; i++) {
        pctx.globalAlpha = ((2 * strength) / STEPS) * (1 - (i - 1) / STEPS);
        pctx.drawImage(canvas, sb.x - (dx * i) / STEPS, sb.y - (dy * i) / STEPS, sb.width, sb.height, 0, 0, sb.width, sb.height);
      }
      pctx.filter = "none";
      pctx.globalAlpha = 1;
      // A soft, oval patch where the skin touched.
      pctx.globalCompositeOperation = "destination-in";
      pctx.save();
      pctx.translate(cx - sb.x + dx / 2, cy - sb.y + dy / 2);
      pctx.rotate(angle);
      pctx.scale(1, ry / rx);
      const fade = pctx.createRadialGradient(0, 0, 0, 0, 0, rx + reach / 2);
      fade.addColorStop(0, "rgba(0,0,0,1)");
      fade.addColorStop(0.55, "rgba(0,0,0,0.65)");
      fade.addColorStop(1, "rgba(0,0,0,0)");
      pctx.fillStyle = fade;
      const far = (rx + reach) * 4;
      pctx.fillRect(-far, -far, 2 * far, 2 * far);
      // The skin leaves streaks along the way it moved.
      pctx.globalCompositeOperation = "destination-out";
      pctx.lineCap = "round";
      const streaks = 6 + Math.floor(rng.next() * 8);
      for (let s = 0; s < streaks; s++) {
        const offset = (rng.next() * 2 - 1) * rx;
        pctx.globalAlpha = 0.3 + 0.5 * rng.next();
        pctx.lineWidth = (0.04 + 0.12 * rng.next()) * pxPerMm;
        pctx.beginPath();
        pctx.moveTo(-far, offset);
        pctx.lineTo(far, offset + (rng.next() - 0.5) * 0.2 * rx);
        pctx.stroke();
      }
      pctx.restore();
      ctx.save();
      ctx.globalCompositeOperation = "destination-over";
      ctx.drawImage(patch, sb.x, sb.y);
      ctx.restore();
      patch.width = 0;
    }
  }

  // 2. Highlighter behind the ink (dark ink shows through it, as on paper).
  let fullBox = unionBox(box, marksBox, canvas.width, canvas.height);
  if (highlights.length > 0) {
    const layer = createCanvas(canvas.width, canvas.height);
    const lctx = layer.getContext("2d")!;
    const byColor = new Map<number, StrokeGeometry[]>();
    for (const item of highlights) byColor.set(item.color, [...(byColor.get(item.color) ?? []), item.geometry]);
    for (const [color, geometries] of byColor) {
      const highlightStyle: InkStyle = { ...style, color: HIGHLIGHT_COLORS[color]?.value ?? HIGHLIGHT_COLORS[0].value, opacity: HIGHLIGHTER.opacity };
      renderMarkerStrokes(lctx, geometries, { ...options, pen: HIGHLIGHTER }, highlightStyle, HIGHLIGHTER.softnessMm * pxPerMm);
      const hb = strokesBox(geometries, 3, canvas.width, canvas.height);
      fullBox = unionBox(fullBox, hb, canvas.width, canvas.height);
    }
    ctx.save();
    ctx.globalCompositeOperation = "destination-over";
    ctx.drawImage(layer, 0, 0);
    ctx.restore();
    layer.width = 0;
  }

  // 3. Paper lines, then the paper itself (on screen and in the PDF).
  if (options.paper && options.drawPaper && (options.paper.kind !== "blank" || options.paper.marginLine)) {
    drawPaper(ctx, options.paper, page, pxPerMm);
    // The lines cover the whole sheet: nothing to crop.
    fullBox = { x: 0, y: 0, width: canvas.width, height: canvas.height };
  }
  if (options.background === "white") {
    ctx.save();
    ctx.globalCompositeOperation = "destination-over";
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }
  ctx.globalCompositeOperation = "source-over";
  return fullBox;
}
