"use strict";

// The "Chirographum documents" folder: where Ctrl+S saves a new document
// straight away, with a name taken from its first words.

const path = require("node:path");
const fs = require("node:fs/promises");

// The installer creates it in the user's Documents; the app creates it again if it is missing.
const DOCUMENTS_FOLDER_NAME = "Chirographum documents";
// Windows refuses these as file names, even with an extension.
const RESERVED_WINDOWS_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_FILE_BASE_LENGTH = 80;
const UNTITLED = "Sin título";

/** A name Windows accepts, from what the page suggests (the first words of the text). */
function safeFileBase(name) {
  const clean = String(name ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "")
    .slice(0, MAX_FILE_BASE_LENGTH)
    .replace(/[. ]+$/, "")
    .trim();
  return clean || UNTITLED;
}

/** The n-th name tried for a new file: "Carta", "Carta (2)", "Carta (3)"… (never a name Windows refuses). */
function candidateName(base, extension, n) {
  const first = RESERVED_WINDOWS_NAME.test(base) ? 2 : 1;
  const k = n + first - 1;
  return k === 1 ? `${base}.${extension}` : `${base} (${k}).${extension}`;
}

/** Writes a new file in the folder without ever replacing another; returns its path. */
async function writeNewFile(folder, base, extension, data) {
  for (let n = 1; n < 10000; n += 1) {
    const file = path.join(folder, candidateName(base, extension, n));
    try {
      await fs.writeFile(file, data, { encoding: "utf8", flag: "wx" });
      return file;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error("No free file name");
}

/** Creates the folder inside `documents` if it is missing; null when that is not possible. */
async function ensureFolder(documents) {
  const folder = path.join(documents, DOCUMENTS_FOLDER_NAME);
  try {
    await fs.mkdir(folder, { recursive: true });
    return folder;
  } catch {
    return null;
  }
}

module.exports = { DOCUMENTS_FOLDER_NAME, safeFileBase, candidateName, writeNewFile, ensureFolder };
