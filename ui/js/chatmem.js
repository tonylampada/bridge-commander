// chatmem.js — which chat was open, remembered across reloads.
// Its own module (not part of chat.js) for the same reason panekeys.js is:
// chat.js grabs DOM nodes at import time, this is pure, and pure is what a
// unit test can import. The localStorage calls themselves live in chat.js.
//
// The stored value says WHAT was open, not just an id:
//   'lieutenant:<id>' — a lieutenant's main chat
//   'card:<id>'       — a card's thread
//   'none'            — the captain closed the chat on purpose (mobile board tab)
// absent = he never chose, so the board's own default stands.

export const CHAT_KEY = 'bc-chat-open'; // bc- prefixed like bc-board-mode
export const CLOSED = 'none';

// What to write for the open chat. null = nothing worth remembering, remove
// the key (an unknown mode or a missing id is junk, not a memory).
export function encodeChat(open) {
  if (!open || !open.id) return null;
  if (open.mode !== 'lieutenant' && open.mode !== 'card') return null;
  return open.mode + ':' + open.id;
}

// What to reopen on load, from the raw stored string and location.hash:
//   {mode, id} — reopen that chat
//   'closed'   — reopen nothing; he closed it
//   null       — no usable memory; leave the default alone
// A hash is a deep link: someone opening a link meant that link, not what was
// open last time, so it wins over anything stored.
// Existence is NOT checked here — the board doc has not landed yet at restore
// time. A chat whose card was archived or whose lieutenant is gone is dropped
// by ensureChatMode() (chat.js), which then rewrites the key.
export function decodeChat(raw, hash) {
  if (hash && hash.length > 1) return null;
  if (raw === CLOSED) return 'closed';
  const m = /^(lieutenant|card):(.+)$/.exec(raw || '');
  return m ? { mode: m[1], id: m[2] } : null;
}
