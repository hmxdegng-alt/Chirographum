// Every character of the document has an identity (a random number) that
// decides how it is drawn. Editing keeps the identities of the characters
// that did not change, so the rest of the page keeps its exact look.

/** Identities after an edit: unchanged prefix and suffix keep theirs, new characters get fresh ones. */
export function updateCharIds(oldText: string, oldIds: number[], newText: string, fresh: () => number): number[] {
  const ids = oldIds.length === oldText.length ? oldIds : Array.from({ length: oldText.length }, fresh);
  const max = Math.min(oldText.length, newText.length);
  let prefix = 0;
  while (prefix < max && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    oldText.charCodeAt(oldText.length - 1 - suffix) === newText.charCodeAt(newText.length - 1 - suffix)
  ) {
    suffix++;
  }
  const inserted = newText.length - prefix - suffix;
  return [
    ...ids.slice(0, prefix),
    ...Array.from({ length: inserted }, fresh),
    ...ids.slice(ids.length - suffix),
  ];
}

/**
 * Range of the edit, widened to whole words: used by the optional typing
 * animation, which gives the edited word new identities on every key.
 */
export function editedWordRange(oldText: string, newText: string): { start: number; end: number } {
  const max = Math.min(oldText.length, newText.length);
  let prefix = 0;
  while (prefix < max && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && oldText.charCodeAt(oldText.length - 1 - suffix) === newText.charCodeAt(newText.length - 1 - suffix)) suffix++;
  let start = prefix;
  let end = newText.length - suffix;
  while (start > 0 && !/\s/.test(newText[start - 1])) start--;
  while (end < newText.length && !/\s/.test(newText[end])) end++;
  return { start, end };
}

export function randomCharId(): number {
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}
