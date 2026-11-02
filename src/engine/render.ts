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
import { variantsOf, type Hand } from "./hand";
import { glyphPointToPage, TAPE_WIDTH_MM, tapeSpan, type Decoration, type LayoutResult, type PlacedGlyph } from "./layout";
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
  /** Hand smudges also land on lines drawn by hand (underlines, strikethroughs, scribbles); default yes. */
  smudgeMarks?: boolean;
  /** The highlighter also drags the ink of lines drawn by hand; default yes. */
  smearMarks?: boolean;
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
  /** Lumps of ink left along the line (centre, radii along and across, direction), in pixels. */
  lumps?: { x: number; y: number; along: number; across: number; angle: number }[];
}

/** How far ink can reach past the line's half width: pooled ends and lumps. */
function blobReach(g: StrokeGeometry): number {
  let reach = Math.max(g.startBlob, g.endBlob);
  for (const lump of g.lumps ?? []) reach = Math.max(reach, lump.along);
  return reach;
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
  const geometry: StrokeGeometry = {
    samples,
    widths,
    tones,
    startBlob: pen.startBlob > 0 ? (widths[0] / 2) * (1 + pen.startBlob * (0.5 + rng.next())) : 0,
    endBlob: pen.endBlob > 0 ? (widths[widths.length - 1] / 2) * (1 + pen.endBlob * (0.3 + rng.next())) : 0,
  };
  // Lumps of ink: the ball picks up a little too much and leaves it on the
  // paper, mostly where the stroke starts. Drawn last from the stroke's own
  // random numbers, so the rest of the stroke does not change with the slider.
  const lumpRate = (nat.inkBlobs ?? 0) * pen.blobProne * LUMPS_PER_MM;
  if (lumpRate > 0 && samples.length > 2) {
    const count = Math.floor(lumpRate * (length / pxPerMm) + rng.next());
    for (let n = 0; n < count; n++) {
      const s = rng.next() < 0.35 ? rng.next() * Math.min(0.2 * length, 0.6 * pxPerMm) : rng.next() * length;
      const i = Math.max(1, Math.min(samples.length - 1, samples.findIndex((sample) => sample.s >= s)));
      const a = samples[i - 1];
      const b = samples[i];
      const half = widths[i] / 2;
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const side = (rng.next() - 0.5) * 0.5 * half;
      (geometry.lumps ??= []).push({
        x: b.x - Math.sin(angle) * side,
        y: b.y + Math.cos(angle) * side,
        along: half * (1.7 + 1.5 * rng.next()),
        across: half * (1.25 + 0.6 * rng.next()),
        angle,
      });
    }
  }
  return geometry;
}

