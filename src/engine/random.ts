// Seeded randomness. Every imperfection is drawn from here so the same seed
// always produces the same page, and moving a slider only scales offsets
// instead of reshuffling the whole sheet.

export interface Rng {
  /** Uniform number in [0, 1). */
  next(): number;
  /** Standard normal number (mean 0, deviation 1). */
  gauss(): number;
  /** Uniform number in [min, max). */
  range(min: number, max: number): number;
  /** Uniform integer in [0, n). */
  int(n: number): number;
}

/** FNV-1a hash of a string, as an unsigned 32-bit integer. */
export function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Combines a seed with labels, e.g. deriveSeed(seed, "glyph", 12). */
export function deriveSeed(seed: number, ...labels: (string | number)[]): number {
  return hashString(`${seed >>> 0}|${labels.join("|")}`);
}

/** Mulberry32 generator: small, fast and good enough for visual noise. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  let spareGauss: number | null = null;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const gauss = (): number => {
    if (spareGauss !== null) {
      const value = spareGauss;
      spareGauss = null;
      return value;
    }
    let u = 0;
    while (u === 0) u = next();
    const v = next();
    const mag = Math.sqrt(-2 * Math.log(u));
    spareGauss = mag * Math.sin(2 * Math.PI * v);
    return mag * Math.cos(2 * Math.PI * v);
  };

  return {
    next,
    gauss,
    range: (min, max) => min + (max - min) * next(),
    int: (n) => Math.floor(next() * n),
  };
}

/** A gaussian value clamped to ±limit deviations, so outliers never look broken. */
export function clampedGauss(rng: Rng, limit = 2.5): number {
  const value = rng.gauss();
  return Math.max(-limit, Math.min(limit, value));
}

/** Random seed for a new "otra versión". */
export function freshSeed(): number {
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}
