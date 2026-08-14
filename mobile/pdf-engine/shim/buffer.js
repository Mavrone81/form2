// SHIM 1 of 5 — `Buffer`, as a global.
//
// Why: PDFKit and server/pdf-record.js both use `Buffer` as an ambient global
// (Buffer.from, Buffer.concat, buf.toString('latin1'/'hex'), buf.copy, …). A
// browser has no such global, so esbuild `inject`s this module and rewrites
// every free `Buffer` reference to the binding exported here.
//
// Why THIS implementation: feross/buffer is the polyfill browserify and
// webpack have shipped for a decade — a Uint8Array subclass with Node's exact
// encoding semantics, including the latin1 and hex round-trips this renderer
// leans on to lay out a PDF's byte offsets. A hand-rolled substitute would be
// the single most likely place for a one-byte divergence from the server, and
// the golden test would only tell us THAT it diverged, not why.
import { Buffer } from 'buffer';

export { Buffer };
