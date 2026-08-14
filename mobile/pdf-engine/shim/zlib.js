// SHIM 2 of 5 — `zlib`.
//
// Why: PDFKit deflates every content, font and image stream
// (`zlib.deflateSync`), and png-js inflates the IDAT of an embedded signature
// image. A browser exposes neither.
//
// Why pako, and why byte-identity holds: pako is a direct JavaScript port of
// zlib's own deflate/inflate, and its defaults are zlib's defaults — level 6
// (Z_DEFAULT_COMPRESSION), windowBits 15, memLevel 8, Z_DEFAULT_STRATEGY —
// which are exactly what `zlib.deflateSync(buf)` uses in Node with no options.
// Same algorithm, same parameters, same output; the golden test in
// test/pdf-engine-golden.test.js is what actually holds us to that, over a
// fixture carrying ten flate streams and a PNG.
//
// Options are honoured rather than ignored: nothing in this renderer passes
// any today, but a shim that silently dropped a `level` would produce a
// plausible PDF that no longer matched the archive.
import pako from 'pako';
import { Buffer } from 'buffer';

const options = (opts = {}) => {
  const out = {};
  if (opts.level != null) out.level = opts.level;
  if (opts.windowBits != null) out.windowBits = opts.windowBits;
  if (opts.memLevel != null) out.memLevel = opts.memLevel;
  if (opts.strategy != null) out.strategy = opts.strategy;
  if (opts.dictionary != null) out.dictionary = opts.dictionary;
  return out;
};

export function deflateSync(data, opts) {
  return Buffer.from(pako.deflate(data, options(opts)));
}

export function inflateSync(data, opts) {
  return Buffer.from(pako.inflate(data, options(opts)));
}

export function deflateRawSync(data, opts) {
  return Buffer.from(pako.deflateRaw(data, options(opts)));
}

export function inflateRawSync(data, opts) {
  return Buffer.from(pako.inflateRaw(data, options(opts)));
}

// The CALLBACK forms, and the one place in this shim where getting the answer
// right is not enough — it has to arrive at the right TIME.
//
// png-js inflates a PNG's pixel data through `zlib.inflate(data, cb)`, and on
// the server that callback lands a turn later, off libuv's threadpool. PDFKit
// writes the image object from inside it, so on the server the image lands at
// the END of the document, after everything drawn after doc.image() and after
// doc.end(). Answering synchronously here would write that object into the
// middle of the file instead: same content, every subsequent byte offset
// moved, and a preview that no longer matches the record byte for byte.
//
// So the callback is deferred, exactly as Node defers it. A microtask is
// enough: the whole render up to doc.end() is synchronous, so anything queued
// here necessarily runs after it, and before any timer the host might have
// pending.
const defer = (fn) => queueMicrotask(fn);

export function inflate(data, opts, callback) {
  const cb = typeof opts === 'function' ? opts : callback;
  defer(() => {
    try { cb(null, inflateSync(data, typeof opts === 'function' ? undefined : opts)); }
    catch (err) { cb(err); }
  });
}

export function deflate(data, opts, callback) {
  const cb = typeof opts === 'function' ? opts : callback;
  defer(() => {
    try { cb(null, deflateSync(data, typeof opts === 'function' ? undefined : opts)); }
    catch (err) { cb(err); }
  });
}

export default {
  deflate, inflate,
  deflateSync, inflateSync, deflateRawSync, inflateRawSync
};