/** Lumps of ink per millimetre of line at "Grumos de tinta" 100 % with a ballpoint. */
const LUMPS_PER_MM = 0.03;

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
  // Lumps: full ink, a little oval along the line, with a short drag behind.
  for (const lump of g.lumps ?? []) {
    ctx.fillStyle = toneStyle(1);
    ctx.beginPath();
    ctx.ellipse(lump.x - dx, lump.y - dy, lump.along, lump.across, lump.angle, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(lump.x - dx - Math.cos(lump.angle) * lump.along, lump.y - dy - Math.sin(lump.angle) * lump.along, lump.along * 0.7, lump.across * 0.75, lump.angle, 0, Math.PI * 2);
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
    const reach = Math.ceil((Math.max(...g.widths) / 2 + blobReach(g)) / cellPx) + 1;
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
    const pad = Math.max(...g.widths) + blobReach(g) + extra;
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
  blobProne: 0,
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
function handLine(d: Decoration, pxPerMm: number, span?: { from: number; to: number; seed: number; shift?: number }): { x: number; y: number; p: number }[] {
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
    const y = baseline + offset + (span?.shift ?? 0) + jitter + tilt * (x - startX) + bow * Math.sin(Math.PI * k) + wobble(x) * 0.04 * xh;
    const p = 0.55 + 0.35 * Math.sin(Math.PI * Math.min(1, k * 1.15));
    points.push({ x: x * pxPerMm, y: y * pxPerMm, p });
  }
  return points;
}

const DEG = Math.PI / 180;

/**
 * Width of the highlighter's band, in millimetres: always the same, whatever
 * the letter size; big letters take more than one pass, as with correction tape.
 */
const HIGHLIGHT_TIP_MM = 4.6;
/** How much of the letters' height the highlighter has to cover, in x-heights (centred half an x-height up). */
const HIGHLIGHT_COVER = 1.65;

/** Up and down offsets of each pass of the highlighter over a run of letters, in millimetres. */
export function highlightPasses(d: Decoration): number[] {
  const need = HIGHLIGHT_COVER * d.xhMm;
  if (need <= HIGHLIGHT_TIP_MM * 1.08) return [0];
  const OVERLAP = 0.9;
  const count = Math.min(6, Math.ceil((need - HIGHLIGHT_TIP_MM) / (HIGHLIGHT_TIP_MM - OVERLAP)) + 1);
  const rng = createRng(deriveSeed(d.seed, "passes"));
  const shifts = Array.from({ length: count }, (_, k) => -need / 2 + HIGHLIGHT_TIP_MM / 2 + ((need - HIGHLIGHT_TIP_MM) * k) / (count - 1) + (rng.next() - 0.5) * 0.3);
  // Top to bottom or the other way round.
  return rng.next() < 0.5 ? shifts : shifts.reverse();
}

/** What is left of letters rubbed out with an eraser: faint, soft, broken. */
function rubbedOut(pen: PenModel): PenModel {
  const graphite = pen.kind === "pencil";
  return {
    ...pen,
    id: `${pen.id}-erased`,
    opacity: pen.opacity * (graphite ? 0.3 : 0.42),
    softnessMm: pen.softnessMm + 0.05,
    grain: Math.min(1, pen.grain + 0.45),
    edgeRoughness: pen.edgeRoughness + 0.3,
    dryness: Math.max(pen.dryness ?? 0, 0.35),
    buildsUp: false,
  };
}

/** How a piece of correction tape ends: cut clean, torn on the dispenser's teeth, or with a strip of tape left over. */
type TapeEnd = "straight" | "teeth" | "tongue";

function pickTapeEnd(rng: Rng, last: boolean): TapeEnd {
  const r = rng.next();
  if (last) return r < 0.3 ? "straight" : r < 0.7 ? "teeth" : "tongue";
  return r < 0.55 ? "straight" : r < 0.8 ? "teeth" : "tongue";
}

/**
 * The outline of one end of the tape, across it from one edge (v = -w/2) to
 * the other (v = w/2), as distances out past the nominal end, in millimetres.
 */
function tapeEndProfile(kind: TapeEnd, rng: Rng, width: number): { out: number; v: number }[] {
  const half = width / 2;
  const points: { out: number; v: number }[] = [];
  if (kind === "teeth") {
    // The serrated blade of the dispenser: small, uneven teeth, the cut a little crooked.
    const tilt = (rng.next() - 0.5) * 2 * Math.tan(6 * DEG);
    const pitch = 0.5 + 0.35 * rng.next();
    const count = Math.max(4, Math.round(width / pitch)) * 2;
    const depth = 0.22 + 0.28 * rng.next();
    for (let i = 0; i <= count; i++) {
      const v = -half + (width * i) / count;
      const tooth = i % 2 === 1 ? depth * (0.6 + 0.7 * rng.next()) : 0;
      points.push({ out: tilt * v + tooth, v });
    }
    return points;
  }
  const tilt = (rng.next() - 0.5) * 2 * Math.tan((kind === "tongue" ? 5 : 9) * DEG);
  const wobble = () => (rng.next() - 0.5) * 0.06;
  if (kind === "straight") {
    for (let i = 0; i <= 4; i++) {
      const v = -half + (width * i) / 4;
      points.push({ out: tilt * v + (i > 0 && i < 4 ? wobble() : 0), v });
    }
    return points;
  }
  // A strip that did not tear off: narrower than the tape, often along one edge,
  // a little crooked, ending in a ragged tear.
  const tongueWidth = (0.3 + 0.45 * rng.next()) * width;
  const place = rng.next();
  const a = place < 0.35 ? -half : place < 0.7 ? half - tongueWidth : -half + (width - tongueWidth) * rng.next();
  const b = a + tongueWidth;
  const length = 0.7 + 2.3 * rng.next();
  const lean = (rng.next() - 0.5) * 2 * Math.tan(8 * DEG) * length;
  const narrow = (0.1 + 0.25 * rng.next()) * tongueWidth;
  const base = (v: number) => tilt * v;
  points.push({ out: base(-half), v: -half });
  if (a > -half + 0.05) points.push({ out: base(a), v: a });
  points.push({ out: base(a) + length * 0.97, v: a + narrow * 0.5 + lean });
  const tears = 2 + Math.floor(rng.next() * 3);
  for (let i = 1; i < tears; i++) {
    const v = a + narrow * 0.5 + ((b - a - narrow) * i) / tears + lean;
    points.push({ out: base(a) + length * (0.85 + 0.2 * rng.next()), v });
  }
  points.push({ out: base(b) + length * (0.9 + 0.1 * rng.next()), v: b - narrow * 0.5 + lean });
  if (b < half - 0.05) points.push({ out: base(b), v: b });
  points.push({ out: base(half), v: half });
  return points;
}

/**
 * Correction tape over a run of words. The tape is always the same width,
 * laid very straight (a long piece bends a little), so big letters need
 * several overlapping passes. Each pass is an outline in page pixels; the
 * last one in the list was laid last.
 */
function tapePasses(d: Decoration, pxPerMm: number): { passes: Path2D[]; box: InkBox } | null {
  const rng = createRng(deriveSeed(d.seed, "tape"));
  const xh = d.xhMm;
  const width = TAPE_WIDTH_MM;
  const slope = (d.y1 - d.y0) / Math.max(0.01, d.x1 - d.x0);
  const baseAt = (x: number) => d.y0 + slope * (x - d.x0);
  const span = tapeSpan(d);
  // What has to be covered: the letters' bodies and most of the tall strokes.
  const top = -1.5 * xh;
  const bottom = 0.3 * xh;
  const needed = bottom - top;
  const OVERLAP = 0.9;
  const count = needed <= width ? 1 : Math.min(6, Math.ceil((needed - width) / (width - OVERLAP)) + 1);
  const centres: number[] = [];
  if (count === 1) centres.push(-0.6 * xh + (rng.next() - 0.5) * 0.5);
  else for (let k = 0; k < count; k++) centres.push(top + width / 2 - 0.3 + ((needed - width + 0.6) * k) / (count - 1) + (rng.next() - 0.5) * 0.3);
  // Top to bottom or the other way round.
  if (rng.next() < 0.5) centres.reverse();
  const passes: Path2D[] = [];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let k = 0; k < count; k++) {
    const from = span.from + (k === 0 ? 0 : (rng.next() - 0.5) * 0.6);
    const to = span.to + (k === 0 ? 0 : (rng.next() - 0.5) * 0.8);
    const length = Math.max(1, to - from);
    const angle = Math.atan(slope) + (rng.next() - 0.5) * 0.9 * DEG;
    const dir = { x: Math.cos(angle), y: Math.sin(angle) };
    const normal = { x: -dir.y, y: dir.x };
    const origin = { x: from, y: baseAt(from) + centres[k] };
    // Only a long piece bends, and only a little.
    const bowAmount = length > 45 ? (rng.next() - 0.5) * 2 * Math.min(1.1, (length - 45) / 60) : 0;
    const bow = (u: number) => bowAmount * Math.sin((Math.PI * Math.max(0, Math.min(length, u))) / length);
    const startEnd = tapeEndProfile(pickTapeEnd(rng, false), rng, width);
    const lastEnd = tapeEndProfile(pickTapeEnd(rng, true), rng, width);
    const local: { u: number; v: number }[] = [];
    for (let i = startEnd.length - 1; i >= 0; i--) local.push({ u: -startEnd[i].out, v: startEnd[i].v });
    const STEP = 2;
    for (let u = STEP; u < length; u += STEP) local.push({ u, v: -width / 2 });
    for (const p of lastEnd) local.push({ u: length + p.out, v: p.v });
    for (let u = Math.floor((length - 0.01) / STEP) * STEP; u > 0; u -= STEP) local.push({ u, v: width / 2 });
    const path = new Path2D();
    local.forEach((p, i) => {
      const v = p.v + bow(p.u);
      const x = (origin.x + dir.x * p.u + normal.x * v) * pxPerMm;
      const y = (origin.y + dir.y * p.u + normal.y * v) * pxPerMm;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
      if (i === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    });
    path.closePath();
    passes.push(path);
  }
  const pad = pxPerMm;
  return { passes, box: { x: Math.floor(x0 - pad), y: Math.floor(y0 - pad), width: Math.ceil(x1 - x0 + 2 * pad), height: Math.ceil(y1 - y0 + 2 * pad) } };
}

/**
 * Ink written on correction tape does not soak in: it beads on the plastic
 * surface and dries thin, greyer and shinier, darker at the edges of the
 * stroke than in the middle ("prebas de boli y lapiz.jpg"). Changes the ink
 * already on the page inside the tape; ink outside it stays as it is.
 */
function inkOnTape(ctx: CanvasRenderingContext2D, passes: Path2D[], area: InkBox, strokePx: number, pxPerMm: number, strength: number): void {
  const box = clampBox(area, ctx.canvas.width, ctx.canvas.height);
  if (!box || strength <= 0) return;
  const mask = createCanvas(box.width, box.height);
  const m = mask.getContext("2d")!;
  m.translate(-box.x, -box.y);
  m.fillStyle = "#ffffff";
  for (const path of passes) m.fill(path);
  const maskData = m.getImageData(0, 0, box.width, box.height).data;
  const blurred = createCanvas(box.width, box.height);
  const b = blurred.getContext("2d")!;
  b.filter = `blur(${Math.max(0.5, Math.min(0.25 * pxPerMm, strokePx * 0.33)).toFixed(2)}px)`;
  b.drawImage(ctx.canvas, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
  const blurData = b.getImageData(0, 0, box.width, box.height).data;
  const image = ctx.getImageData(box.x, box.y, box.width, box.height);
  const data = image.data;
  const SILVER = [112, 119, 132];
  const cell = Math.max(1, 0.05 * pxPerMm);
  for (let row = 0; row < box.height; row++) {
    for (let col = 0; col < box.width; col++) {
      const i = (row * box.width + col) * 4;
      const a = data[i + 3];
      const k = maskData[i + 3] / 255;
      if (a === 0 || k === 0) continue;
      // Middle of the stroke: the blurred ink is as strong as the ink itself.
      const ratio = blurData[i + 3] / a;
      const s = Math.max(0, Math.min(1, (ratio - 0.62) / 0.3));
      const middle = s * s * (3 - 2 * s);
      // The edges stay dark; the middle is thin, silvery and uneven where the ink beads.
      const bead = dotNoise(Math.floor((box.x + col) / cell), Math.floor((box.y + row) / cell));
      const keep = Math.max(0.04, 1 - 0.58 * strength * middle * (0.8 + 0.4 * bead));
      data[i + 3] = Math.round(a * (1 - k + k * keep));
      const grey = k * Math.min(1, strength * (0.12 + 0.6 * middle));
      data[i] = Math.round(data[i] + (SILVER[0] - data[i]) * grey);
      data[i + 1] = Math.round(data[i + 1] + (SILVER[1] - data[i + 1]) * grey);
      data[i + 2] = Math.round(data[i + 2] + (SILVER[2] - data[i + 2]) * grey);
    }
  }
  ctx.putImageData(image, box.x, box.y);
  mask.width = 0;
  blurred.width = 0;
}

/**
 * Lays the tape under the ink (and over the paper's lines and whatever was
 * written before): white, with only a hairline where each edge stands up
 * from the paper and a faint shadow under it.
 */
function drawTape(ctx: CanvasRenderingContext2D, passes: Path2D[], area: InkBox, pxPerMm: number): void {
  const layer = createCanvas(area.width, area.height);
  const l = layer.getContext("2d")!;
  l.translate(-area.x, -area.y);
  l.lineJoin = "miter";
  for (const path of passes) {
    l.save();
    l.filter = `blur(${Math.max(0.4, 0.06 * pxPerMm).toFixed(2)}px)`;
    l.translate(0.03 * pxPerMm, 0.06 * pxPerMm);
    l.fillStyle = "rgba(60, 64, 72, 0.13)";
    l.fill(path);
    l.restore();
    l.fillStyle = "#fefefd";
    l.fill(path);
    l.strokeStyle = "rgba(105, 110, 120, 0.32)";
    l.lineWidth = Math.max(0.6, 0.05 * pxPerMm);
    l.stroke(path);
  }
  ctx.save();
  ctx.globalCompositeOperation = "destination-over";
  ctx.drawImage(layer, area.x, area.y);
  ctx.restore();
  layer.width = 0;
}

/** An eraser rubbed over pencil: a faint, streaky grey haze of spread graphite. */
function drawEraserHaze(ctx: CanvasRenderingContext2D, d: Decoration, pxPerMm: number): InkBox | null {
  const rng = createRng(deriveSeed(d.seed, "eraser"));
  const xh = d.xhMm;
  const slope = (d.y1 - d.y0) / Math.max(0.01, d.x1 - d.x0);
  const left = d.x0 - 0.4 * xh;
  const right = d.x1 + 0.4 * xh;
  const [r, g, b] = parseHex(PENCIL_COLOR);
  ctx.save();
  ctx.globalCompositeOperation = "destination-over";
  ctx.filter = `blur(${Math.max(0.6, 0.25 * pxPerMm).toFixed(2)}px)`;
  ctx.lineCap = "round";
  // The eraser goes back and forth at a slant: short, uneven rubs, some heavier.
  const rubs = 7 + Math.floor(rng.next() * 6);
  for (let k = 0; k < rubs; k++) {
    const cx = left + (right - left) * rng.next();
    const cy = d.y0 + slope * (cx - d.x0) + (-1.2 + 1.5 * rng.next()) * xh;
    const length = (0.6 + 1.6 * rng.next()) * xh;
    const angle = (rng.next() - 0.5) * 1.2;
    ctx.strokeStyle = `rgba(${r},${g},${b},${(0.025 + 0.045 * rng.next()).toFixed(3)})`;
    ctx.lineWidth = (0.3 + 0.5 * rng.next()) * xh * pxPerMm;
    ctx.beginPath();
    ctx.moveTo((cx - Math.cos(angle) * length) * pxPerMm, (cy - Math.sin(angle) * length) * pxPerMm);
    ctx.lineTo((cx + Math.cos(angle) * length) * pxPerMm, (cy + Math.sin(angle) * length) * pxPerMm);
    ctx.stroke();
  }
  ctx.restore();
  return {
    x: Math.floor(left * pxPerMm),
    y: Math.floor((d.y0 - 2 * xh) * pxPerMm),
    width: Math.ceil((right - left) * pxPerMm),
    height: Math.ceil(3 * xh * pxPerMm),
  };
}

/** How far one sweep of the highlighter goes before the hand is lifted, in millimetres. */
const SWEEP_MM = [30, 70];

/**
 * A highlighted run the way people do it: sweeps of a few centimetres; the
 * hand is lifted and put back a little behind where it stopped, so the
 * restart overlaps (and shows darker) and sits at a slightly different height.
 */
function highlighterSweeps(d: Decoration, pxPerMm: number, wordByWord: boolean, round: boolean, pass = 0, shift = 0): { x: number; y: number; p: number }[][] {
  const rng = createRng(pass === 0 ? deriveSeed(d.seed, "sweeps") : deriveSeed(d.seed, "sweeps", pass));
  const xh = d.xhMm;
  // Word by word, the tip stops close to each word so the spaces stay clean.
  // A round end reaches half the tip's width further than where it stops.
  const cap = round ? HIGHLIGHT_TIP_MM / 2 : 0;
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
    sweeps.push(handLine(d, pxPerMm, { from, to: Math.min(to, end), seed: pass === 0 ? deriveSeed(d.seed, "sweep", n) : deriveSeed(d.seed, "sweep", n, pass), shift }));
    if (to >= end) break;
    from = to - (0.8 + 2.4 * rng.next());
  }
  // Every other pass goes back the other way.
  if (pass % 2 === 1) return sweeps.reverse().map((sweep) => sweep.reverse());
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
  /** What was written before correction tape went over it: drawn apart, to go under the tape. */
  const hiddenGroups = new Map<string, InkGroup>();
  const groupFor = (style: number, erased = false, hidden = false): InkGroup => {
    const run = style > 0 ? runStyles[style - 1] : undefined;
    const used = wornPen(run?.penId ? penById(run.penId) : pen, options.wear ?? 0);
    const groupPen = erased ? rubbedOut(used) : used;
    const color = groupPen.kind === "pencil" ? PENCIL_COLOR : (run?.color ?? options.color);
    const key = `${groupPen.id}|${color}|${erased ? "erased" : "ink"}`;
    const map = hidden ? hiddenGroups : groups;
    let group = map.get(key);
    if (!group) {
      group = { pen: groupPen, color, strokes: [] };
      map.set(key, group);
    }
    return group;
  };

  // Geometry of every stroke on this page: letters (bold ones twice) and hand-drawn lines.
  const highlights: { geometry: StrokeGeometry; color: number; smear: number; seed: number }[] = [];
  /** Correction tape and eraser marks, drawn under the ink. */
  const corrections: { d: Decoration; graphite: boolean }[] = [];
  const tapes: { passes: Path2D[]; box: InkBox; strokePx: number; strength: number }[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let strokeCount = 0;
  /** Lines drawn by hand over or under the text (not letters): where they are, for smudges and the highlighter. */
  const markStrokes: { g: StrokeGeometry; box: InkBox }[] = [];
  const include = (group: InkGroup, g: StrokeGeometry, seed: number, mark = false) => {
    g.seed = seed;
    const pad = Math.max(...g.widths) + blobReach(g) + softPx({ ...options, pen: group.pen }) * 3 + 2;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const sample of g.samples) {
      x0 = Math.min(x0, sample.x - pad);
      y0 = Math.min(y0, sample.y - pad);
      x1 = Math.max(x1, sample.x + pad);
      y1 = Math.max(y1, sample.y + pad);
    }
    minX = Math.min(minX, x0);
    minY = Math.min(minY, y0);
    maxX = Math.max(maxX, x1);
    maxY = Math.max(maxY, y1);
    if (mark) markStrokes.push({ g, box: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } });
    group.strokes.push(g);
    strokeCount++;
  };
  /** Paints the hand-drawn lines inside `region` in white onto `target` (aligned to the region), `grow` pixels wider. */
  const paintMarks = (target: CanvasRenderingContext2D, region: InkBox, grow: number): boolean => {
    let any = false;
    target.save();
    target.lineCap = "round";
    target.lineJoin = "round";
    target.strokeStyle = "#ffffff";
    for (const { g, box } of markStrokes) {
      if (box.x > region.x + region.width || box.x + box.width < region.x || box.y > region.y + region.height || box.y + box.height < region.y) continue;
      any = true;
      target.lineWidth = Math.max(...g.widths) + 2 * grow;
      target.beginPath();
      g.samples.forEach((s, i) => (i === 0 ? target.moveTo(s.x - region.x, s.y - region.y) : target.lineTo(s.x - region.x, s.y - region.y)));
      target.stroke();
    }
    target.restore();
    return any;
  };
  const addGlyph = (glyph: PlacedGlyph, hidden: boolean) => {
    if (glyph.page !== options.pageIndex) return;
    const variant = variantsOf(hand, glyph.char)[glyph.variantIndex];
    if (!variant) return;
    const group = groupFor(glyph.style ?? 0, Boolean(glyph.erased), hidden);
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
  };
  for (const glyph of layout.glyphs) addGlyph(glyph, false);
  for (const glyph of layout.hidden ?? []) addGlyph(glyph, true);
  for (const d of layout.decorations) {
    if (d.page !== options.pageIndex) continue;
    const rng = createRng(deriveSeed(d.seed, "ink"));
    if (d.kind === "tipex") {
      const tape = tapePasses(d, pxPerMm);
      const strength = (d.style > 0 ? runStyles[d.style - 1]?.tipexInk : undefined) ?? 1;
      if (tape) tapes.push({ ...tape, strokePx: groupFor(d.style ?? 0).pen.widthMm * widthScale * pxPerMm, strength });
      continue;
    }
    if (d.kind === "erased") {
      corrections.push({ d, graphite: groupFor(d.style ?? 0).pen.kind === "pencil" });
      continue;
    }
    if (d.kind === "scribble") {
      const group = groupFor(d.style ?? 0);
      const look = scribbleStyleOf(d.style > 0 ? runStyles[d.style - 1] : undefined);
      // People press harder when they blot something out.
      const width = widthScale * 1.1 * look.width;
      for (const stroke of scribbleStrokes(d, look)) {
        const points = stroke.map((point) => ({ x: point.x * pxPerMm, y: point.y * pxPerMm, p: point.p }));
        if (points.length > 1) include(group, strokeGeometry(points, rng, group.pen, nat, pxPerMm, d.xhMm, width), d.seed, true);
      }
      continue;
    }
    if (d.kind === "highlight") {
      const tip = { ...HIGHLIGHTER, widthMm: HIGHLIGHT_TIP_MM };
      // How much ink it drags depends on the instrument underneath.
      const smear = (nat.highlighterSmear ?? 0) * groupFor(d.style ?? 0).pen.smear;
      const look = d.style > 0 ? runStyles[d.style - 1] : undefined;
      const round = Boolean(look?.highlightRound);
      // Letters taller than the tip: more passes, each a little higher or lower.
      highlightPasses(d).forEach((shift, pass) => {
        highlighterSweeps(d, pxPerMm, Boolean(look?.highlightWords), round, pass, shift).forEach((sweep, n) => {
          const id = (name: string) => (pass === 0 ? deriveSeed(d.seed, name, n) : deriveSeed(d.seed, name, n, pass));
          const geometry = strokeGeometry(sweep, rng, tip, nat, pxPerMm, d.xhMm, 1);
          const sweepRng = createRng(id("chisel"));
          if (!round) {
            // The chisel is held at a slant; its ends are drawn rough by drawChisel.
            const lean = (4 + 18 * sweepRng.next()) * DEG;
            geometry.chisel = { x: Math.sin(lean), y: -Math.cos(lean), seed: id("ends"), poolStart: 0, poolEnd: 0 };
          }
          highlights.push({ geometry, color: d.color, smear, seed: id("smear") });
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
      });
    } else {
      const group = groupFor(d.style ?? 0);
      include(group, strokeGeometry(handLine(d, pxPerMm), rng, group.pen, nat, pxPerMm, d.xhMm, widthScale), d.seed, true);
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
    // A lump is a thicker layer of ink sitting on the line: darker in its middle.
    const lumps = group.strokes.flatMap((g) => g.lumps ?? []);
    if (lumps.length > 0) {
      const [r, gr, bl] = parseHex(group.color);
      target.save();
      target.fillStyle = `rgba(${r},${gr},${bl},${(0.55 * style.opacity).toFixed(3)})`;
      if (soft > 0.35) target.filter = `blur(${soft.toFixed(2)}px)`;
      for (const lump of lumps) {
        target.beginPath();
        target.ellipse(lump.x, lump.y, lump.along * 0.78, lump.across * 0.72, lump.angle, 0, Math.PI * 2);
        target.fill();
      }
      target.restore();
    }
    return gb;
  };

  // 0. What the tape hides, drawn first and set aside until the tape is down.
  let hiddenInk: { canvas: HTMLCanvasElement; box: InkBox } | null = null;
  const underTape = [...hiddenGroups.values()].filter((group) => group.strokes.length > 0);
  if (underTape.length > 0) {
    const reach = Math.max(...underTape.map((group) => softPx({ ...options, pen: group.pen }))) * 3 + 6;
    const hb = strokesBox(underTape.flatMap((group) => group.strokes), reach, canvas.width, canvas.height);
    if (hb) {
      const saved = createCanvas(hb.width, hb.height);
      const sctx = saved.getContext("2d")!;
      for (const group of underTape) {
        ctx.globalCompositeOperation = "source-over";
        const used = drawGroup(ctx, group);
        if (!used) continue;
        sctx.drawImage(canvas, hb.x, hb.y, hb.width, hb.height, 0, 0, hb.width, hb.height);
        ctx.clearRect(used.x, used.y, used.width, used.height);
      }
      ctx.globalCompositeOperation = "source-over";
      hiddenInk = { canvas: saved, box: hb };
    }
  }

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
  // 1a. Ink written on correction tape beads and dries grey, hollow in the middle.
  for (const tape of tapes) inkOnTape(ctx, tape.passes, tape.box, tape.strokePx, pxPerMm, tape.strength);

  // 1b. A water-based highlighter drags a little fresh ink along: a faint
  // trail after each letter, inside the band, in the direction it was drawn.
  // Lines drawn by hand under or through the words get dragged too (the wet
  // tip also spreads them a little up and down), unless the user says not.
  const smearMarks = options.smearMarks ?? true;
  if (box) {
    const STEPS = 8;
    for (const item of highlights) {
      if (item.smear < 0.01) continue;
      const hb = strokesBox([item.geometry], 2, canvas.width, canvas.height);
      if (!hb) continue;
      const reach = (0.3 + 0.8 * item.smear) * pxPerMm;
      const strength = Math.min(0.7, 0.5 * item.smear);
      // What there is to drag: the ink under the band, a little to the left of it too.
      const from = clampBox({ x: hb.x - reach, y: hb.y, width: hb.width + reach, height: hb.height }, canvas.width, canvas.height);
      if (!from) continue;
      const source = createCanvas(from.width, from.height);
      const sctx = source.getContext("2d")!;
      sctx.drawImage(canvas, from.x, from.y, from.width, from.height, 0, 0, from.width, from.height);
      let marks: HTMLCanvasElement | null = null;
      if (markStrokes.length > 0) {
        marks = createCanvas(from.width, from.height);
        if (!paintMarks(marks.getContext("2d")!, from, 1)) {
          marks.width = 0;
          marks = null;
        }
      }
      let markInk: HTMLCanvasElement | null = null;
      if (marks && smearMarks) {
        markInk = createCanvas(from.width, from.height);
        const mctx = markInk.getContext("2d")!;
        mctx.drawImage(source, 0, 0);
        mctx.globalCompositeOperation = "destination-in";
        mctx.drawImage(marks, 0, 0);
      } else if (marks) {
        sctx.globalCompositeOperation = "destination-out";
        sctx.drawImage(marks, 0, 0);
      }
      const trail = createCanvas(hb.width, hb.height);
      const tctx = trail.getContext("2d")!;
      tctx.filter = `blur(${Math.max(0.3, 0.1 * pxPerMm).toFixed(2)}px)`;
      for (let i = 1; i <= STEPS; i++) {
        tctx.globalAlpha = ((2 * strength) / STEPS) * (1 - (i - 1) / STEPS);
        tctx.drawImage(source, from.x - hb.x + (reach * i) / STEPS, from.y - hb.y);
      }
      if (markInk) {
        // Lines: a soft haze along them, up and down as well as along.
        tctx.filter = `blur(${Math.max(0.5, 0.15 * pxPerMm).toFixed(2)}px)`;
        const spread = (0.1 + 0.25 * item.smear) * pxPerMm;
        for (let i = 1; i <= STEPS; i++) {
          tctx.globalAlpha = ((2.6 * strength) / STEPS) * (1 - (i - 1) / STEPS);
          const up = (i % 2 === 0 ? 1 : -1) * spread * (0.4 + (0.6 * i) / STEPS);
          tctx.drawImage(markInk, from.x - hb.x + (reach * i) / STEPS, from.y - hb.y + up);
        }
        markInk.width = 0;
      }
      if (marks) marks.width = 0;
      source.width = 0;
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
  // Lines drawn by hand get smudged too, unless the user says not.
  const smudgeAmount = (nat.handSmudges ?? 0) * 3;
  const smudging = smudgeAmount * (options.leftHanded ? 3 : 1);
  const smudgeExtra = Math.max(0, smudgeAmount - 3);
  const smudgeMarks = options.smudgeMarks ?? true;
  /** What smudges add outside the ink, so the printed page keeps it. */
  let marksBox: InkBox | null = null;
  const left = Boolean(options.leftHanded);
  /** One smudge centred at (cx, cy), in pixels; the rest of its shape comes from `rng`. */
  const smudge = (cx: number, cy: number, xh: number, smudgePen: PenModel, rng: Rng) => {
    const STEPS = 6;
    const grow = 1 + 0.15 * smudgeExtra;
    const rx = xh * (left ? 0.8 + 1.0 * rng.next() : 0.7 + 0.8 * rng.next()) * pxPerMm * grow;
    const ry = xh * (0.45 + 0.35 * rng.next()) * pxPerMm;
    const angle = left ? (rng.next() - 0.5) * 0.3 : Math.PI * (0.25 + 0.2 * rng.next());
    const reach = xh * (left ? 0.6 + 1.0 * rng.next() : 0.4 + 0.7 * rng.next()) * pxPerMm * grow;
    const strength = Math.min(0.95, (0.3 + 0.3 * rng.next()) * Math.min(1, smudgePen.smudge) * (1 + 0.12 * smudgeExtra));
    const dx = Math.cos(angle) * reach;
    const dy = Math.sin(angle) * reach;
    const sb = clampBox({ x: cx - rx - reach, y: cy - rx - reach, width: 2 * (rx + reach), height: 2 * (rx + reach) }, canvas.width, canvas.height);
    if (!sb) return;
    marksBox = unionBox(marksBox, sb, canvas.width, canvas.height);
    // What the skin can pick up: the ink around, without the hand-drawn lines if the user says so.
    const from = clampBox({ x: sb.x - Math.abs(dx), y: sb.y - Math.abs(dy), width: sb.width + 2 * Math.abs(dx), height: sb.height + 2 * Math.abs(dy) }, canvas.width, canvas.height);
    if (!from) return;
    const source = createCanvas(from.width, from.height);
    const sctx = source.getContext("2d")!;
    sctx.drawImage(canvas, from.x, from.y, from.width, from.height, 0, 0, from.width, from.height);
    if (!smudgeMarks && markStrokes.length > 0) {
      sctx.globalCompositeOperation = "destination-out";
      paintMarks(sctx, from, 1);
    }
    const patch = createCanvas(sb.width, sb.height);
    const pctx = patch.getContext("2d")!;
    pctx.filter = `blur(${Math.max(0.4, 0.15 * pxPerMm).toFixed(2)}px)`;
    for (let i = 1; i <= STEPS; i++) {
      pctx.globalAlpha = ((2 * strength) / STEPS) * (1 - (i - 1) / STEPS);
      pctx.drawImage(source, from.x - sb.x + (dx * i) / STEPS, from.y - sb.y + (dy * i) / STEPS);
    }
    source.width = 0;
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
  };
  if (box && smudging > 0.005) {
    for (const glyph of layout.glyphs) {
      if (glyph.page !== options.pageIndex) continue;
      const pen = groupFor(glyph.style ?? 0).pen;
      const rng = createRng(deriveSeed(glyph.seed, "smudge"));
      if (rng.next() > Math.min(0.6, smudging * pen.smudge * (left ? 0.027 : 0.025))) continue;
      const xh = page.xHeightMm * glyph.scale;
      const cx = (glyph.xMm + glyph.widthMm * (0.2 + 0.6 * rng.next())) * pxPerMm;
      const cy = (glyph.yMm - xh * (left ? 0.2 + 0.4 * rng.next() : 0.5 + 0.5 * rng.next())) * pxPerMm;
      smudge(cx, cy, xh, pen, rng);
    }
    if (smudgeMarks) {
      // Along underlines, strikethroughs and scribbles, about as often per centimetre as over letters.
      for (const d of layout.decorations) {
        if (d.page !== options.pageIndex || (d.kind !== "underline" && d.kind !== "strike" && d.kind !== "scribble")) continue;
        const pen = groupFor(d.style ?? 0).pen;
        const rng = createRng(deriveSeed(d.seed, "smudge"));
        const perMm = (Math.min(0.6, smudging * pen.smudge * (left ? 0.027 : 0.025)) / (0.7 * d.xhMm)) * (d.kind === "scribble" ? 1.5 : 1);
        const length = Math.max(0, d.x1 - d.x0);
        const count = Math.floor(perMm * length + rng.next());
        const offset = d.kind === "underline" ? 0.32 : d.kind === "strike" ? -0.48 : -0.5;
        for (let n = 0; n < count; n++) {
          const x = d.x0 + length * rng.next();
          const y = d.y0 + ((d.y1 - d.y0) * (x - d.x0)) / Math.max(0.01, length) + offset * d.xhMm;
          smudge(x * pxPerMm, y * pxPerMm, d.xhMm, pen, rng);
        }
      }
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

  // 2b. Corrections under the ink: the tape hides the paper's lines and what
  // was written before it; an eraser leaves a faint grey haze of graphite.
  for (const tape of tapes) {
    const area = clampBox(tape.box, canvas.width, canvas.height);
    if (!area) continue;
    drawTape(ctx, tape.passes, area, pxPerMm);
    fullBox = unionBox(fullBox, area, canvas.width, canvas.height);
  }
  if (hiddenInk) {
    ctx.save();
    ctx.globalCompositeOperation = "destination-over";
    ctx.drawImage(hiddenInk.canvas, hiddenInk.box.x, hiddenInk.box.y);
    ctx.restore();
    hiddenInk.canvas.width = 0;
  }
  for (const { d, graphite } of corrections) {
    const area = graphite ? drawEraserHaze(ctx, d, pxPerMm) : null;
    fullBox = unionBox(fullBox, area ? clampBox(area, canvas.width, canvas.height) : null, canvas.width, canvas.height);
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
