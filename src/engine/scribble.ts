// Scribbling out a mistake, the way the user does it on paper ("ejemplo de
// tachones.jpg"): leaning zigzags, a few lines through the middle, long
// back-and-forth ovals, a cross, or a tangle of loops. "Rage" goes from a
// calm correction to a word blotted out in anger.

import { createRng, type Rng } from "./random";
import type { ScribbleStyle } from "./rich-text";

export interface ScribblePoint {
  x: number;
  y: number;
  p: number;
}

/** Where to scribble: a run of letters on one line, in millimetres. */
export interface ScribbleArea {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** x-height of the letters underneath. */
  xhMm: number;
  seed: number;
}

/** Smooth random values along a parameter, for sizes that drift instead of jumping. */
function drift(rng: Rng, step: number): (t: number) => number {
  const values: number[] = [];
  return (t: number) => {
    const k = Math.max(0, t / step);
    const i = Math.floor(k);
    while (values.length <= i + 1) values.push(rng.next() * 2 - 1);
    const f = k - i;
    const s = f * f * (3 - 2 * f);
    return values[i] * (1 - s) + values[i + 1] * s;
  };
}

/** Progress along one stroke: straight in the middle, quick round turns at the ends. */
const SOFT = 0.94;
function turn(f: number): number {
  return (1 - Math.asin(SOFT * Math.cos(Math.PI * f)) / Math.asin(SOFT)) / 2;
}

/** Leaning strokes up and down over the word, there and back (rows 4 and 5 of the sample). */
function zigzag(a: ScribbleArea, rng: Rng, rage: number, baseAt: (x: number) => number): ScribblePoint[][] {
  const xh = a.xhMm;
  const left = a.x0 - (0.05 + 0.15 * rng.next()) * xh;
  const right = a.x1 + (0.05 + 0.2 * rng.next()) * xh;
  const spacing = (0.42 - 0.27 * rage) * xh;
  const passes = rage < 0.3 ? 1 : rage < 0.75 ? 2 : 3;
  const lean = 0.25 + 0.15 * rng.next();
  const SAMPLES = 6;
  const points: ScribblePoint[] = [];
  let lastY: number | null = null;
  let low = true;
  for (let pass = 0; pass < passes; pass++) {
    const forward = pass % 2 === 0;
    const from = forward ? left : right;
    const to = forward ? right : left;
    const passLean = forward ? lean : lean - 0.25 - 0.15 * rng.next();
    const strokes = Math.max(2, Math.round(Math.abs(to - from) / (spacing * (0.85 + 0.3 * rng.next()))));
    // Turning points: low near the baseline, high over the ascenders, never twice the same.
    const ends: number[] = [];
    for (let i = 0; i <= strokes; i++) {
      if (i === 0 && lastY !== null) {
        ends.push(lastY - baseAt(from));
        continue;
      }
      if (i > 0 || pass > 0) low = !low;
      ends.push(low ? (0.05 + 0.25 * rng.next()) * xh * (0.6 + 0.7 * rage) : -xh * (0.95 + 0.55 * rage) * (0.65 + 0.7 * rng.next()));
    }
    const pressures = ends.map(() => 0.85 + 0.15 * rng.next());
    const total = strokes * SAMPLES;
    for (let s = pass === 0 ? 0 : 1; s <= total; s++) {
      const k = s / SAMPLES;
      const i = Math.min(strokes - 1, Math.floor(k));
      const f = k - i;
      const g = turn(f);
      const rise = ends[i] + (ends[i + 1] - ends[i]) * g;
      const along = from + ((to - from) * s) / total;
      const middle = -0.45 * xh;
      const x = along + (middle - rise) * passLean;
      const y = baseAt(along) + rise;
      points.push({ x, y, p: pressures[i] + (pressures[i + 1] - pressures[i]) * g });
    }
    lastY = points[points.length - 1].y;
  }
  return [points];
}

/**
 * Back and forth along the line: a few nearly parallel lines (row 1) or many
 * long ovals that cover the letters (rows 2 and 3).
 */
function backAndForth(
  a: ScribbleArea,
  rng: Rng,
  passes: number,
  spread: number,
  bulge: number,
  tilt: number,
  lift: boolean,
  baseAt: (x: number) => number,
): ScribblePoint[][] {
  const xh = a.xhMm;
  const strokes: ScribblePoint[][] = [];
  let points: ScribblePoint[] = [];
  const centre = -0.45 * xh;
  const step = 0.2 * xh;
  const width = a.x1 - a.x0;
  for (let j = 0; j < passes; j++) {
    const forward = lift || j % 2 === 0;
    let start = a.x0 - (0.05 + 0.35 * rng.next()) * xh;
    let end = a.x1 + (0.05 + 0.4 * rng.next()) * xh;
    // Over a long phrase not every pass goes from end to end.
    if (!lift && j > 0 && width > 12 * xh && rng.next() < 0.35) {
      const part = (0.4 + 0.4 * rng.next()) * width;
      if (rng.next() < 0.5) end = start + part;
      else start = end - part;
    }
    const from = forward ? start : end;
    const to = forward ? end : start;
    const offset = centre + (rng.next() * 2 - 1) * spread;
    const slope = (rng.next() * 2 - 1) * tilt;
    const bow = (rng.next() * 2 - 1) * 0.1 * xh;
    const pressure = 0.82 + 0.18 * rng.next();
    const yAt = (x: number, k: number) => baseAt(x) + offset + slope * (x - from) + bow * Math.sin(Math.PI * k);
    if (lift && points.length > 0) {
      strokes.push(points);
      points = [];
    }
    if (points.length > 0) {
      // The turn: a round end that swings out past the word, wider for ovals.
      const last = points[points.length - 1];
      const target = { x: from, y: yAt(from, 0) };
      const out = forward ? -1 : 1;
      const swing = bulge * (0.6 + 0.8 * rng.next()) + 0.25 * Math.abs(target.y - last.y);
      const TURN = 8;
      for (let i = 1; i < TURN; i++) {
        const t = i / TURN;
        points.push({
          x: last.x + (target.x - last.x) * t + out * swing * Math.sin(Math.PI * t),
          y: last.y + (target.y - last.y) * (0.5 - 0.5 * Math.cos(Math.PI * t)),
          p: pressure,
        });
      }
    }
    const steps = Math.max(4, Math.ceil(Math.abs(to - from) / step));
    for (let i = 0; i <= steps; i++) {
      const k = i / steps;
      const x = from + (to - from) * k;
      points.push({ x, y: yAt(x, k), p: pressure });
    }
  }
  strokes.push(points);
  return strokes;
}

