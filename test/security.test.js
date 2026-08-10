// Two audit findings, closed here.
//
// FINDING 1 — signature integrity. `signAndAdvance` accepted any truthy
// string as a signature, so a record could be "signed" with something that
// is not an image at all and the workflow would accept it as a valid
// sign-off. This is NOT an XSS hole: nothing on either side ever puts a
// signature anywhere but an <img src>, browsers do not execute
// `javascript:` there, and an SVG loaded through <img> is script-safe. The
// damage is to INTEGRITY. The entire purpose of these records is to attest
// that a named person signed them; a reviewer opening an approved document
// and finding a broken image where the sign-off should be has no way to
// tell an attack from a bug, and the record's claim is already worthless
// either way. So the rule is enforced where the value is STORED
// (server/workflow.js), not at the route, for the same reason assertCanEdit
// and saveFields live there: no future HTTP path can bypass it.
//
// FINDING 2 — response headers. Nothing carried nosniff, a CSP, or frame
// protection. The tests below pin the shape of the policy, not just its
// presence, because a CSP that forbids `data:` images would silently blank
// the form's embedded logo and every stored signature — a header that
// breaks the app is worse than no header at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createApp } from '../server/index.js';
import { seedDemoUsers } from '../server/seed.js';
import { createUser } from '../server/auth.js';
import { createSubmission, signAndAdvance } from '../server/workflow.js';

// The 8-byte PNG signature and nothing else. Already the fixture every other
// suite signs with, and it is a genuine PNG magic number, so the new rule
// accepts it and the existing happy paths are untouched.
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

// A real, complete 1x1 transparent PNG — header, IHDR, IDAT, IEND. Proves
// the rule accepts an actual image and not merely an 8-byte prefix.
const REAL_PNG = 'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// Declared image/png, decodes cleanly, but the bytes are GIF87a. A declared
// MIME type is a claim; the magic number is evidence.
const NOT_PNG_BYTES = 'data:image/png;base64,' + Buffer.from('GIF87a-not-a-png').toString('base64');

const SVG = 'data:image/svg+xml;base64,' +
  Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');

// Comfortably over the 1 MiB decoded cap, comfortably under the 4mb express
// body limit — so this must be refused by the signature rule with a 400,
// not by the body parser with a 413.
const OVERSIZED = 'data:image/png;base64,' + Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(2 * 1024 * 1024, 0x41)
]).toString('base64');

// --- unit level: the rule lives in workflow.js -----------------------------

function setup() {
  const db = openDb(':memory:');
  db.prepare(`insert into form_catalog (file_path,file_name,file_type,state)
    values ('/f.xlsx','f.xlsx','xlsx','ready')`).run();
  const users = {
    tech: createUser(db, { username: 't', password: 'p', fullName: 'Tech', role: 'technician' }),
    lead: createUser(db, { username: 'l', password: 'p', fullName: 'Lead', role: 'team_leader' })
  };
  const sub = createSubmission(db, { formId: 1, userId: users.tech.id, machineId: 'ED04', frequency: 'Y' });
  return { db, users, sub };
}

const stateOf = (db, id) => db.prepare('select state from submissions where id=?').get(id).state;
const signatureCount = (db, id) =>
  db.prepare('select count(*) c from signatures where submission_id=?').get(id).c;

const REJECTED_PAYLOADS = [
  ['a javascript: URL', 'javascript:alert(document.cookie)'],
  ['a bare string', 'signed by me'],
  ['an SVG data URI', SVG],
  ['a PNG-declared payload whose bytes are not PNG', NOT_PNG_BYTES],
  ['a data URI with no base64 marker', 'data:image/png,iVBORw0KGgo='],
  ['base64 that does not decode cleanly', 'data:image/png;base64,!!!!not base64!!!!'],
  ['an empty base64 payload', 'data:image/png;base64,'],
  ['a truncated magic number', 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e]).toString('base64')],
  ['an oversized payload', OVERSIZED],
  ['a number instead of a string', 12345]
];

