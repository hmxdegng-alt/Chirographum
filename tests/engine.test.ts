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
import { editedWordRange, updateCharIds } from "../src/engine/char-ids";
import { decodeIds, documentTitle, DocumentFormatError, encodeIds, parseDocument, serializeDocument } from "../src/engine/document";
import { glyphPointToPage, layoutText } from "../src/engine/layout";
import {
  applyRunStyle,
  BOLD,
  compactRunStyles,
  decodeBytes,
  runStyleIndex,
  upgradeMarkV1,
  withRunStyle,
  decodeParagraph,
  encodeBytes,
  encodeParagraph,
  HIGHLIGHT,
  highlightColorIndex,
  rangeHasMark,
  withHighlightColor,
  SCRIBBLE,
  SCRIBBLE_KINDS,
  scribbleFields,
  scribbleStyleOf,
  setMark,
  UNDERLINE,
  updateMarks,
  updateParagraphs,
} from "../src/engine/rich-text";
import { createRng, deriveSeed } from "../src/engine/random";
import { scribbleStrokes } from "../src/engine/scribble";
import { sliderZone } from "../src/ui/dom";
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
    const none = { ...nat, sizeVariation: 0, rotation: 0, slantDegrees: 0, slantVariation: 0, baselineWobble: 0, lineDrift: 0, spacingVariation: 0, edgeShrink: 0, marginDrift: 0, lineSlope: 0 };
    const result = layoutText("uno dos tres", hand, A4, none, 5);
    const ys = new Set(result.glyphs.map((g) => g.yMm.toFixed(6)));
    expect(ys.size).toBe(1);
    expect(result.glyphs[0].xMm).toBe(A4.marginLeftMm);
  });

  it("reports missing characters and continues on new pages", () => {
    const result = layoutText("xyz ".repeat(2000), hand, A4, nat, 1);
    expect(result.missing).toEqual(["x", "y"]);
    expect(result.overflow).toBe(false);
    expect(result.pageCount).toBeGreaterThan(1);
    expect(Math.max(...result.glyphs.map((g) => g.page))).toBe(result.pageCount - 1);
    for (const glyph of result.glyphs) expect(glyph.yMm).toBeLessThan(A4.heightMm - A4.marginBottomMm + 5);
  });

  it("gives a cursor position for every character, in reading order", () => {
    const sample = "uno dos\n\ntres  cuatro";
    const result = layoutText(sample, hand, A4, nat, 4);
    expect(result.carets).toHaveLength(sample.length + 1);
    for (const stop of result.carets) expect(stop).toBeDefined();
    // Same line: the cursor moves right; after a line break it goes down.
    expect(result.carets[1].xMm).toBeGreaterThan(result.carets[0].xMm);
    expect(result.carets[8].line).toBe(result.carets[0].line + 1);
    expect(result.carets[9].line).toBe(result.carets[0].line + 2);
    expect(result.carets[9].yMm).toBeGreaterThan(result.carets[0].yMm);
  });

  it("typing a word does not rewrite the other words", () => {
    let counter = 1;
    const fresh = () => counter++ * 7919;
    const oldText = "uno dos tres cuatro";
    const oldIds = Array.from({ length: oldText.length }, fresh);
    const newText = "uno dos diez tres cuatro";
    const newIds = updateCharIds(oldText, oldIds, newText, fresh);
    expect(newIds.slice(0, 8)).toEqual(oldIds.slice(0, 8));
    expect(newIds.slice(13)).toEqual(oldIds.slice(8));
    const before = layoutText(oldText, hand, A4, nat, 9, oldIds);
    const after = layoutText(newText, hand, A4, nat, 9, newIds);
    const word = (r: typeof before, from: number, n: number) => r.glyphs.slice(from, from + n).map((g) => [g.scale, g.rotation, g.shear, g.seed]);
    // "uno dos" and "tres cuatro" keep their size, angle and ink, only positions move.
    expect(word(after, 0, 6)).toEqual(word(before, 0, 6));
    expect(word(after, 10, 10)).toEqual(word(before, 6, 10));
    const variants = (r: typeof before, from: number) => r.glyphs.slice(from).map((g) => g.variantIndex);
    const changed = variants(after, 10).filter((v, i) => v !== variants(before, 6)[i]).length;
    // At most the next occurrence of a letter the new word also uses may change.
    expect(changed).toBeLessThanOrEqual(2);
  });

  it("an edit never sets off a chain of changes along the page", () => {
    let counter = 1;
    const fresh = () => (counter++ * 2654435761) >>> 0;
    const oldText = "una tarta de queso que esta muy rica y tiene nata ".repeat(8);
    const oldIds = Array.from({ length: oldText.length }, fresh);
    for (let trial = 0; trial < 20; trial++) {
      const at = 5 + trial;
      const newText = oldText.slice(0, at) + "e" + oldText.slice(at);
      const newIds = updateCharIds(oldText, oldIds, newText, fresh);
      const before = layoutText(oldText, hand, A4, nat, 3, oldIds).glyphs.map((g) => g.variantIndex);
      const after = layoutText(newText, hand, A4, nat, 3, newIds).glyphs.map((g) => g.variantIndex);
      const glyphsBefore = [...oldText.slice(0, at)].filter((c) => hand.glyphs[c]).length;
      let changed = 0;
      for (let i = glyphsBefore; i < before.length; i++) if (before[i] !== after[i + 1]) changed++;
      // Only the next couple of the same letter may change, never the rest of the page.
      expect(changed).toBeLessThanOrEqual(3);
    }
  });

  it("the typing animation renews only the edited word", () => {
    expect(editedWordRange("hola mundo", "hola munxdo")).toEqual({ start: 5, end: 11 });
    expect(editedWordRange("ab cd", "ab  cd")).toEqual({ start: 3, end: 6 });
  });

  it("maps glyph points onto the page with y growing downwards", () => {
    const glyph = { char: "a", variantIndex: 0, page: 0, xMm: 50, yMm: 100, scale: 1, rotation: 0, shear: 0, offsetX: 0, seed: 1, index: 0, widthMm: 1, bold: false, style: 0 };
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
        if (key === "lineSlope") {
          expect(Math.abs(values[key])).toBeLessThanOrEqual(1);
        } else if (key === "inkSkips") {
          expect(values[key]).toBe(0);
        } else if (key === "slantDegrees") {
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

const documentDefaults = {
  penId: "gel-07",
  inkColor: "#22399a",
  penTuning: { widthScale: 1, inkStrength: 1 },
  page: A4,
  presetId: "normal",
  naturalness: presetById("normal").values,
  seed: 42,
  paper: { kind: "blank" as const, lineSpacingMm: 8, marginLine: false, print: true },
  titleUnderline: true,
  naturalnessAmount: 1,
  leftHanded: false,
};

describe("documents", () => {
  const defaults = {
    penId: "gel-07",
    inkColor: "#22399a",
    penTuning: { widthScale: 1, inkStrength: 1 },
    page: A4,
    presetId: "normal",
    naturalness: presetById("normal").values,
    seed: 42,
    paper: { kind: "blank" as const, lineSpacingMm: 8, marginLine: false, print: true },
    titleUnderline: true,
    naturalnessAmount: 1,
    leftHanded: false,
  };

  it("keeps letter identities exactly", () => {
    const ids = [0, 1, 0xffffffff, 123456789, 2654435761];
    expect(decodeIds(encodeIds(ids))).toEqual(ids);
    expect(decodeIds(encodeIds([]))).toEqual([]);
  });

  it("round-trips text, identities and settings", () => {
    const doc = {
      text: "Querida Marta:\n\n¿Cuándo vienes?",
      charIds: Array.from({ length: 31 }, (_, i) => (i * 2654435761) >>> 0),
      marks: Array.from({ length: 31 }, (_, i) => withRunStyle(i % 5 === 0 ? BOLD | UNDERLINE : 0, i < 7 ? 1 : i > 20 ? 2 : 0)),
      paragraphs: [encodeParagraph({ style: "title", align: "center" }), 0, 0],
      runStyles: [{ penId: "marker-medium", color: "#b42128" }, { size: 2 }],
      settings: { ...defaults, penId: "fineliner", seed: 7, page: { ...A4, xHeightMm: 4 }, paper: { ...defaults.paper, kind: "lined" as const } },
    };
    expect(doc.text.length).toBe(31);
    expect(parseDocument(serializeDocument(doc), defaults)).toEqual(doc);
  });

  it("does not save run styles no letter uses", () => {
    const doc = {
      text: "abc",
      charIds: [1, 2, 3],
      marks: [withRunStyle(0, 2), 0, withRunStyle(0, 2)],
      paragraphs: [0],
      runStyles: [{ penId: "marker-medium" }, { color: "#b42128" }],
      settings: defaults,
    };
    const back = parseDocument(serializeDocument(doc), defaults);
    expect(back.runStyles).toEqual([{ color: "#b42128" }]);
    expect(back.marks.map(runStyleIndex)).toEqual([1, 0, 1]);
  });

  it("fills settings an older file does not have", () => {
    const old = JSON.stringify({ format: "chirographum-document", version: 1, text: "hola", settings: { penId: "gel-05", naturalness: { rotation: 0.9 } } });
    const doc = parseDocument(old, defaults);
    expect(doc.settings.penId).toBe("gel-05");
    expect(doc.settings.naturalness.rotation).toBe(0.9);
    expect(doc.settings.naturalness.lineSlope).toBe(0);
    expect(doc.settings.page).toEqual(A4);
    expect(doc.charIds).toEqual([]);
    expect(doc.marks).toEqual([0, 0, 0, 0]);
    expect(doc.paragraphs).toEqual([0]);
    expect(doc.settings.paper.kind).toBe("blank");
  });

  it("rejects files that are not documents", () => {
    expect(() => parseDocument("{", defaults)).toThrow(DocumentFormatError);
    expect(() => parseDocument(JSON.stringify({ format: "chirographum-hand" }), defaults)).toThrow(DocumentFormatError);
    expect(() => parseDocument(JSON.stringify({ format: "chirographum-document", version: 99, text: "" }), defaults)).toThrow(DocumentFormatError);
  });

  it("shows the file name without folder or extension", () => {
    expect(documentTitle("C:\\Users\\andre\\Carta a Marta.chiro")).toBe("Carta a Marta");
    expect(documentTitle(null)).toBeNull();
  });
});

describe("formatting", () => {
  const title = encodeParagraph({ style: "title", align: "center" });
  const normal = encodeParagraph({ style: "normal", align: "left" });

  it("typed letters take the marks at the cursor; the rest keep theirs", () => {
    expect(updateMarks("hola", [0, BOLD, BOLD, 0], "hoXla", BOLD)).toEqual([0, BOLD, BOLD, BOLD, 0]);
    expect(updateMarks("hola", [0, BOLD, BOLD, 0], "ha", 0)).toEqual([0, 0]);
  });

  it("Enter at the end of a title continues with normal text", () => {
    expect(updateParagraphs("Título", [title], "Título\n")).toEqual([title, normal]);
  });

  it("Enter inside a title keeps both halves as title", () => {
    expect(updateParagraphs("Título", [title], "Tít\nulo")).toEqual([title, title]);
  });

  it("joining two paragraphs keeps the first one's format", () => {
    expect(updateParagraphs("Título\nTexto", [title, normal], "TítuloTexto")).toEqual([title]);
    expect(updateParagraphs("uno\ndos\ntres", [normal, title, normal], "uno\ndos\ntres!")).toEqual([normal, title, normal]);
  });

  it("toggles marks on a range and reads them back", () => {
    let marks = [0, 0, 0, 0, 0];
    marks = setMark(marks, 0, 5, UNDERLINE, true);
    expect(rangeHasMark("ab cd", marks, 0, 5, UNDERLINE)).toBe(true);
    marks = setMark(marks, 0, 2, UNDERLINE, false);
    expect(rangeHasMark("ab cd", marks, 0, 5, UNDERLINE)).toBe(false);
    marks = setMark(marks, 3, 5, HIGHLIGHT, true, 2);
    expect(highlightColorIndex(marks[4])).toBe(2);
    expect(decodeBytes(encodeBytes(marks))).toEqual(marks);
    expect(decodeParagraph(title)).toEqual({ style: "title", align: "center" });
  });
});

describe("styled layout", () => {
  const hand = syntheticHand("unodstrecaiflhvzTíu");
  const nat = { ...presetById("normal").values, marginDrift: 0, lineDrift: 0, lineSlope: 0 };
  const center = encodeParagraph({ style: "title", align: "center" });
  const normal = encodeParagraph({ style: "normal", align: "left" });

  it("titles are bigger and centred, the text below is normal", () => {
    const text = "Título\nuno dos tres";
    const r = layoutText(text, hand, A4, nat, 3, undefined, { paragraphs: [center, normal] });
    const titleGlyphs = r.glyphs.filter((g) => g.index < 6);
    const bodyGlyphs = r.glyphs.filter((g) => g.index > 6);
    const avg = (gs: typeof r.glyphs) => gs.reduce((s, g) => s + g.scale, 0) / gs.length;
    expect(avg(titleGlyphs)).toBeGreaterThan(avg(bodyGlyphs) * 1.6);
    const left = Math.min(...titleGlyphs.map((g) => g.xMm));
    const right = Math.max(...titleGlyphs.map((g) => g.xMm + g.widthMm));
    const middle = (A4.marginLeftMm + A4.widthMm - A4.marginRightMm) / 2;
    expect(Math.abs((left + right) / 2 - middle)).toBeLessThan(0.5);
    expect(bodyGlyphs[0].xMm).toBeCloseTo(A4.marginLeftMm, 5);
  });

  it("underline and highlighter become one stroke per line, without the spaces at the ends", () => {
    const text = "uno dos tres";
    const marks = Array.from(text, (_, i) => (i >= 4 ? UNDERLINE | HIGHLIGHT : 0));
    const r = layoutText(text, hand, A4, nat, 3, undefined, { marks });
    expect(r.decorations.map((d) => d.kind).sort()).toEqual(["highlight", "underline"]);
    const u = r.decorations.find((d) => d.kind === "underline")!;
    expect(u.x0).toBeCloseTo(r.carets[4].xMm, 5);
    expect(u.x1).toBeGreaterThan(r.carets[11].xMm);
  });

  it("a scribble covers only its word, and a coloured word gets its own underline", () => {
    const text = "uno dos tres";
    let marks: number[] = Array.from(text, (_, i) => (i >= 4 && i < 7 ? SCRIBBLE : UNDERLINE));
    let runStyles: { color?: string }[] = [];
    ({ marks, styles: runStyles } = applyRunStyle(marks, runStyles, 8, 12, { color: "#b42128" }));
    const r = layoutText(text, hand, A4, nat, 3, undefined, { marks, runStyles });
    const scribbles = r.decorations.filter((d) => d.kind === "scribble");
    expect(scribbles).toHaveLength(1);
    expect(scribbles[0].x0).toBeCloseTo(r.carets[4].xMm, 5);
    expect(scribbles[0].x1).toBeLessThan(r.carets[8].xMm);
    const underlines = r.decorations.filter((d) => d.kind === "underline");
    expect(underlines.map((d) => d.style)).toEqual([0, 1]);
    expect(underlines[0].x1).toBeLessThan(r.carets[4].xMm);
    expect(underlines[1].x0).toBeCloseTo(r.carets[8].xMm, 5);
  });

  it("on lined paper every baseline sits on a line", () => {
    const paper = { kind: "lined" as const, lineSpacingMm: 8, marginLine: false, print: true };
    const r = layoutText("uno dos tres cuatro cinco ".repeat(30), hand, A4, nat, 3, undefined, { paper });
    const lines = new Set(r.carets.map((c) => c.line));
    for (const line of lines) {
      const stop = r.carets.find((c) => c.line === line)!;
      const k = (stop.yMm - 20) / 8;
      expect(Math.abs(k - Math.round(k))).toBeLessThan(0.15);
    }
  });
});

describe("run styles (instrument, colour and size of a selection)", () => {
  const hand = syntheticHand("unodstrecaiflhvz");
  const nat = { ...presetById("normal").values, sizeVariation: 0 };

  it("applies to the range only and reuses equal styles", () => {
    let marks = [BOLD, 0, 0, 0, 0];
    let styles: { penId?: string; color?: string; size?: number }[] = [];
    ({ marks, styles } = applyRunStyle(marks, styles, 1, 3, { color: "#b42128" }));
    expect(marks.map(runStyleIndex)).toEqual([0, 1, 1, 0, 0]);
    expect(marks[0] & BOLD).toBe(BOLD);
    ({ marks, styles } = applyRunStyle(marks, styles, 3, 5, { color: "#b42128" }));
    expect(styles).toHaveLength(1);
    ({ marks, styles } = applyRunStyle(marks, styles, 1, 2, { size: 2 }));
    expect(styles[runStyleIndex(marks[1]) - 1]).toEqual({ color: "#b42128", size: 2 });
    // Back to the document's: no style at all.
    ({ marks, styles } = applyRunStyle(marks, styles, 0, 5, { color: undefined, size: 1 }));
    expect(marks.map(runStyleIndex)).toEqual([0, 0, 0, 0, 0]);
    expect(compactRunStyles(marks, styles).styles).toEqual([]);
  });

  it("bigger letters for a selected word only, and more room for its line", () => {
    const text = "uno dos tres\ncuatro";
    const plain = layoutText(text, hand, A4, nat, 1);
    const { marks, styles } = applyRunStyle(new Array(text.length).fill(0), [], 4, 7, { size: 2 });
    const big = layoutText(text, hand, A4, nat, 1, undefined, { marks, runStyles: styles });
    const scale = (r: typeof plain, i: number) => r.glyphs.find((g) => g.index === i)!.scale;
    expect(scale(big, 5) / scale(plain, 5)).toBeCloseTo(2, 5);
    expect(scale(big, 0)).toBeCloseTo(scale(plain, 0), 5);
    const secondLine = (r: typeof plain) => r.glyphs.find((g) => g.index === 13)!.yMm;
    expect(secondLine(big)).toBeGreaterThan(secondLine(plain));
  });

  it("old documents keep their highlighter colour", () => {
    const old = (2 << 5) | 16;
    expect(highlightColorIndex(upgradeMarkV1(old))).toBe(2);
    expect(upgradeMarkV1(old) & HIGHLIGHT).toBe(HIGHLIGHT);
  });
});

describe("scribbles", () => {
  const area = { x0: 20, x1: 45, y0: 50, y1: 50.4, xhMm: 2.8, seed: 99 };
  const inkLength = (strokes: { x: number; y: number }[][]) =>
    strokes.reduce((sum, s) => sum + s.slice(1).reduce((l, p, i) => l + Math.hypot(p.x - s[i].x, p.y - s[i].y), 0), 0);

  it("every kind covers the word and stays near its line", () => {
    for (const kind of SCRIBBLE_KINDS) {
      for (const rage of [0, 0.5, 1]) {
        const strokes = scribbleStrokes(area, { kind, rage, width: 1, perWord: false });
        const points = strokes.flat();
        expect(points.length).toBeGreaterThan(10);
        for (const p of points) {
          expect(Number.isFinite(p.x) && Number.isFinite(p.y) && p.p > 0).toBe(true);
          expect(p.y).toBeGreaterThan(50 - 3 * 2.8);
          expect(p.y).toBeLessThan(50.4 + 1.5 * 2.8);
        }
        const xs = points.map((p) => p.x);
        expect(Math.min(...xs)).toBeLessThan(area.x0 + 1);
        expect(Math.max(...xs)).toBeGreaterThan(area.x1 - 1);
      }
    }
  });

  it("more rage, more ink", () => {
    for (const kind of SCRIBBLE_KINDS) {
      const calm = inkLength(scribbleStrokes(area, { kind, rage: 0, width: 1, perWord: false }));
      const angry = inkLength(scribbleStrokes(area, { kind, rage: 1, width: 1, perWord: false }));
      expect(angry).toBeGreaterThan(calm * 1.3);
    }
  });

  it("a cross is drawn with the pen lifted between lines", () => {
    expect(scribbleStrokes(area, { kind: "cross", rage: 0, width: 1, perWord: false })).toHaveLength(2);
  });

  it("word by word ends at every space; in one go it spans the words", () => {
    const hand = syntheticHand("unodstrecaiflhvz");
    const nat = { ...presetById("normal").values, sizeVariation: 0 };
    const text = "uno dos tres";
    const all = new Array(text.length).fill(SCRIBBLE);
    const together = layoutText(text, hand, A4, nat, 3, undefined, { marks: all });
    expect(together.decorations.filter((d) => d.kind === "scribble")).toHaveLength(1);
    const { marks, styles } = applyRunStyle(all, [], 0, text.length, scribbleFields({ ...scribbleStyleOf(undefined), perWord: true }));
    const apart = layoutText(text, hand, A4, nat, 3, undefined, { marks, runStyles: styles });
    expect(apart.decorations.filter((d) => d.kind === "scribble")).toHaveLength(3);
  });

  it("only what differs from the default look is kept, and documents keep it", () => {
    const { styles } = applyRunStyle([0, 0], [], 0, 2, scribbleFields({ kind: "zigzag", rage: 0.5, width: 1, perWord: false }));
    expect(styles).toEqual([]);
    const loops = applyRunStyle([SCRIBBLE, SCRIBBLE], [], 0, 2, scribbleFields({ kind: "loops", rage: 0.9, width: 1.5, perWord: true }));
    expect(loops.styles).toEqual([{ scribbleKind: "loops", scribbleRage: 0.9, scribbleWidth: 1.5, scribbleWords: true }]);
    const doc = { text: "ab", charIds: [1, 2], marks: loops.marks, paragraphs: [0], runStyles: loops.styles, settings: { ...documentDefaults } };
    const back = parseDocument(serializeDocument(doc), documentDefaults);
    expect(scribbleStyleOf(back.runStyles[0])).toEqual({ kind: "loops", rage: 0.9, width: 1.5, perWord: true });
    const damaged = parseDocument(JSON.stringify({ format: "chirographum-document", version: 1, text: "ab", runStyles: [7, { scribbleKind: "nope", scribbleRage: 9 }] }), documentDefaults);
    expect(damaged.runStyles).toEqual([{}, { scribbleRage: 1 }]);
  });
});

describe("highlighter", () => {
  const hand = syntheticHand("unodstrecaiflhvz");
  const nat = { ...presetById("normal").values, sizeVariation: 0 };
  const text = "uno dos tres";

  it("a change of colour starts a new stroke", () => {
    const marks = Array.from(text, (_, i) => withHighlightColor(HIGHLIGHT, i < 8 ? 0 : 2));
    const r = layoutText(text, hand, A4, nat, 3, undefined, { marks });
    const strokes = r.decorations.filter((d) => d.kind === "highlight");
    expect(strokes.map((d) => d.color)).toEqual([0, 2]);
  });

  it("word by word lifts the highlighter at every space", () => {
    const { marks, styles } = applyRunStyle(new Array(text.length).fill(HIGHLIGHT), [], 0, text.length, { highlightWords: true });
    const r = layoutText(text, hand, A4, nat, 3, undefined, { marks, runStyles: styles });
    expect(r.decorations.filter((d) => d.kind === "highlight")).toHaveLength(3);
  });
});

describe("unusual values on sliders", () => {
  it("usual, then a short yellow stretch, then red, on both sides", () => {
    const usual: [number, number] = [2, 5];
    expect(sliderZone(3, usual, 0.8)).toBe("usual");
    expect(sliderZone(5.5, usual, 0.8)).toBe("caution");
    expect(sliderZone(6, usual, 0.8)).toBe("excess");
    expect(sliderZone(1.5, usual, 0.8)).toBe("caution");
    expect(sliderZone(1, usual, 0.8)).toBe("excess");
    expect(sliderZone(100, undefined, 0.8)).toBe("usual");
  });
});
