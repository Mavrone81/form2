// The bundle's single entry point.
//
// It imports the SERVER's renderer — not a copy of it — so the offline preview
// the Android app draws is produced by the same code, from the same shared
// sheet-layout rules, as the archival record the server files. That identity
// is asserted byte-for-byte by test/pdf-engine-golden.test.js.
//
// Everything Node-specific that renderer touches is supplied by the five shims
// in ./shim, wired up in build.mjs. Nothing here is mobile-specific logic:
// this file exists only to name the export and to hand back plain bytes.
import { renderRecordPdf } from '../../server/pdf-record.js';

/**
 * Render a submission to an archival PDF/A-2u document, entirely offline.
 *
 * @param {object|string} input - the same object server/pdf-record.js takes
 *   ({ form, submission, snapshot, values, signatures, grid, … }), or that
 *   object as a JSON string — which is what actually crosses a WebView
 *   boundary, so it is accepted directly rather than making every caller
 *   remember to parse first.
 * @returns {Promise<Uint8Array>} the PDF bytes.
 */
async function render(input) {
  const record = typeof input === 'string' ? JSON.parse(input) : input;
  const buffer = await renderRecordPdf(record);
  // A plain Uint8Array, copied out of the polyfilled Buffer: the caller is a
  // WebView bridge, and it must not be handed something whose prototype only
  // exists inside this bundle.
  return Uint8Array.from(buffer);
}

// `window` in the WebView the app loads harness.html into; the global object
// anywhere else, so the same bundle can be driven from a plain script context
// (which is how the golden test runs it).
const target = typeof window !== 'undefined' ? window : globalThis;
target.renderRecordPdf = render;