/** Two long diagonals, sometimes gone over again (rows 6 and 7). */
function cross(a: ScribbleArea, rng: Rng, rage: number, baseAt: (x: number) => number): ScribblePoint[][] {
  const xh = a.xhMm;
  const lines = 2 + (rage > 0.45 ? 1 : 0) + (rage > 0.8 ? 1 : 0);
  const strokes: ScribblePoint[][] = [];
  for (let n = 0; n < lines; n++) {
    const down = n % 2 === 0;
    const over = () => (0.15 + 0.35 * rng.next()) * xh;
    const left = a.x0 - over();
    const right = a.x1 + over();
    const top = -(1.05 + 0.4 * rng.next() + 0.3 * rage) * xh;
    const bottom = (0.25 + 0.3 * rng.next()) * xh;
    const shift = n >= 2 ? (rng.next() * 2 - 1) * 0.2 * xh : 0;
    const y0 = (down ? top : bottom) + shift;
    const y1 = (down ? bottom : top) + shift;
    const bow = (rng.next() * 2 - 1) * 0.12 * xh;
    const steps = Math.max(6, Math.ceil((right - left) / (0.3 * xh)));
    const line: ScribblePoint[] = [];
    for (let i = 0; i <= steps; i++) {
      const k = i / steps;
      const x = left + (right - left) * k;
      line.push({ x, y: baseAt(x) + y0 + (y1 - y0) * k + bow * Math.sin(Math.PI * k), p: 0.88 + 0.1 * Math.sin(Math.PI * k) });
    }
    strokes.push(line);
  }
  return strokes;
}

/** A tangle of loops that rolls along the word (rows 8 and 9). */
function loops(a: ScribbleArea, rng: Rng, rage: number, baseAt: (x: number) => number): ScribblePoint[][] {
  const xh = a.xhMm;
  const points: ScribblePoint[] = [];
  const left = a.x0 + 0.1 * xh;
  const right = a.x1 - 0.1 * xh;
  const width = Math.max(0.3 * xh, right - left);
  const passes = rage > 0.55 ? 2 : 1;
  for (let pass = 0; pass < passes; pass++) {
    const forward = pass === 0;
    // The way back is quicker: longer, flatter loops.
    const advance = (forward ? 0.65 - 0.3 * rage : 1.6 - 0.4 * rage) * xh;
    const flat = forward ? 1 : 0.55;
    const revolutions = Math.max(1.2, width / advance);
    const rx = drift(rng, Math.PI);
    const ry = drift(rng, Math.PI * 0.8);
    const cy = drift(rng, Math.PI * 1.3);
    const total = revolutions * Math.PI * 2;
    const steps = Math.ceil(revolutions * 26);
    const phase = rng.next() * Math.PI * 2;
    for (let i = pass === 0 ? 0 : 1; i <= steps; i++) {
      const theta = (total * i) / steps;
      const k = theta / total;
      const along = forward ? left + width * k : right - width * k;
      const radiusX = (0.55 + 0.38 * rx(theta)) * xh * (1 + 0.25 * rage) * (forward ? 1 : 1.3);
      const radiusY = (0.55 + 0.38 * ry(theta)) * xh * (1 + 0.25 * rage) * flat;
      const centre = -0.5 * xh + 0.35 * xh * cy(theta);
      const angle = theta + phase;
      const direction = forward ? 1 : -1;
      points.push({
        x: along + direction * radiusX * Math.cos(angle),
        y: baseAt(along) + centre - radiusY * Math.sin(angle),
        p: 0.82 + 0.15 * Math.abs(Math.sin(angle * 0.5)),
      });
    }
  }
  return [points];
}

/** The pen strokes of a scribble over an area, in millimetres. */
export function scribbleStrokes(area: ScribbleArea, style: ScribbleStyle): ScribblePoint[][] {
  const rng = createRng(area.seed);
  const rage = Math.max(0, Math.min(1, style.rage));
  const slope = (area.y1 - area.y0) / Math.max(0.01, area.x1 - area.x0);
  const baseAt = (x: number) => area.y0 + slope * (x - area.x0);
  switch (style.kind) {
    case "lines":
      return backAndForth(area, rng, 2 + Math.round(rage * 3), (0.16 + 0.2 * rage) * area.xhMm, 0, 0.012 + 0.02 * rage, true, baseAt);
    case "ovals":
      return backAndForth(area, rng, 6 + Math.round(rage * 10), (0.5 + 0.25 * rage) * area.xhMm, 0.35 * area.xhMm, 0.02 + 0.02 * rage, false, baseAt);
    case "cross":
      return cross(area, rng, rage, baseAt);
    case "loops":
      return loops(area, rng, rage, baseAt);
    default:
      return zigzag(area, rng, rage, baseAt);
  }
}
