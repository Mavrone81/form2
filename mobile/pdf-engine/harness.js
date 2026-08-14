// The doorway between the Android app and the bundled renderer.
//
// A separate file rather than an inline <script> so harness.html survives a
// strict `script-src 'self'` Content-Security-Policy: an inline block would
// need 'unsafe-inline' or a nonce, and the app should not have to weaken its
// policy to render a preview. See harness.html for the message protocol.

(() => {
  'use strict';

  const status = document.getElementById('status');

  // Belt and braces. entry.js already guarantees its promise settles — a
  // deferred image-decode failure rejects rather than hanging (shim/deferred.js)
  // — but this page is the last thing between a technician and a spinner, and
  // a bound this generous can only ever fire on a render that has genuinely
  // stopped. It is not a substitute for the fix, it is the floor under it.
  const RENDER_TIMEOUT_MS = 30000;

  // btoa() takes a string, and a whole record's worth of bytes handed over in
  // one apply() overflows the argument list. 12288 is well under the ~125k
  // arguments where WebView stacks start throwing RangeError, and a multiple
  // of 3 so no chunk boundary falls mid-quantum and introduces padding in the
  // middle of the result.
  const CHUNK = 12288;

  function toBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  // A page loaded from app assets has no meaningful origin: `file://` and
  // Android's asset loader both report the origin of a message from this very
  // window as '' or 'null' depending on the engine. Those, and our own origin
  // when the host serves the page over a real scheme (WebViewAssetLoader's
  // https://appassets.androidplatform.net/), are the only senders accepted —
  // so a page that somehow ends up embedded elsewhere cannot ask this engine
  // to render a record and read the result back.
  function isTrustedOrigin(origin) {
    return origin === '' || origin === 'null' || origin === location.origin;
  }

  // Replies are addressed to the sender rather than broadcast with '*',
  // because the reply carries the whole record — signatories' names and their
  // signature ink. The WebView hosts no third-party frames, so this is cheap
  // insurance rather than a load-bearing boundary, but the PDF is not
  // something to post to whoever happens to be listening.
  const SELF_TARGET = location.origin && location.origin !== 'null' ? location.origin : '*';

  function reply(message, source, origin) {
    const json = JSON.stringify(message);
    try { source?.postMessage(message, origin || '*'); } catch { /* no sender, or a closed one */ }
    try { window.PdfEngine?.postMessage(json); } catch { /* no Flutter channel bound */ }
    try { window.postMessage(message, SELF_TARGET); } catch { /* nothing listening here */ }
  }

  function safeParse(text) {
    try { return JSON.parse(text); } catch { return null; }
  }

  function withTimeout(promise, ms) {
    let timer;
    return Promise.race([
      promise.finally(() => clearTimeout(timer)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`render did not finish within ${ms} ms`)), ms);
      })
    ]);
  }

  window.addEventListener('message', async (event) => {
    if (!isTrustedOrigin(event.origin)) return;
    const data = typeof event.data === 'string' ? safeParse(event.data) : event.data;
    if (!data || data.type !== 'render') return;

    const id = data.id ?? null;
    try {
      status.textContent = 'rendering…';
      const bytes = await withTimeout(window.renderRecordPdf(data.record), RENDER_TIMEOUT_MS);
      status.textContent = `rendered ${bytes.length} bytes`;
      reply({ type: 'rendered', id, pdf: toBase64(bytes), bytes: bytes.length }, event.source, event.origin);
    } catch (err) {
      const message = String((err && err.message) || err);
      status.textContent = `error: ${message}`;
      reply({ type: 'error', id, message }, event.source, event.origin);
    }
  });

  const loaded = typeof window.renderRecordPdf === 'function';
  status.textContent = loaded ? 'ready' : 'dist/pdf-engine.js did not load — run `node build.mjs`';
  if (loaded) reply({ type: 'ready' });
})();
