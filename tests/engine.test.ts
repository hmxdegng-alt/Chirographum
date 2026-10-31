import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { pressureFromVelocity, resample, simplify, smoothStroke, type StrokePoint } from "../src/engine/geometry";
import {
  charactersNeeded,
  createHand,
  HandFormatError,
  missingCharacters,
  parseHand,
  serializeHand,
  withVariantAdded,
  withVariantRemoved,
  type Hand,
} from "../src/engine/hand";
import { glyphPointToPage, layoutText } from "../src/engine/layout";
import { createRng, deriveSeed } from "../src/engine/random";
import { A4, presetById, randomNaturalness } from "../src/engine/settings";

const require = createRequire(import.meta.url);
const { isAllowedUrl } = require("../electron/network-guard.cjs") as {
  isAllowedUrl: (url: string, dev?: string) => boolean;
};

const line = (n: number): StrokePoint[] => Array.from({ length: n }, (_, i) => ({ x: i * 0.1, y: Math.sin(i) * 0.05, p: 0.6, t: i * 10 }));

/** A tiny synthetic hand: every letter is a box of strokes, with 3 variants. */
function syntheticHand(chars: string): Hand {
  let hand = createHand("Test");
  for (const char of chars) {
    for (let v = 0; v < 3; v++) {
      const w = 0.6 + v * 0.05;
      hand = withVariantAdded(hand, char, {
        strokes: [
          [
            { x: 0, y: 0, p: 0.6, t: 0 },
            { x: 0, y: 1, p: 0.7, t: 50 },
            { x: w, y: 1, p: 0.7, t: 100 },
            { x: w, y: 0, p: 0.6, t: 150 },
          ],
        ],
      });
    }
  }
  return hand;
}

describe("random", () => {
  it("is deterministic for the same seed", () => {
    const a = createRng(42);
    const b = createRng(42);
    expect([a.next(), a.gauss(), a.int(10)]).toEqual([b.next(), b.gauss(), b.int(10)]);
  });

  it("derives different seeds for different labels", () => {
    expect(deriveSeed(1, "glyph", 1)).not.toBe(deriveSeed(1, "glyph", 2));
  });
});

describe("geometry", () => {
  it("smoothing keeps the endpoints in place", () => {
    const points = line(20);
    const smooth = smoothStroke(points, 1);
    expect(smooth[0]).toMatchObject({ x: points[0].x, y: points[0].y });
    expect(smooth.at(-1)).toMatchObject({ x: points.at(-1)!.x, y: points.at(-1)!.y });
  });

  it("simplify never removes the endpoints", () => {
    const simple = simplify(line(50), 0.01);
    expect(simple[0].x).toBe(0);
    expect(simple.at(-1)!.x).toBeCloseTo(4.9);
    expect(simple.length).toBeLessThan(50);
  });

  it("fast movement lowers simulated pressure", () => {
    const slow = pressureFromVelocity([{ x: 0, y: 0, p: 0, t: 0 }, { x: 0.01, y: 0, p: 0, t: 100 }], 0.02);
    const fast = pressureFromVelocity([{ x: 0, y: 0, p: 0, t: 0 }, { x: 5, y: 0, p: 0, t: 10 }], 0.02);
    expect(fast[1].p).toBeLessThan(slow[1].p);
    expect(fast[1].p).toBeGreaterThanOrEqual(0.3);
  });

  it("resampling produces evenly spaced samples", () => {
    const samples = resample([{ x: 0, y: 0, p: 1 }, { x: 10, y: 0, p: 1 }], 0.5);
    expect(samples.length).toBe(21);
    expect(samples.at(-1)!.s).toBeCloseTo(10);
  });
});

describe("hand files", () => {
  it("round-trips through serialize and parse", () => {
    const hand = syntheticHand("ab");
    const parsed = parseHand(serializeHand(hand));
    expect(Object.keys(parsed.glyphs)).toEqual(["a", "b"]);
    expect(parsed.glyphs.a).toHaveLength(3);
  });

  it("rejects files that are not hands", () => {
    expect(() => parseHand("not json")).toThrow(HandFormatError);
    expect(() => parseHand(JSON.stringify({ format: "other" }))).toThrow(HandFormatError);
  });

  it("removes variants and drops empty characters", () => {
    let hand = syntheticHand("a");
    for (let i = 0; i < 3; i++) hand = withVariantRemoved(hand, "a", 0);
    expect(hand.glyphs.a).toBeUndefined();
  });

  it("lists needed and missing characters", () => {
    expect(charactersNeeded("Hola, hola")).toEqual(["H", "o", "l", "a", ",", "h"]);
    expect(missingCharacters(syntheticHand("ola"), "Hola")).toEqual(["H"]);
  });
});