for (const [what, payload] of REJECTED_PAYLOADS) {
  test(`signAndAdvance refuses ${what} and the record does not advance`, () => {
    const { db, users, sub } = setup();
    assert.throws(
      () => signAndAdvance(db, { submissionId: sub.id, user: users.tech, signaturePng: payload }),
      /signature/i
    );
    assert.equal(stateOf(db, sub.id), 'draft', 'the record must not advance');
    assert.equal(signatureCount(db, sub.id), 0, 'no signature row may be written');
  });
}

// Captures the thrown error without a try/catch whose own assert.fail would
// be swallowed by the catch block — the first draft of the FORBIDDEN test
// below did exactly that and PASSED against the unfixed code, because an
// AssertionError also has a `code` that is not 'FORBIDDEN'. Returning the
// error instead of asserting inside the catch makes "it did not throw at
// all" a distinct, visible failure.
function thrownBy(fn) {
  try { fn(); } catch (err) { return err; }
  return null;
}

test('a bad signature is an input failure, not a permission one', () => {
  const { db, users, sub } = setup();
  // Same distinction the missing-signature case already makes, so the sign
  // route's existing statusFor(err, 400) fallback maps it to 400 rather than
  // to a 403 that would tell an operator their role was wrong.
  const err = thrownBy(() =>
    signAndAdvance(db, { submissionId: sub.id, user: users.tech, signaturePng: 'javascript:alert(1)' }));
  assert.ok(err, 'expected signAndAdvance to throw');
  assert.notEqual(err.code, 'FORBIDDEN');
  assert.notEqual(err.code, 'NOT_FOUND');
});

test('a genuine PNG is accepted and the record advances', () => {
  const { db, users, sub } = setup();
  assert.equal(signAndAdvance(db, { submissionId: sub.id, user: users.tech, signaturePng: REAL_PNG }).state, 'pending_lead');
  assert.equal(signatureCount(db, sub.id), 1);
  // Stored verbatim — never silently coerced or repaired into something the
  // signer did not draw.
  assert.equal(db.prepare('select image_png from signatures where submission_id=?').get(sub.id).image_png, REAL_PNG);
});

test('the existing minimal-PNG fixture every other suite uses is still accepted', () => {
  const { db, users, sub } = setup();
  assert.equal(signAndAdvance(db, { submissionId: sub.id, user: users.tech, signaturePng: PNG }).state, 'pending_lead');
});

test('permission is still checked before the signature is even looked at', () => {
  // A reviewer who does not own this stage must be refused as FORBIDDEN,
  // and a bad signature must not downgrade that to a 400 — otherwise the
  // new rule would become a way to probe stage ownership.
  const { db, users, sub } = setup();
  const err = thrownBy(() =>
    signAndAdvance(db, { submissionId: sub.id, user: users.lead, signaturePng: REAL_PNG }));
  assert.ok(err, 'expected signAndAdvance to throw');
  assert.equal(err.code, 'FORBIDDEN');
});

// --- HTTP level: the route maps it to 400 ---------------------------------

async function boot() {
  const db = openDb(':memory:');
  seedDemoUsers(db, { silent: true });
  db.prepare(`insert into form_catalog (file_path,file_name,file_type,state)
    values ('/f.xlsx','f.xlsx','xlsx','ready')`).run();
  const server = createApp({ db }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const raw = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return res;
  };
  const call = async (method, path, body) => {
    const res = await raw(method, path, body);
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  };
  return { db, server, call, raw };
}

test('POST /sign refuses every non-PNG payload with 400 and leaves the record alone', async () => {
  const { db, server, call } = await boot();
  try {
    await call('POST', '/api/login', { username: 'tech', password: 'tech' });
    for (const [what, payload] of REJECTED_PAYLOADS) {
      const sub = (await call('POST', '/api/submissions', { formId: 1 })).body;
      const res = await call('POST', `/api/submissions/${sub.id}/sign`, { signaturePng: payload });
      assert.equal(res.status, 400, `${what} must be a 400, not ${res.status}`);
      assert.match(res.body.error, /signature/i, `${what} must say so in plain words`);
      assert.equal(stateOf(db, sub.id), 'draft', `${what} must not advance the record`);
      assert.equal(signatureCount(db, sub.id), 0, `${what} must not leave a signature row`);
    }
  } finally { server.close(); }
});

