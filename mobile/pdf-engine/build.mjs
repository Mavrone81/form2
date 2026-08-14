#!/usr/bin/env node
//
// Bundles server/pdf-record.js into dist/pdf-engine.js: one self-contained
// browser script, no network, no filesystem, exposing
// `window.renderRecordPdf(input) -> Promise<Uint8Array>`.
//
//   npm install && node build.mjs        # production bundle (minified)
//   node build.mjs --dev                 # readable output + sourcemap
//
// This folder is its OWN npm project on purpose. The server keeps five runtime
// dependencies and no devDependencies; a bundler belongs to the mobile build,
// not to the thing that files controlled documents, so it lives here and the
// root package.json is never touched.
//
// The renderer itself is imported unmodified. Everything Node-shaped that it
// or PDFKit reaches for is redirected here, and each redirection is a file in
// ./shim carrying the reason it exists. The invariant the whole exercise
// rests on — that this bundle emits the SAME BYTES as the server — is not
// asserted by this script; it is asserted by test/pdf-engine-golden.test.js in
// the repo root, which renders one fixture through both and compares them.
import { readFileSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const dev = process.argv.includes('--dev');

// --- The synthetic filesystem --------------------------------------------
//
// server/pdf-record.js resolves its assets as
//   fileURLToPath(new URL(`../assets/${p}`, import.meta.url))
// so with import.meta.url defined below as a file: URL under /pdf-engine/,
// `fonts/DejaVuSans.ttf` becomes the key on the left. shim/url.js and
// shim/fs.js between them make that resolution land on the embedded bytes,
// which is why pdf-record.js needs no edit at all.
const PDF_RECORD_URL = 'file:///pdf-engine/server/pdf-record.js';
const PDFKIT_DIRNAME = '/pdf-engine/pdfkit';

const EMBED = [
  // The three vendored faces the record is set in, read back by PDFKit when
  // registerFont is handed one of these paths.
  ['/pdf-engine/assets/fonts/DejaVuSans.ttf', join(repo, 'assets/fonts/DejaVuSans.ttf')],
  ['/pdf-engine/assets/fonts/DejaVuSans-Bold.ttf', join(repo, 'assets/fonts/DejaVuSans-Bold.ttf')],
  ['/pdf-engine/assets/fonts/DejaVuSansMono.ttf', join(repo, 'assets/fonts/DejaVuSansMono.ttf')],
  // Our licence-tracked sRGB profile, read by pdf-record.js's
  // attachOutputIntent — the record's archival OutputIntent.
  ['/pdf-engine/assets/sRGB.icc', join(repo, 'assets/sRGB.icc')],
  // Not ours, and never drawn with: PDFKit's constructor initialises a default
  // font ('Helvetica') before pdf-record.js selects its own, and reads the
  // Adobe metrics for it on the way past. Omitting it does not make the
  // document smaller, it makes `new PDFDocument()` throw.
  [`${PDFKIT_DIRNAME}/data/Helvetica.afm`, join(repo, 'node_modules/pdfkit/js/data/Helvetica.afm')]
];

function embeddedAssets() {
  const assets = {};
  for (const [key, path] of EMBED) {
    try {
      assets[key] = readFileSync(path).toString('base64');
    } catch (err) {
      throw new Error(
        `cannot embed ${path}: ${err.message}\n` +
        'Run `npm install` in the repository root first — the bundle needs the ' +
        "server's own assets and PDFKit's font metrics."
      );
    }
  }
  return assets;
}

// esbuild has no notion of a generated module, so the asset table is served
// from a virtual one. Generating a file on disk instead would leave a 3 MB
// base64 blob sitting in the working tree for every build.
const assetsPlugin = (assets) => ({
  name: 'pdf-engine-assets',
  setup(build) {
    build.onResolve({ filter: /^pdf-engine:assets$/ }, (args) => ({ path: args.path, namespace: 'pdf-engine' }));
    build.onLoad({ filter: /.*/, namespace: 'pdf-engine' }, () => ({
      contents: `export const ASSETS = ${JSON.stringify(assets)};`,
      loader: 'js'
    }));
  }
});

// Node builtins, redirected to ./shim. A plugin rather than esbuild's `alias`
// option because the imports arrive under two spellings — pdf-record.js asks
// for `node:fs`, PDFKit's browser build asks for `fs` — and both must land on
// the same module instance or the virtual filesystem would exist twice.
// `browserify-zlib` is in the list because png-js's own browser build imports
// it by that name rather than asking for `zlib` — it must land on the same
// shim, or a second deflate implementation would decide how a signature image
// is compressed.
const BUILTINS = {
  fs: 'shim/fs.js',
  url: 'shim/url.js',
  zlib: 'shim/zlib.js',
  'browserify-zlib': 'shim/zlib.js',
  stream: 'shim/stream.js'
};

const BUILTIN_RE = /^(node:)?(fs|url|zlib|stream|browserify-zlib)$/;

const builtinsPlugin = {
  name: 'pdf-engine-builtins',
  setup(build) {
    build.onResolve({ filter: BUILTIN_RE }, (args) => ({
      path: join(here, BUILTINS[args.path.replace(/^node:/, '')])
    }));
  }
};

async function main() {
  const assets = embeddedAssets();
  mkdirSync(join(here, 'dist'), { recursive: true });
  const outfile = join(here, 'dist/pdf-engine.js');

  const result = await build({
    entryPoints: [join(here, 'entry.js')],
    outfile,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2020'],
    // PDFKit's browser build resolves its own assets against `__dirname`, and
    // pdf-record.js resolves ours against `import.meta.url`. Neither exists in
    // a browser, and neither needs to: both are only ever used to build a key
    // for the synthetic filesystem above.
    // `process` is erased so the bundle takes the BROWSER path everywhere,
    // including when the golden test runs it inside Node. js-md5 sniffs
    // `process.versions.node` and, finding it, would switch to a node-crypto
    // fast path that does not exist in a WebView — the test would then be
    // exercising code the app never runs. (The two produce the same digest;
    // the point is that the tested bundle and the shipped bundle are one
    // bundle. `this.process` on a restructure Struct is a property, not this
    // free identifier, and is untouched.)
    define: {
      __dirname: JSON.stringify(PDFKIT_DIRNAME),
      'import.meta.url': JSON.stringify(PDF_RECORD_URL),
      process: 'undefined',
      'process.env.NODE_ENV': '"production"'
    },
    // `Buffer` is used as a global by both PDFKit and pdf-record.js — see
    // shim/buffer.js for why it is feross/buffer and not something smaller.
    inject: [join(here, 'shim/buffer.js')],
    plugins: [assetsPlugin(assets), builtinsPlugin],
    minify: !dev,
    sourcemap: dev ? 'inline' : false,
    legalComments: 'none',
    logLevel: 'info',
    metafile: true
  });

  for (const warning of result.warnings) {
    console.warn(`warning: ${warning.text}`);
  }

  const bytes = statSync(outfile).size;
  console.log(`pdf-engine: ${outfile} — ${(bytes / 1024 / 1024).toFixed(2)} MB${dev ? ' (dev)' : ''}`);
  console.log(`            ${EMBED.length} assets embedded as base64`);
}

main().catch((err) => {
  console.error(`pdf-engine build failed: ${err.message}`);
  process.exit(1);
});