describe("layout", () => {
  const text = "uno dos tres cuatro cinco seis siete ocho nueve diez ".repeat(12);
  const hand = syntheticHand("unodstrecaiflhvz");
  const nat = presetById("normal").values;

  it("keeps every letter inside the page margins (with a small natural overflow)", () => {
    const result = layoutText(text, hand, A4, nat, 7);
    expect(result.glyphs.length).toBeGreaterThan(100);
    const right = A4.widthMm - A4.marginRightMm;
    for (const glyph of result.glyphs) {
      expect(glyph.xMm).toBeGreaterThanOrEqual(A4.marginLeftMm - 6);
      expect(glyph.xMm).toBeLessThan(right + 4);
    }
    expect(result.lineCount).toBeGreaterThan(3);
  });

  it("never repeats the same variant twice in a row for a character", () => {
    const result = layoutText("oooooooooooooooooooo", hand, A4, nat, 3);
    for (let i = 1; i < result.glyphs.length; i++) {
      expect(result.glyphs[i].variantIndex).not.toBe(result.glyphs[i - 1].variantIndex);
    }
  });

  it("is reproducible with the same seed and changes with another", () => {
    const a = layoutText(text, hand, A4, nat, 11);
    const b = layoutText(text, hand, A4, nat, 11);
    const c = layoutText(text, hand, A4, nat, 12);
    expect(a.glyphs).toEqual(b.glyphs);
    expect(a.glyphs).not.toEqual(c.glyphs);
  });

  it("with no imperfections, letters sit exactly on straight lines", () => {
    const none = { ...nat, sizeVariation: 0, rotation: 0, slantDegrees: 0, slantVariation: 0, baselineWobble: 0, lineDrift: 0, spacingVariation: 0, edgeShrink: 0, marginDrift: 0 };
    const result = layoutText("uno dos tres", hand, A4, none, 5);
    const ys = new Set(result.glyphs.map((g) => g.yMm.toFixed(6)));
    expect(ys.size).toBe(1);
    expect(result.glyphs[0].xMm).toBe(A4.marginLeftMm);
  });

  it("reports missing characters and overflow", () => {
    const result = layoutText("xyz ".repeat(2000), hand, A4, nat, 1);
    expect(result.missing).toEqual(["x", "y"]);
    expect(result.overflow).toBe(true);
  });

  it("maps glyph points onto the page with y growing downwards", () => {
    const glyph = { char: "a", variantIndex: 0, xMm: 50, yMm: 100, scale: 1, rotation: 0, shear: 0, offsetX: 0, seed: 1 };
    expect(glyphPointToPage(glyph, 3, 0, 1)).toEqual({ x: 50, y: 97 });
  });
});

describe("network guard", () => {
  it("allows only the app's own files", () => {
    expect(isAllowedUrl("file:///C:/Program%20Files/Chirographum/index.html")).toBe(true);
    expect(isAllowedUrl("blob:file:///1234")).toBe(true);
    expect(isAllowedUrl("data:image/png;base64,AAAA")).toBe(true);
    expect(isAllowedUrl("https://example.com/")).toBe(false);
    expect(isAllowedUrl("http://192.168.1.10/")).toBe(false);
    expect(isAllowedUrl("ws://localhost:5173/")).toBe(false);
    expect(isAllowedUrl("not a url")).toBe(false);
  });

  it("allows the dev server only while developing", () => {
    const dev = "http://localhost:5173/";
    expect(isAllowedUrl("http://localhost:5173/src/main.ts", dev)).toBe(true);
    expect(isAllowedUrl("ws://localhost:5173/", dev)).toBe(true);
    expect(isAllowedUrl("http://localhost:8080/", dev)).toBe(false);
    expect(isAllowedUrl("https://example.com/", dev)).toBe(false);
  });
});

describe("random preset", () => {
  it("stays between careful and hurried and depends only on the seed", () => {
    const careful = presetById("careful").values;
    const hurried = presetById("hurried").values;
    for (let seed = 1; seed < 200; seed++) {
      const values = randomNaturalness(seed);
      expect(randomNaturalness(seed)).toEqual(values);
      for (const key of Object.keys(careful) as (keyof typeof careful)[]) {
        if (key === "slantDegrees") {
          expect(values[key]).toBeGreaterThanOrEqual(-2);
          expect(values[key]).toBeLessThanOrEqual(6);
        } else {
          expect(values[key]).toBeGreaterThanOrEqual(careful[key] - 1e-9);
          expect(values[key]).toBeLessThanOrEqual(hurried[key] + 1e-9);
        }
      }
    }
    expect(randomNaturalness(1)).not.toEqual(randomNaturalness(2));
  });
});