test('POST /sign still accepts a real PNG and advances the record', async () => {
  const { db, server, call } = await boot();
  try {
    await call('POST', '/api/login', { username: 'tech', password: 'tech' });
    const sub = (await call('POST', '/api/submissions', { formId: 1 })).body;
    const res = await call('POST', `/api/submissions/${sub.id}/sign`, { signaturePng: REAL_PNG });
    assert.equal(res.status, 200);
    assert.equal(res.body.state, 'pending_lead');
    assert.equal(stateOf(db, sub.id), 'pending_lead');
    assert.equal(signatureCount(db, sub.id), 1);
  } finally { server.close(); }
});

// --- FINDING 2: response headers ------------------------------------------

const cspDirectives = (header) => {
  const map = new Map();
  for (const part of header.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) map.set(name.toLowerCase(), values);
  }
  return map;
};

test('every response carries nosniff, a CSP and frame-ancestors self', async () => {
  const { server, call, raw } = await boot();
  try {
    // An API JSON response, an unauthenticated 401, and a static asset —
    // the headers must not depend on which branch answered.
    const probes = [
      await raw('GET', '/api/me'),
      await raw('GET', '/api/forms'), // 401
      await raw('GET', '/index.html'),
      await raw('GET', '/js/app.js'),
      await raw('GET', '/css/app.css')
    ];
    for (const res of probes) {
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff',
        `${res.url} must forbid MIME sniffing`);
      const csp = res.headers.get('content-security-policy');
      assert.ok(csp, `${res.url} must carry a CSP`);
      assert.deepEqual(cspDirectives(csp).get('frame-ancestors'), ["'self'"],
        `${res.url} must allow only same-origin framing`);
    }
    await call('POST', '/api/login', { username: 'admin', password: 'admin' });
  } finally { server.close(); }
});

test('the CSP fits this app: no inline script, but data: images and same-origin frames', async () => {
  const { server, raw } = await boot();
  try {
    const csp = (await raw('GET', '/index.html')).headers.get('content-security-policy');
    const d = cspDirectives(csp);

    // The form's embedded company logo and every stored signature are
    // rendered as `data:` URIs (web/js/form-view.js bandLogo, and the
    // signature <img> in web/js/field-panel.js). Forbid `data:` here and
    // both silently disappear from a quality record.
    const imgSrc = d.get('img-src') ?? d.get('default-src');
    assert.ok(imgSrc.includes('data:'), 'img-src must allow data: URIs');
    assert.ok(imgSrc.includes("'self'"), 'img-src must allow the app\'s own images');

    // The app frames its OWN xlsx/pdf endpoint (web/js/admin.js mapper,
    // web/js/form-view.js pdf preview), so a blanket DENY would break the
    // preview. Same-origin only.
    assert.deepEqual(d.get('frame-ancestors'), ["'self'"]);
    assert.deepEqual(d.get('frame-src'), ["'self'"]);

    // No-build app: it serves its own ES modules and its own stylesheet and
    // has no inline script at all. Keep it that way — 'unsafe-inline' or
    // 'unsafe-eval' in script-src would give up the only real protection a
    // CSP offers here.
    const scriptSrc = d.get('script-src');
    assert.deepEqual(scriptSrc, ["'self'"]);
    assert.ok(!csp.includes("'unsafe-eval'"), 'nothing in this app evaluates strings as code');

    // Nothing is fetched from anywhere else, and nothing may be.
    assert.deepEqual(d.get('default-src'), ["'self'"]);
    assert.deepEqual(d.get('object-src'), ["'none'"]);
  } finally { server.close(); }
});

test('the form-file endpoint, which streams raw xlsx and pdf bytes, is not sniffable', async () => {
  const { db, server, call, raw } = await boot();
  try {
    await call('POST', '/api/login', { username: 'admin', password: 'admin' });
    // The row points at a path that does not exist, so this 500s — the point
    // is that the header is present regardless of how the route answers.
    const res = await raw('GET', '/api/forms/1/file');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(res.headers.get('content-security-policy'));
    assert.ok(db);
  } finally { server.close(); }
});
