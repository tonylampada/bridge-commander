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
  retireLieutenant: (id) => j('DELETE', '/api/lieutenants/' + encodeURIComponent(id), { actor: 'user' }),
  createCard: (card) => j('POST', '/api/cards', Object.assign({ actor: 'user' }, card)),
  // A captain move may come back as {ordered: 'start-order'|'rework-order'}
  // instead of an applied move — any→working and review→backlog are orders.
  // `text` rides on the order QueueItem as the captain's comment.
  moveCard: (id, column, text) => j('POST', '/api/cards/' + encodeURIComponent(id) + '/move',
    Object.assign({ column, actor: 'user' }, text ? { text } : {})),
  patchCard: (id, patch) => j('PATCH', '/api/cards/' + encodeURIComponent(id), patch),
  archiveCard: (id, reason) => j('POST', '/api/cards/' + encodeURIComponent(id) + '/archive', { actor: 'user', reason }),
  feedback: (target, text, attachments) => j('POST', '/api/feedback',
    Object.assign({ target, text }, attachments && attachments.length ? { attachments } : {})),
  // upload a File → {id, uri, name, mime, size}. base64 is the zero-dep transport.
  uploadAttachment: (file) => new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('could not read ' + (file.name || 'file')));
    fr.onload = () => {
      const s = String(fr.result);
      const i = s.indexOf(',');
      const dataBase64 = i >= 0 ? s.slice(i + 1) : s; // strip the data:...;base64, prefix
      j('POST', '/api/attachments', {
        name: file.name || 'file', mime: file.type || 'application/octet-stream', dataBase64,
      }).then(resolve, reject);
    };
    fr.readAsDataURL(file);
  }),
  addArtifact: (id, uri, label) => j('POST', '/api/cards/' + encodeURIComponent(id) + '/artifacts',
    Object.assign({ uri, actor: 'user' }, label ? { label } : {})),
  removeArtifact: (id, uri) => j('DELETE', '/api/cards/' + encodeURIComponent(id) + '/artifacts', { uri, actor: 'user' }),
  markNotifRead: (seqs) => j('POST', '/api/notifications/read', { user: 'user', seqs }),
  markAllNotifRead: () => j('POST', '/api/notifications/read', { user: 'user', all: true }),
  markThreadRead: (target) => j('POST', '/api/read', { user: 'user', target }),
  labels: (body) => j('POST', '/api/labels', body),
  artifact: (uri) => j('GET', '/api/artifact?uri=' + encodeURIComponent(uri)),
  board: () => j('GET', '/api/board'),
  config: () => j('GET', '/api/config'),
  status: () => j('GET', '/api/status'),
};
