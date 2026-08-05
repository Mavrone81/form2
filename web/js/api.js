// Thin JSON API client. No framework, no bundler — a plain ES module the
// browser loads directly. Every call goes through `call()` so error handling
// (surface the server's own `error` message, never invent client wording for
// a server-side failure) lives in exactly one place.
async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data;
}

export const api = {
  me: () => call('GET', '/api/me'),
  login: (username, password) => call('POST', '/api/login', { username, password }),
  logout: () => call('POST', '/api/logout'),
  forms: () => call('GET', '/api/forms'),
  grid: (id) => call('GET', `/api/forms/${id}/grid`),
  // Deviation from the brief: the brief's fields(id, frequency) never sends
  // submissionId, so the server's `completeness` block (GET .../fields?
  // frequency=&submissionId=) could never be requested and the "warn, never
  // block" missing-tasks banner would be impossible to build. submissionId
  // is optional and additive — every existing call shape (id, frequency)
  // still works exactly as the brief specifies.
  fields: (id, frequency, submissionId) => {
    const q = new URLSearchParams({ frequency: frequency ?? '' });
    if (submissionId) q.set('submissionId', String(submissionId));
    return call('GET', `/api/forms/${id}/fields?${q.toString()}`);
  },
  createSubmission: (formId, machineId, frequency) => call('POST', '/api/submissions', { formId, machineId, frequency }),
  queue: () => call('GET', '/api/submissions'),
  submission: (id) => call('GET', `/api/submissions/${id}`),
  save: (id, values) => call('PATCH', `/api/submissions/${id}`, { values }),
  // The maintenance interval is part of the record, not a view setting: it
  // decides which tasks were in scope, so the reviewer, the completeness
  // warning and the archived PDF must all read the same stored value. Same
  // PATCH, same permission path (the server refuses it once the record has
  // left the technician's stage).
  setFrequency: (id, frequency) => call('PATCH', `/api/submissions/${id}`, { frequency }),
  sign: (id, signaturePng) => call('POST', `/api/submissions/${id}/sign`, { signaturePng }),
  // Send a record back to the technician for correction. The reason is
  // mandatory and the server enforces that (400 with its own message) — the
  // client checks first only so the technician is not sent a rejection with
  // nothing to act on, never as the actual rule.
  reject: (id, reason) => call('POST', `/api/submissions/${id}/reject`, { reason }),

  // ---- admin (Task 15) ----
  adminSettings: () => call('GET', '/api/admin/settings'),
  updateFormsFolder: (formsFolder) => call('PUT', '/api/admin/settings', { formsFolder }),
  rescan: () => call('POST', '/api/admin/rescan'),
  // GET /api/admin/users only ever selects id/username/full_name/role/active
  // (server/routes.js) — there is no sensitive credential column to strip
  // here, unlike createUser's raw insert result.
  users: () => call('GET', '/api/admin/users'),
  createUser: (username, password, fullName, role) =>
    call('POST', '/api/admin/users', { username, password, fullName, role }),
  updateUser: (id, patch) => call('PATCH', `/api/admin/users/${id}`, patch),
  // Reuses the existing /forms/:id/fields read path (built for the
  // technician's field panel) to seed the mapper with whatever admin-authored
  // fields already exist for this form, if any.
  formFields: (id) => call('GET', `/api/forms/${id}/fields?frequency=`),
  saveFormFields: (formId, fields) => call('PUT', `/api/admin/forms/${formId}/fields`, { fields }),
  // Not a JSON endpoint — the raw file is loaded directly as an <iframe src>,
  // so this is just a URL builder, not a fetch() wrapper like the rest of
  // this module.
  formFileUrl: (id) => `/api/forms/${id}/file`,

  // ---- record PDF (Task 18) ----
  // Also plain URL builders, not fetch() wrappers: a PDF response is binary,
  // so it must never be routed through call()'s `res.json()` parsing above.
  // The browser is left to do the actual GET itself (an <a href> for
  // preview/download), which — unlike a fetch() this module would have to
  // drive by hand — sends the session cookie automatically and lets the
  // server's own Content-Disposition header name the downloaded file.
  submissionPdfUrl: (id) => `/api/submissions/${id}/pdf`,
  submissionPdfDownloadUrl: (id) => `/api/submissions/${id}/pdf?download=1`
};
