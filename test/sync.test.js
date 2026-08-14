import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDb } from '../server/db.js';
import { createUser } from '../server/auth.js';
import { createApp } from '../server/index.js';
import { seedDemoUsers } from '../server/seed.js';
import { issueDeviceToken } from '../server/device-tokens.js';

// A 1x1 PNG data URI -- the same fixture used throughout test/workflow.test.js
// and test/api.test.js for a signature that passes assertValidSignature.
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

// A generic, invented form: one constrained field (Pass/Fail, mirroring the
// Calibration Record's Pass/Fail column) and one free-text field. Content is
// synthetic -- never real form text -- and is enough to exercise saveFields'
// option-validation without needing an xlsx workbook at all, since POST
// /api/sync never parses one.
function setupForm(db) {
  db.prepare(`insert into form_catalog (file_path,file_name,file_type,state)
    values ('/f.xlsx','f.xlsx','xlsx','ready')`).run();
  db.prepare(`insert into form_fields (form_id, field_key, label, section, kind, sort_order, source, options)
    values (1,'result','Generic check result','Section','text',0,'parsed','Pass\nFail'),
           (1,'remarks','Remarks','Section','text',1,'parsed','')`).run();
}

async function boot() {
  const db = openDb(':memory:');
  seedDemoUsers(db, { silent: true });
  const app = createApp({ db });
  const server = app.listen(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const call = async (method, path, body, headers) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(headers ?? {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { db, server, call };
}

// Demo users (server/seed.js) are inserted in a fixed order on a fresh db,
// but this looks them up by username rather than assuming ids 1..4, so a
// change to that seed order can never silently break these tests.
const userId = (db, username) => db.prepare('select id from users where username=?').get(username).id;
const authHeader = (token) => ({ authorization: `Bearer ${token}` });

test('happy path: one record creates a submission with fields, technician signature, and pending_lead state', async () => {
  const { db, server, call } = await boot();
  try {
    setupForm(db);
    const { token } = issueDeviceToken(db, userId(db, 'tech'));
    const uuid = randomUUID();

    const res = await call('POST', '/api/sync', {
      records: [{
        client_uuid: uuid, formId: 1, frequency: 'Y', machineId: 'ED04',
        values: { result: 'Pass', remarks: 'looks fine' },
        signaturePng: PNG, signedAtDevice: '2020-01-01T00:00:00Z'
      }]
    }, authHeader(token));

    assert.equal(res.status, 200);
    assert.equal(res.body.results.length, 1);
    const [r] = res.body.results;
    assert.equal(r.client_uuid, uuid);
    assert.equal(r.error, undefined);
    assert.equal(r.state, 'pending_lead');
    assert.ok(r.submissionId);

    const sub = db.prepare('select * from submissions where id=?').get(r.submissionId);
    assert.equal(sub.client_uuid, uuid);
    assert.equal(sub.machine_id, 'ED04');
    assert.equal(sub.frequency, 'Y');

    const values = db.prepare('select field_key, value from submission_fields where submission_id=?').all(r.submissionId);
    assert.ok(values.some((v) => v.field_key === 'result' && v.value === 'Pass'));
    assert.ok(values.some((v) => v.field_key === 'remarks' && v.value === 'looks fine'));

    const sigs = db.prepare('select * from signatures where submission_id=?').all(r.submissionId);
    assert.equal(sigs.length, 1);
    assert.equal(sigs[0].stage, 'technician');
  } finally {
    server.close();
  }
});

test('replaying the same batch is idempotent: same submissionId, still exactly one signature, no error', async () => {
  const { db, server, call } = await boot();
  try {
    setupForm(db);
    const { token } = issueDeviceToken(db, userId(db, 'tech'));
    const uuid = randomUUID();
    const body = {
      records: [{ client_uuid: uuid, formId: 1, frequency: 'Y', machineId: 'ED04', values: { result: 'Pass' }, signaturePng: PNG }]
    };

    const first = await call('POST', '/api/sync', body, authHeader(token));
    const second = await call('POST', '/api/sync', body, authHeader(token));

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(second.body.results[0].error, undefined);
    assert.equal(second.body.results[0].submissionId, first.body.results[0].submissionId);
    assert.equal(second.body.results[0].state, 'pending_lead');

    const sigs = db.prepare('select * from signatures where submission_id=?').all(first.body.results[0].submissionId);
    assert.equal(sigs.length, 1, 'a replayed batch must not produce a second signature');

    const rows = db.prepare('select count(*) n from submissions where client_uuid=?').get(uuid);
    assert.equal(rows.n, 1, 'a replayed batch must not create a second submission');
  } finally {
    server.close();
  }
});

test('two records where the second has an invalid option value: first succeeds, second reports INVALID, batch is 200', async () => {
  const { db, server, call } = await boot();
  try {
    setupForm(db);
    const { token } = issueDeviceToken(db, userId(db, 'tech'));

    const res = await call('POST', '/api/sync', {
      records: [
        { client_uuid: randomUUID(), formId: 1, values: { result: 'Pass' }, signaturePng: PNG },
        { client_uuid: randomUUID(), formId: 1, values: { result: 'Maybe' }, signaturePng: PNG }
      ]
    }, authHeader(token));

    assert.equal(res.status, 200, 'a per-record failure must never fail the whole batch');
    assert.equal(res.body.results.length, 2);

    const [good, bad] = res.body.results;
    assert.equal(good.error, undefined);
    assert.equal(good.state, 'pending_lead');

    assert.ok(bad.error);
    assert.equal(bad.error.code, 'INVALID');
    assert.match(bad.error.message, /must be one of/);
  } finally {
    server.close();
  }
});

test("a team leader's device token gets 403 for the whole route", async () => {
  const { db, server, call } = await boot();
  try {
    setupForm(db);
    const { token } = issueDeviceToken(db, userId(db, 'lead'));
    const res = await call('POST', '/api/sync', { records: [{ client_uuid: randomUUID(), formId: 1, values: {}, signaturePng: PNG }] }, authHeader(token));
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});

test('a signed-in session with no device token is refused with 401 -- sync is token-only', async () => {
  const { server, call } = await boot();
  try {
    const login = await call('POST', '/api/login', { username: 'tech', password: 'tech' });
    assert.equal(login.status, 200);
    // No Authorization header at all: the request rides only the session
    // cookie call() has been accumulating since the login above.
    const res = await call('POST', '/api/sync', { records: [] });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('no auth at all is refused with 401', async () => {
  const { server, call } = await boot();
  try {
    const res = await call('POST', '/api/sync', { records: [] });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('a signature that fails PNG validation is refused per-record', async () => {
  const { db, server, call } = await boot();
  try {
    setupForm(db);
    const { token } = issueDeviceToken(db, userId(db, 'tech'));
    const res = await call('POST', '/api/sync', {
      records: [{ client_uuid: randomUUID(), formId: 1, values: {}, signaturePng: 'not-a-png' }]
    }, authHeader(token));
    assert.equal(res.status, 200);
    const r = res.body.results[0];
    assert.ok(r.error);
    assert.match(r.error.message, /signature/i);
    // The submission was still created (create-or-find happens before
    // signing), so it must be visible for the app to retry with a real
    // signature on the next sync.
    assert.ok(r.submissionId);
    assert.equal(r.state, 'draft');
  } finally {
    server.close();
  }
});

test('a record for an unknown formId reports NOT_FOUND for that record only', async () => {
  const { db, server, call } = await boot();
  try {
    setupForm(db);
    const { token } = issueDeviceToken(db, userId(db, 'tech'));
    const res = await call('POST', '/api/sync', {
      records: [
        { client_uuid: randomUUID(), formId: 999999, values: {}, signaturePng: PNG },
        { client_uuid: randomUUID(), formId: 1, values: { result: 'Pass' }, signaturePng: PNG }
      ]
    }, authHeader(token));
    assert.equal(res.status, 200);
    const [missing, ok] = res.body.results;
    assert.ok(missing.error);
    assert.equal(missing.error.code, 'NOT_FOUND');
    assert.equal(missing.submissionId, null);
    assert.equal(ok.error, undefined);
    assert.equal(ok.state, 'pending_lead');
  } finally {
    server.close();
  }
});

test('a non-uuid client_uuid is rejected as INVALID, per-record', async () => {
  const { db, server, call } = await boot();
  try {
    setupForm(db);
    const { token } = issueDeviceToken(db, userId(db, 'tech'));
    const res = await call('POST', '/api/sync', {
      records: [{ client_uuid: 'not-a-real-uuid', formId: 1, values: {}, signaturePng: PNG }]
    }, authHeader(token));
    assert.equal(res.status, 200);
    assert.equal(res.body.results[0].error.code, 'INVALID');
    assert.equal(res.body.results[0].submissionId, null);
  } finally {
    server.close();
  }
});

test('a client_uuid belonging to a different user reports FORBIDDEN without revealing its state', async () => {
  const { db, server, call } = await boot();
  try {
    setupForm(db);
    const owner = userId(db, 'tech');
    const stranger = createUser(db, { username: 'tech2', password: 'p', fullName: 'Tech Two', role: 'technician' });
    const { token: ownerToken } = issueDeviceToken(db, owner);
    const { token: strangerToken } = issueDeviceToken(db, stranger.id);
    const uuid = randomUUID();

    // The owner fully creates and signs the record first.
    const created = await call('POST', '/api/sync', {
      records: [{ client_uuid: uuid, formId: 1, values: { result: 'Pass' }, signaturePng: PNG }]
    }, authHeader(ownerToken));
    assert.equal(created.body.results[0].error, undefined);

    // A different technician later syncs a record carrying the SAME uuid
    // (e.g. a uuid collision, or a client bug) -- must never see it.
    const res = await call('POST', '/api/sync', {
      records: [{ client_uuid: uuid, formId: 1, values: { result: 'Fail' }, signaturePng: PNG }]
    }, authHeader(strangerToken));

    assert.equal(res.status, 200);
    const r = res.body.results[0];
    assert.ok(r.error);
    assert.equal(r.error.code, 'FORBIDDEN');
    assert.equal(r.submissionId, null, "the stranger's response must not reveal the owner's submissionId");
    assert.equal(r.state, null, "the stranger's response must not reveal the owner's state");

    // And the owner's record is completely untouched by the attempt.
    const sub = db.prepare('select * from submissions where client_uuid=?').get(uuid);
    assert.equal(sub.created_by, owner);
    assert.equal(sub.state, 'pending_lead');
    const values = db.prepare('select value from submission_fields where submission_id=? and field_key=?').get(sub.id, 'result');
    assert.equal(values.value, 'Pass', "the stranger's attempt must not have overwritten the owner's field value");
  } finally {
    server.close();
  }
});

test('a repeat sync of an already-advanced record reports its state with no error and does not re-sign', async () => {
  const { db, server, call } = await boot();
  try {
    setupForm(db);
    const { token } = issueDeviceToken(db, userId(db, 'tech'));
    const uuid = randomUUID();
    const first = await call('POST', '/api/sync', {
      records: [{ client_uuid: uuid, formId: 1, values: { result: 'Pass' }, signaturePng: PNG }]
    }, authHeader(token));
    const submissionId = first.body.results[0].submissionId;

    // The lead advances it further, off-device, between the two syncs.
    const leadRes = await call('POST', '/api/login', { username: 'lead', password: 'lead' });
    assert.equal(leadRes.status, 200);
    const sign = await call('POST', `/api/submissions/${submissionId}/sign`, { signaturePng: PNG });
    assert.equal(sign.status, 200);
    assert.equal(sign.body.state, 'pending_engineer');

    // The device, unaware of that, replays its original batch again.
    const replay = await call('POST', '/api/sync', {
      records: [{ client_uuid: uuid, formId: 1, values: { result: 'Fail' }, signaturePng: PNG }]
    }, authHeader(token));
    assert.equal(replay.status, 200);
    const r = replay.body.results[0];
    assert.equal(r.error, undefined);
    assert.equal(r.submissionId, submissionId);
    assert.equal(r.state, 'pending_engineer', 'must report the CURRENT state, not silently re-sign or re-save');

    // The lead's signature is still the only team_leader signature, and the
    // field value the replay tried to overwrite (Fail) was never applied.
    const sigs = db.prepare("select * from signatures where submission_id=? and stage='team_leader'").all(submissionId);
    assert.equal(sigs.length, 1);
    const value = db.prepare('select value from submission_fields where submission_id=? and field_key=?').get(submissionId, 'result');
    assert.equal(value.value, 'Pass');
  } finally {
    server.close();
  }
});
