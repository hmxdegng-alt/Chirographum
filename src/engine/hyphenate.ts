// Where a Spanish word may be split at the end of a line, the way people
// learn it at school: between syllables, never leaving a single letter on
// either side and never between two vowels (RAE: "aho-ra", not "a-hora";
// hiatus are not split). Digraphs ch, ll, rr and the "qu"/"gu" before e or i
// stay together; pairs like pr, bl or tr go with the next syllable.

const VOWEL = /[aeiouáéíóúü]/;
const LETTER = /[a-záéíóúüñ]/;
/** Consonant pairs that always start a syllable together (Spain: "at-le-ta"). */
const ONSETS = new Set(["pl", "pr", "bl", "br", "cl", "cr", "dr", "fl", "fr", "gl", "gr", "kl", "kr", "tr"]);
/** Fewest letters left on each side of a split. */
const MIN_SIDE = 2;

interface Unit {
  /** Index of the unit's first letter in the word. */
  at: number;
  text: string;
  vowel: boolean;
}

/** Letters grouped into sounds: "ch", "ll", "rr", "qu"/"gu" before e/i count as one consonant. */
function units(word: string): Unit[] {
  const result: Unit[] = [];
  for (let i = 0; i < word.length; ) {
    const pair = word.slice(i, i + 2);
    const next = word[i + 2] ?? "";
    if (pair === "ch" || pair === "ll" || pair === "rr" || ((pair === "qu" || pair === "gu") && /[eiéí]/.test(next))) {
      result.push({ at: i, text: pair, vowel: false });
      i += 2;
      continue;
    }
    const c = word[i];
    // "y" is a vowel at the end of a word or before a consonant (rey, hoy, muy bien).
    const yVowel = c === "y" && i > 0 && (i === word.length - 1 || !VOWEL.test(word[i + 1]));
    result.push({ at: i, text: c, vowel: VOWEL.test(c) || yVowel });
    i += 1;
  }
  return result;
}

/** Syllable boundaries inside a run of consonants between two vowels: where the split goes. */
function splitConsonants(run: Unit[]): number {
  if (run.length === 1) return 0;
  const lastTwo = run.slice(-2).map((u) => u.text).join("");
  const onset = run[run.length - 2].text.length === 1 && run[run.length - 1].text.length === 1 && ONSETS.has(lastTwo);
  if (run.length === 2) return onset ? 0 : 1;
  if (run.length === 3) return onset ? 1 : 2;
  return 2;
}

/**
 * Positions where the word may be split (the index of the first letter of
 * the part that goes to the next line), from left to right. Only lowercase
 * Spanish words and capitalised ones; acronyms, numbers and anything with
 * symbols inside are never split. Punctuation at either end is fine.
 */
export function hyphenationPoints(word: string): number[] {
  // Leading and trailing punctuation ("¿casa?", "perro,") stays out of the count.
  let start = 0;
  let end = word.length;
  while (start < end && !/\p{L}/u.test(word[start])) start++;
  while (end > start && !/\p{L}/u.test(word[end - 1])) end--;
  const core = word.slice(start, end);
  if (core.length < MIN_SIDE * 2) return [];
  if (core.length > 1 && core === core.toUpperCase()) return [];
  const lower = core.toLowerCase();
  if (![...lower].every((c) => LETTER.test(c) || c === "y")) return [];
  const list = units(lower);
  const points: number[] = [];
  let k = 0;
  while (k < list.length && !list[k].vowel) k++;
  while (k < list.length) {
    // Past the vowels of this syllable…
    while (k < list.length && list[k].vowel) k++;
    const runStart = k;
    while (k < list.length && !list[k].vowel) k++;
    // …a run of consonants followed by another vowel: one boundary inside it.
    if (k < list.length && k > runStart) {
      const run = list.slice(runStart, k);
      points.push(run[splitConsonants(run)].at);
    }
  }
  return points.map((p) => p + start).filter((p) => p - start >= MIN_SIDE && end - p >= MIN_SIDE);
}

/** Splits a word as a person would at the end of a line: "pa-ra", "co-rrer", "ins-tan-te". */
export function syllabify(word: string): string[] {
  const parts: string[] = [];
  let from = 0;
  for (const p of hyphenationPoints(word)) {
    parts.push(word.slice(from, p));
    from = p;
  }
  parts.push(word.slice(from));
  return parts;
}
