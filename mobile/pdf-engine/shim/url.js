// SHIM 3 of 5 — `node:url`.
//
// Why: server/pdf-record.js locates its four vendored assets with
//   const asset = (p) => fileURLToPath(new URL(`../assets/${p}`, import.meta.url));
// `URL` a browser already has; `fileURLToPath` it does not.
//
// This is deliberately the whole of the shim — the path it produces is never
// touched by a real filesystem. It is a KEY, and the only thing that matters
// is that it is the same key shim/fs.js embedded the asset under. Both derive
// it from the same rule, so `assets/fonts/DejaVuSans.ttf` resolves against the
// synthetic import.meta.url the build defines and arrives at
// `/pdf-engine/assets/fonts/DejaVuSans.ttf`, which is precisely what the
// virtual filesystem has.
export function fileURLToPath(url) {
  const href = typeof url === 'string' ? url : url.href;
  if (!href.startsWith('file://')) throw new TypeError(`not a file URL: ${href}`);
  return decodeURIComponent(href.slice('file://'.length));
}

export function pathToFileURL(path) {
  return new URL(`file://${path}`);
}

export default { fileURLToPath, pathToFileURL };
