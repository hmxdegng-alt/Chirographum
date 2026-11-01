# Chirographum — notes for working on the code

Desktop editor (Electron + Vite + TypeScript, no UI framework) that writes and prints text in the user's own handwriting. AGPL-3.0. Windows first.

## Rules that never change
- The app never touches the network: `electron/network-guard.cjs` (dead proxy, host resolver rules, webRequest filter, permissions, navigation lock). Do not add anything that downloads, updates or reports.
- Code and comments in English, comments only where they help. Every user-facing text in Spanish, in `src/i18n/es.ts`.
- Pens and pencils never get darker where strokes cross (tone mask merged with "lighten"); markers and highlighters do (stacked layers).
- A letter's look comes from its identity (`src/engine/char-ids.ts`), never from its position, so editing does not redraw the rest of the page.
- Hands (`.chmano`) and documents (`.chiro`) are separate files on purpose.

## Versions
`vX.Y.Z`: X = final release (0 until 1.0), Y = development phase, Z = builds within the phase. Bump `version` in package.json and package-lock.json (root and `packages[""]`). The owner publishes a GitHub release with the tag; `.github/workflows/build.yml` builds the Windows installer and attaches it.

## Map
- `electron/main.cjs` window, menus (Archivo, Editar, Formato, Ver), IPC, unsaved-changes prompt, single instance, `.chiro` opening; `electron/preload.cjs` → `window.chirographum` (types in `src/bridge.ts`).
- `src/engine/scribble.ts`: the five kinds of scribble (rayajos, rayas, ida y vuelta, cruz, bucles) modelled on the owner's sample sheet; "rabia" 0–1 sets how much ink. The toolbar menu draws its previews with the same code.
- `src/engine/` pure logic: `hand.ts`, `geometry.ts`, `layout.ts` (glyph placement, caret stops, pages, styles, alignment, decorations, ruled paper), `render.ts` (ink model, printed look, paper; one ink group per instrument + colour), `pens.ts`, `settings.ts`, `rich-text.ts` (marks and paragraph formats), `document.ts`, `char-ids.ts`, `random.ts`.
- Character marks are 32-bit: bits 0–5 flags (bold, italic, underline, strike, highlight, scribble), 6–8 highlighter colour, 9–16 run style = index+1 into `runStyles` (instrument, colour, size and scribble look of a selection; 0 = the defaults). Only the toolbar sets instrument and colour; the document's `penId`/`inkColor` are just the base for unstyled text and have no control of their own (choosing them stores no style). Documents store them as `marks32`; 0.1 files had one byte per letter (`marks`, read with `upgradeMarkV1`). Unused run styles are dropped on save.
- Paragraph styles and alignment are per paragraph on purpose (as in Docs/Word); size per selection covers "only these words bigger".
- `src/ui/`: `draw-view.ts` (Tu letra), `sheet-view.ts` (Hoja: state, undo, commands, output, the settings panel), `page-editor.ts` (hidden textarea + drawn caret), `toolbar.ts`, `ruler.ts`, `zoom.ts`, `color-picker.ts` (the app's own picker; Chromium's cannot be closed from the page), `document-controller.ts`.
- Settings panel: collapsible sections with a "Restablecer" button each, a search box (`data-search`, compared without accents through `searchKey`), and `slider({ defaultValue })` adds the ↺ reset. Every new setting needs a default to go back to, and a usual range (`USUAL` in `sheet-view.ts`, `slider({ usual, caution })`): past it the slider turns yellow, then red. Only a hint, never a limit.
- Sliders call `onInput` on release ("change"), never while dragging (redrawing the page there makes them stutter); `live` is for cheap previews only.
- Highlighter: one decoration per run of the same colour; render splits it into sweeps of 3–7 cm that restart a little behind (darker overlap). Square chisel ends by default (`StrokeGeometry.chisel`, drawn as one band with darker edges), round with `highlightRound`; a darker slice where the tip rests (more often at the end). Word by word (`highlightWords` in the run style) stops near each word. `nat.fingerprints` draws procedural fingertip prints near the edges in the page's main ink. `nat.highlighterSmear` × `pen.smear` drags ink; `nat.handSmudges` × 3 × `pen.smudge` (×3 and sideways for `leftHanded`; bigger and darker past 100 %) leaves hand smudges. Smudges and prints widen the box `renderPage` returns, so printing does not crop them.
- `build/installer.nsh`: uninstaller page with an unticked checkbox to delete `%APPDATA%\Chirographum`. electron-builder runs makensis with `-WX`: keep everything inside the macros.

## Checking work
- `npx tsc --noEmit -p .`, `npx vitest run`, `npx vite build`.
- End-to-end: end scripts with `process.exit` after killing Electron (a lingering connection keeps node alive), and kill leftovers with `pkill -f "[e]lectron/dist/electron"` in a shell call of its own (the brackets keep pkill from matching itself, but any other text in the same call that spells the path, e.g. a heredoc, gets the shell killed). Run the built app under `xvfb-run` and drive it with puppeteer-core through `--remote-debugging-port`. Test hooks (ignored in the installed app): `CHIROGRAPHUM_TEST_USER_DATA`, `CHIROGRAPHUM_TEST_PDF_PATH`, `CHIROGRAPHUM_TEST_SAVE_PATH`, `CHIROGRAPHUM_TEST_OPEN_PATH`, `CHIROGRAPHUM_TEST_UNSAVED_CHOICE`; `window.chirographumCommand(name)` runs menu commands; `window.chirographum.requestClose()` acts like the window's close button.
- The NSIS installer needs wine to build on Linux; let the GitHub workflow build it.
