// SHIM 4 of 5 — `node:fs`, as a read-only virtual filesystem.
//
// Why: this is the ONLY filesystem touchpoint in the whole renderer, and it is
// entirely static. server/pdf-record.js reads three vendored DejaVu TTFs and
// our sRGB profile through its `asset()` helper; PDFKit reads the same font
// paths back when `registerFont` is handed a string, and reads one Adobe
// metrics file for the standard font it initialises itself with. Every one of
// those files is known at BUILD time, so the build embeds them as base64
// (see the `assets` plugin in build.mjs) and this module hands them back.
//
// Shimming here rather than in pdf-record.js is what keeps the server file
// untouched: the app and the server run the same source, so there is no
// "mobile variant" of the renderer that could drift from the archival one.
//
// An unknown path THROWS, loudly and by name. The alternative — returning
// empty bytes — would produce a PDF that renders but is missing a font, and
// the whole point of this engine is that the preview is the record.
import { ASSETS } from 'pdf-engine:assets';
import { Buffer } from 'buffer';

const files = new Map();
for (const [path, base64] of Object.entries(ASSETS)) files.set(path, Buffer.from(base64, 'base64'));

export function readFileSync(path, options) {
  const file = files.get(String(path));
  if (!file) {
    throw new Error(
      `pdf-engine: "${path}" is not an embedded asset. Every file this renderer reads must be ` +
      'listed in build.mjs and baked into the bundle — see mobile/pdf-engine/build.mjs.'
    );
  }
  const encoding = typeof options === 'string' ? options : options?.encoding;
  return encoding ? file.toString(encoding) : file;
}

export function existsSync(path) {
  return files.has(String(path));
}

export function statSync(path) {
  if (!files.has(String(path))) throw new Error(`pdf-engine: no embedded asset "${path}"`);
  return { size: files.get(String(path)).length, birthtime: new Date(0), ctime: new Date(0) };
}

export default { readFileSync, existsSync, statSync };
