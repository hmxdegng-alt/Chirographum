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
import { glyphPointToPage, type LayoutResult } from "./layout";
import type { PenModel } from "./pens";
import { createRng, deriveSeed, type Rng } from "./random";
import type { Naturalness, PageSettings } from "./settings";

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
  /** Screen only: imitate how an inkjet printer lays the ink (fibres, dots). */
  printedLook?: boolean;
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
  const skipLevel = nat.inkSkips * pen.skipProne;
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
  const onWhite = options.background === "white";

  // Geometry of every stroke on this page.
  const strokes: StrokeGeometry[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const glyph of layout.glyphs) {
    if (glyph.page !== options.pageIndex) continue;
    const variant = hand.glyphs[glyph.char]?.[glyph.variantIndex];
    if (!variant) continue;
    variant.strokes.forEach((stroke, strokeIndex) => {
      if (stroke.length === 0) return;
      const rng = createRng(deriveSeed(glyph.seed, "stroke", strokeIndex));
      const points = stroke.map((point) => {
        const mapped = glyphPointToPage(glyph, page.xHeightMm, point.x, point.y);
        return { x: mapped.x * pxPerMm, y: mapped.y * pxPerMm, p: point.p };
      });
      const g = strokeGeometry(points, rng, pen, nat, pxPerMm, page.xHeightMm, options.widthScale ?? 1);
      const pad = Math.max(...g.widths) + Math.max(g.startBlob, g.endBlob) + softPx(options) * 3 + 2;
      for (const s of g.samples) {
        minX = Math.min(minX, s.x - pad);
        minY = Math.min(minY, s.y - pad);
        maxX = Math.max(maxX, s.x + pad);
        maxY = Math.max(maxY, s.y + pad);
      }
      strokes.push(g);
    });
  }

  ctx.globalCompositeOperation = "source-over";
  if (onWhite) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  } else {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  if (strokes.length === 0) return null;
  const box = clampBox({ x: minX, y: minY, width: maxX - minX, height: maxY - minY }, canvas.width, canvas.height);
  if (!box) return null;
  const style: InkStyle = {
    color: options.color,
    opacity: Math.max(0, Math.min(1, pen.opacity * (options.inkStrength ?? 1))),
    onWhite,
    printed: printedStrength(options),
    pxPerMm,
  };
  const soft = softPx(options);

  if (pen.buildsUp) {
    // Markers: strokes that touch go to different layers, stacked translucent.
    const layerCanvas = createCanvas(canvas.width, canvas.height);
    const lctx = layerCanvas.getContext("2d")!;
    lctx.lineCap = "round";
    lctx.lineJoin = "round";
    for (const layer of markerLayers(strokes, Math.max(2, pxPerMm))) {
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
      applyGrain(lctx, options, 0, 0, canvas.width, canvas.height);
      lctx.restore();
      blurRegion(lctx, lb, soft);
      toneToInk(lctx, lb, { ...style, onWhite: false });
      ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(layerCanvas, lb.x, lb.y, lb.width, lb.height, lb.x, lb.y, lb.width, lb.height);
    }
    layerCanvas.width = 0;
    return box;
  }

  // 1. Tone mask inside the ink box: black = no ink, white = full ink.
  ctx.fillStyle = "#000000";
  ctx.fillRect(box.x, box.y, box.width, box.height);
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.width, box.height);
  ctx.clip();
  ctx.globalCompositeOperation = "lighten";
  for (const g of strokes) drawTone(ctx, g, 0, 0);
  // 2. Paper grain: the same paper under every stroke.
  applyGrain(ctx, options, 0, 0, canvas.width, canvas.height);
  ctx.restore();

  // 3. Soft edges (pencil, felt tips, printer ink spread), still on the opaque mask.
  blurRegion(ctx, box, soft);

  // 4. Mask to coloured ink, only inside the box.
  ctx.globalCompositeOperation = "source-over";
  toneToInk(ctx, box, style);
  return box;
}
