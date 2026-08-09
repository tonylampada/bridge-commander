// server API — every captain-side write goes through here with actor "user"
async function j(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    // The status and the parsed body ride on the error: a 409 from the artifact
    // write carries what is on disk now, and the screen has to say so.
    let msg = 'HTTP ' + r.status, parsed = null;
    try { parsed = await r.json(); msg = parsed.error || msg; } catch (e) {}
    const err = new Error(msg);
    err.status = r.status;
    err.body = parsed;
    throw err;
  }
  return r.json();
}

// Who this tab is, for one purpose only: recognizing the echo of its own
// artifact write on the shared SSE stream, so the screen doesn't flash at itself.
// Per page load, thrown away with it — never persisted, never an identity.
const CLIENT_ID = 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36);

// Moves currently posted, by card id — see api.moveCard. The entry is dropped
// the moment the request settles, so the next drag on that card is a real move.
const movesInFlight = new Map();
function track(id, p) {
  const done = p.finally(() => movesInFlight.delete(id));
  movesInFlight.set(id, done);
  return done;
}

export const api = {
  clientId: CLIENT_ID,
  createLieutenant: (lt) => j('POST', '/api/lieutenants', Object.assign({ actor: 'user' }, lt)),
  updateLieutenant: (id, patch) => j('PATCH', '/api/lieutenants/' + encodeURIComponent(id), patch),
  retireLieutenant: (id) => j('DELETE', '/api/lieutenants/' + encodeURIComponent(id), { actor: 'user' }),
  createCard: (card) => j('POST', '/api/cards', Object.assign({ actor: 'user' }, card)),
  // A captain move may come back as {ordered: 'start-order'|'rework-order'}
  // instead of an applied move — any→working and review→backlog are orders.
  // `text` rides on the order QueueItem as the captain's comment.
  //
  // One move per card in flight. The board only redraws when the move's SSE
  // broadcast arrives, so until then the card sits visibly where it was — and a
  // second drag in that gap posted a second move. The duplicate rides the answer
  // of the move already going instead of issuing its own.
  moveCard: (id, column, text) => movesInFlight.get(id) || track(id,
    j('POST', '/api/cards/' + encodeURIComponent(id) + '/move',
      Object.assign({ column, actor: 'user' }, text ? { text } : {}))),
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
  // Write an artifact back. `version` is what the GET handed out (sha256 of the
  // content read); a stale one comes back 409 and nothing is written. `client`
  // comes back on the SSE `artifact` event as `by`, so this tab can tell its own
  // write from someone else's.
  saveArtifact: (uri, content, version) => j('PUT', '/api/artifact', { uri, content, version, client: CLIENT_ID }),
  board: () => j('GET', '/api/board'),
  // older main-chat history, off the lieutenant's append-only log: the board
  // payload carries only the newest slice, so scrolling up pages backwards from
  // the oldest message on screen. {messages: [...]} oldest-first; empty past the
  // beginning of the conversation.
  chatBefore: (target, before, limit) => j('GET', '/api/chat?target=' + encodeURIComponent(target)
    + '&before=' + encodeURIComponent(before) + '&limit=' + (limit || 50)),
  // archived (frozen) card snapshots, newest first, paged over the append-only
  // log: {archive: [...], total}; restore resurrects one
  archive: (limit, offset) => j('GET', '/api/archive?limit=' + (limit || 20) + '&offset=' + (offset || 0)),
  restoreCard: (id) => j('POST', '/api/cards/' + encodeURIComponent(id) + '/restore', { actor: 'user' }),
  config: () => j('GET', '/api/config'),
  // the playbooks a card can point at — read off disk server-side, so a
  // playbook added a second ago is in the next answer. Never cached here.
  playbooks: () => j('GET', '/api/playbooks'),
  // the registered projects, already ordered by live-card count. `git` asks the
  // server for the two reads off each clone (remote, default branch) — the
  // projects tab wants them, nothing else does, and nothing else pays for them.
  projects: (git) => j('GET', '/api/projects' + (git ? '?git=1' : '')),
  lieutenants: (live) => j('GET', '/api/lieutenants' + (live ? '?live=1' : '')),
  // slash commands the current chat target's harness answers (composer autocomplete)
  commands: (target) => j('GET', '/api/commands?target=' + encodeURIComponent(target)),
};
