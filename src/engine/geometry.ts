// Geometry for strokes: smoothing against hand tremor, simplification,
// simulated pressure and dense resampling for rendering.

export interface StrokePoint {
  /** Horizontal position. In a saved hand: x-height units from the cell origin. */
  x: number;
  /** Vertical position. In a saved hand: x-height units above the baseline. */
  y: number;
  /** Pressure from 0 to 1 (real from a pen, or simulated from speed). */
  p: number;
  /** Milliseconds since the stroke started. */
  t: number;
}

export interface Sample {
  x: number;
  y: number;
  p: number;
  /** Distance travelled from the start of the stroke, in the same units as x/y. */
  s: number;
}

const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;

function lerpPoint(a: StrokePoint, b: StrokePoint, k: number): StrokePoint {
  return { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), p: lerp(a.p, b.p, k), t: lerp(a.t, b.t, k) };
}

export function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Moving average that keeps both endpoints exactly where they were. */
export function movingAverage(points: StrokePoint[], radius: number): StrokePoint[] {
  if (radius < 1 || points.length < 3) return points.map((q) => ({ ...q }));
  const last = points.length - 1;
  return points.map((point, i) => {
    if (i === 0 || i === last) return { ...point };
    const r = Math.min(radius, i, last - i);
    let sx = 0;
    let sy = 0;
    let sp = 0;
    for (let j = i - r; j <= i + r; j++) {
      sx += points[j].x;
      sy += points[j].y;
      sp += points[j].p;
    }
    const n = 2 * r + 1;
    return { x: sx / n, y: sy / n, p: sp / n, t: point.t };
  });
}

/** Chaikin corner cutting: rounds polylines into smooth curves. */
export function chaikin(points: StrokePoint[], iterations: number): StrokePoint[] {
  let current = points;
  for (let k = 0; k < iterations; k++) {
    if (current.length < 3) break;
    const next: StrokePoint[] = [current[0]];
    for (let i = 0; i < current.length - 1; i++) {
      next.push(lerpPoint(current[i], current[i + 1], 0.25), lerpPoint(current[i], current[i + 1], 0.75));
    }
    next.push(current[current.length - 1]);
    current = next;
  }
  return current;
}

/** Final smoothing applied when a stroke ends. level goes from 0 (raw) to 1 (very smooth). */
export function smoothStroke(points: StrokePoint[], level: number): StrokePoint[] {
  const clamped = Math.max(0, Math.min(1, level));
  const averaged = movingAverage(points, Math.round(clamped * 6));
  return chaikin(averaged, clamped > 0.05 ? 2 : 0);
}

/**
 * Real-time stabiliser used while drawing ("lazy brush"): the drawn point
 * follows the pointer with a lag that hides small trembling.
 */
export function stabilise(previous: StrokePoint, raw: StrokePoint, level: number): StrokePoint {
  const follow = 1 - Math.max(0, Math.min(1, level)) * 0.85;
  return { x: lerp(previous.x, raw.x, follow), y: lerp(previous.y, raw.y, follow), p: raw.p, t: raw.t };
}

function perpendicularDistance(point: StrokePoint, a: StrokePoint, b: StrokePoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return distance(point, a);
  return Math.abs(dy * point.x - dx * point.y + b.x * a.y - b.y * a.x) / length;
}

/** Ramer–Douglas–Peucker simplification to keep saved hands small. */
export function simplify(points: StrokePoint[], epsilon: number): StrokePoint[] {
  if (points.length < 3) return points.map((q) => ({ ...q }));
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    let maxDist = 0;
    let index = -1;
    for (let i = start + 1; i < end; i++) {
      const d = perpendicularDistance(points[i], points[start], points[end]);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (index !== -1 && maxDist > epsilon) {
      keep[index] = true;
      stack.push([start, index], [index, end]);
    }
  }
  return points.filter((_, i) => keep[i]).map((q) => ({ ...q }));
}

/**
 * Mouse and trackpad have no pressure, so it is simulated from speed:
 * fast movement makes thinner, lighter lines, as with a real pen.
 * @param referenceSpeed speed (units per millisecond) that counts as "fast".
 */
export function pressureFromVelocity(points: StrokePoint[], referenceSpeed: number): StrokePoint[] {
  if (points.length === 0) return [];
  let smoothedSpeed = 0;
  return points.map((point, i) => {
    if (i > 0) {
      const dt = Math.max(1, point.t - points[i - 1].t);
      const speed = distance(point, points[i - 1]) / dt;
      smoothedSpeed = i === 1 ? speed : smoothedSpeed * 0.75 + speed * 0.25;
    }
    const pressure = 1 - 0.6 * Math.min(1, smoothedSpeed / referenceSpeed);
    return { ...point, p: Math.max(0.3, Math.min(1, pressure)) };
  });
}

/**
 * Catmull–Rom resampling: turns a few points into an evenly spaced, smooth
 * sequence of samples for rendering.
 */
export function resample(points: { x: number; y: number; p: number }[], step: number): Sample[] {
  if (points.length === 0) return [];
  if (points.length === 1) return [{ x: points[0].x, y: points[0].y, p: points[0].p, s: 0 }];
  const out: Sample[] = [];
  let travelled = 0;
  let previous: { x: number; y: number } | null = null;
  const at = (i: number) => points[Math.max(0, Math.min(points.length - 1, i))];

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const segments = Math.max(1, Math.ceil(distance(p1, p2) / step));
    for (let k = 0; k < segments; k++) {
      const t = k / segments;
      const t2 = t * t;
      const t3 = t2 * t;
      const x =
        0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
      const y =
        0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
      if (previous) travelled += Math.hypot(x - previous.x, y - previous.y);
      out.push({ x, y, p: lerp(p1.p, p2.p, t), s: travelled });
      previous = { x, y };
    }
  }
  const last = points[points.length - 1];
  if (previous) travelled += Math.hypot(last.x - previous.x, last.y - previous.y);
  out.push({ x: last.x, y: last.y, p: last.p, s: travelled });
  return out;
}

export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export function boundsOf(strokes: { x: number; y: number }[][]): Bounds | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const stroke of strokes) {
    for (const point of stroke) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
    }
  }
  return Number.isFinite(minX) ? { minX, maxX, minY, maxY } : null;
}
