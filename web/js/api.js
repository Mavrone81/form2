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
  sign: (id, signaturePng) => call('POST', `/api/submissions/${id}/sign`, { signaturePng })
};
