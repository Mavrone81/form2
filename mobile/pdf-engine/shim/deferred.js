// Where deferred work sends the errors it cannot throw.
//
// shim/zlib.js hands png-js its inflated pixels a turn later, exactly as Node
// does (see the comment there). That means the code PDFKit runs from inside
// that callback — decoding a signature PNG, deflating it again, writing the
// image object — has no caller left to throw back to. Anything that goes wrong
// escapes into the host as a bare unhandled error, and renderRecordPdf's
// promise, which is waiting on a stream that will now never end, simply never
// settles.
//
// That is not a theoretical shape: a signature blob with a corrupt IDAT does
// it, and in the app it would read as a preview spinner that turns for ever.
// A render that cannot finish must FAIL, visibly, so the technician is told
// the record could not be drawn instead of being left to wait.
//
// So deferred work runs through here, and whatever it throws is reported to
// whoever is currently rendering (entry.js), which turns it into a rejection.

const handlers = new Set();

/**
 * Register a handler for errors thrown by deferred work. Returns a function
 * that removes it again — always call it, in a `finally`.
 *
 * Handlers are a set rather than a single slot so two overlapping renders both
 * fail rather than one of them hanging. Attribution between them is
 * best-effort: an error from one would reject both. That is the right trade —
 * a render that has already lost its image object is finished either way, and
 * the WebView drives one render at a time.
 */
export function onDeferredError(handler) {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

/**
 * Run `fn` on a later turn, routing anything it throws to the handlers above.
 */
export function deferred(fn) {
  queueMicrotask(() => {
    try {
      fn();
    } catch (err) {
      // Nobody rendering: rethrow, so the failure surfaces to the host as it
      // would have anyway rather than being swallowed here.
      if (!handlers.size) throw err;
      for (const handler of [...handlers]) handler(err);
    }
  });
}
