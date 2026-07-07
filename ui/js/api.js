// server API — every captain-side write goes through here with actor "user"
async function j(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    let msg = 'HTTP ' + r.status;
    try { msg = (await r.json()).error || msg; } catch (e) {}
    throw new Error(msg);
  }
  return r.json();
}

export const api = {
  createLieutenant: (lt) => j('POST', '/api/lieutenants', Object.assign({ actor: 'user' }, lt)),
  createCard: (card) => j('POST', '/api/cards', Object.assign({ actor: 'user' }, card)),
  // A captain move may come back as {ordered: 'start-order'|'rework-order'}
  // instead of an applied move — backlog→working and review→backlog are orders.
  moveCard: (id, column) => j('POST', '/api/cards/' + encodeURIComponent(id) + '/move', { column, actor: 'user' }),
  patchCard: (id, patch) => j('PATCH', '/api/cards/' + encodeURIComponent(id), patch),
  archiveCard: (id, reason) => j('POST', '/api/cards/' + encodeURIComponent(id) + '/archive', { actor: 'user', reason }),
  feedback: (target, text) => j('POST', '/api/feedback', { target, text }),
  markNotifRead: (seqs) => j('POST', '/api/notifications/read', { user: 'user', seqs }),
  markAllNotifRead: () => j('POST', '/api/notifications/read', { user: 'user', all: true }),
  markThreadRead: (target) => j('POST', '/api/read', { user: 'user', target }),
  labels: (body) => j('POST', '/api/labels', body),
  artifact: (uri) => j('GET', '/api/artifact?uri=' + encodeURIComponent(uri)),
  config: () => j('GET', '/api/config'),
};
