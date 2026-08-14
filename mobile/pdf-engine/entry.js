// The bundle's single entry point.
//
// It imports the SERVER's renderer — not a copy of it — so the offline preview
// the Android app draws is produced by the same code, from the same shared
// sheet-layout rules, as the archival record the server files. That identity
// is asserted byte-for-byte by test/pdf-engine-golden.test.js.
//
// Everything Node-specific that renderer touches is supplied by the shims in
// ./shim, wired up in build.mjs. Nothing here is mobile-specific logic: this
// file exists only to name the export, to hand back plain bytes, and to make
// sure the promise it returns always settles.
import { renderRecordPdf } from '../../server/pdf-record.js';
import { onDeferredError } from './shim/deferred.js';

/**
 * Render a submission to an archival PDF/A-2u document, entirely offline.
 *
 * @param {object|string} input - the same object server/pdf-record.js takes
 *   ({ form, submission, snapshot, values, signatures, grid, … }), or that
 *   object as a JSON string — which is what actually crosses a WebView
 *   boundary, so it is accepted directly rather than making every caller
 *   remember to parse first.
 * @returns {Promise<Uint8Array>} the PDF bytes. Rejects — always eventually
 *   settles — if the record cannot be drawn, including when the failure
 *   happens on a later turn inside an image decode. A preview that cannot be
 *   produced must say so; a promise that never settles is a spinner that turns
 *   for ever, which tells the technician nothing.
 */
async function render(input) {
  const record = typeof input === 'string' ? JSON.parse(input) : input;

  // The renderer streams its bytes out, so a failure raised after doc.end() —
  // a corrupt PNG rethrown from png-js's inflate callback is the real case —
  // leaves that stream unfinished and the promise below pending. shim/zlib.js
  // routes such throws here through shim/deferred.js; racing them makes the
  // render reject instead of hanging. The loser of the race is never returned
  // on its own, and Promise.race observes both, so a successful render leaves
  // no unhandled rejection behind.
  let failed;
  const deferredFailure = new Promise((_, reject) => { failed = reject; });
  const stopListening = onDeferredError(failed);
  try {
    const buffer = await Promise.race([renderRecordPdf(record), deferredFailure]);
    // A plain Uint8Array, copied out of the polyfilled Buffer: the caller is a
    // WebView bridge, and it must not be handed something whose prototype only
    // exists inside this bundle.
    return Uint8Array.from(buffer);
  } finally {
    stopListening();
  }
}

// `window` in the WebView the app loads harness.html into; the global object
// anywhere else, so the same bundle can be driven from a plain script context
// (which is how the golden test runs it).
const target = typeof window !== 'undefined' ? window : globalThis;
target.renderRecordPdf = render;
