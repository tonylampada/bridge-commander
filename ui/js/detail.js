// card detail: attributes header + markdown body + event timeline (chat lives in the chat panel)
import { S, card, lieutenant, lieutenants, lieutenantColor, cardStatus, cardActivityTs, cardRecency, kindEmoji, render, toggleFilter, filterSelected } from './state.js';
import { esc, hhmm, agoSpanHtml, cardEmoji, cardPrs, prChipHtml, cardArtifacts, artifactsHtml, uriBasename, setHtmlIfChanged, isImageMime } from './util.js';
import { md, mdEnhance, copyText } from './md.js';
import { api } from './api.js';
import { labelChipHtml, openLabelPicker, saveCardLabels } from './labels.js';
import { openCardThread, syncChatToMain } from './chat.js';
import { openFile, closeFile, fileKey, fileDirty, fileMerges, fileResolve, fileUpdate, fileNotice } from './filepane.js';
import { openMoveMenu } from './board.js';
import { archivedCard, unarchive } from './archive.js';

const isDesktop = () => window.innerWidth > 760; // matches the chat.js layout breakpoint

const el = document.getElementById('detail');
const titleEl = document.getElementById('dt-title');
const titleInput = document.getElementById('dt-title-input');
let editingTitle = false; // true while the inline title editor is open (guards re-render clobber)

export function openDetail(id) {
  S.openCardId = id;
  // Desktop: selecting a card also syncs the left chat into that card's thread,
  // so its detail (right) and conversation (left) show side by side. Reuses the
  // one thread-switch owner; silent = no mobile tab-flip / focus steal. Mobile
  // keeps the tab layout untouched (chat switches only via the talk button).
  if (isDesktop()) { openCardThread(id, { silent: true }); return; } // openCardThread renders
  render();
}
// Archived snapshots open in the SAME panel, read-only: no chat sync (there is
// no live thread target behind a frozen card — its thread shows inline instead).
export function openArchivedDetail(id) {
  S.openCardId = id;
  render();
}
// opts.keepChat: leave the chat on this card's thread instead of returning it
// to the lieutenant — for closing the panel on the way INTO the card's own
// file screen, where the conversation is still about this card.
export function closeDetail(opts) {
  const wasId = S.openCardId;
  S.openCardId = null;
  if (editingTitle) stopTitleEdit();
  if (editingBody) stopBodyEdit();
  el.hidden = true;
  // Desktop: closing a card-synced detail returns the left chat to the owning
  // lieutenant's main conversation rather than stranding it on the closed card.
  if (!(opts && opts.keepChat) && isDesktop() && wasId && S.chatMode && S.chatMode.mode === 'card' && S.chatMode.id === wasId) {
    syncChatToMain(); // renders
    return;
  }
  render();
}
export function detailOpen() { return !!S.openCardId; }

document.getElementById('dt-close').onclick = closeDetail;

// Click-outside dismiss (desktop side-panel only). On mobile the detail is
// full-screen (100vw), so there is no "outside" — the ✕ and Escape stay the only
// close affordances there. A click that lands outside #detail closes it, reusing
// the one closeDetail path (which also returns the left chat to the lieutenant on
// desktop). Excluded from "outside": the left chat pane (#chat — on desktop it
// shows the selected card's own thread, so it's part of the card context, not
// outside — and the lieutenant switcher dropdown lives inside it), a .tile (its
// own handler switches to that card's detail — a switch, not a close), the transient
// popovers (move menu, label picker, notif/settings panels) so dismissing one of
// those never also closes the detail, and the floating stop-speaking bubble
// (stopping TTS is not a navigation intent). Net effect: only a click on the
// BOARD area (columns / empty space) closes via click-outside.
// If a rename is in progress, commit it (like Enter/blur) before
// closing rather than discarding it: commitTitleEdit reads card(S.openCardId) so
// it must run before closeDetail nulls it, and it clears editingTitle so
// closeDetail's own stopTitleEdit is then a no-op — no double-fire.
document.addEventListener('click', (e) => {
  if (!S.openCardId || !isDesktop()) return;
  const t = e.target;
  // A click on a control that removed itself on the way out reaches document
  // with a DETACHED target: every closest() below then misses and the detail
  // closes as collateral. A node that is no longer in the page can't tell us
  // anything about where the click landed — ignore it.
  if (!t.isConnected) return;
  if (el.contains(t)) return;                 // inside the panel — stays open
  if (t.closest && (
    t.closest('#chat') ||                     // left chat = the selected card's thread; part of its context
    t.closest('.tile') ||                     // another card — switch, handled by its onclick
    t.closest('#table tbody tr') ||           // table/archive rows switch cards the same way
    t.closest('#archive tbody tr') ||
    t.closest('#lt-overlay') ||               // new-lieutenant modal
    t.closest('#move-menu') ||                // transient popovers dismiss on their own
    t.closest('#owner-menu') ||
    t.closest('#notif-panel') ||
    t.closest('#settings-panel') ||
    t.closest('#label-picker') ||
    t.closest('#av-overlay') ||               // artifact viewer sits above the detail
    t.closest('#mmd-overlay') ||              // fullscreen mermaid diagram overlay
    t.closest('.speech-transport') ||         // floating speech transport (and its buttons)
    t.closest('[data-label-add]')
  )) return;
  if (editingTitle) commitTitleEdit();        // save the in-progress rename first
  closeDetail();
});
document.getElementById('dt-talk').onclick = () => {
  if (S.openCardId) {
    const id = S.openCardId;
    // Desktop already shows the thread on the left (synced on select), so just
    // focus that thread — keep the detail open for the side-by-side view. Mobile
    // has no side-by-side, so switch the chat tab to the thread as before.
    if (isDesktop()) { openCardThread(id); return; }
    closeDetail();
    openCardThread(id);
  }
};
document.getElementById('dt-menu-btn').onclick = (e) => {
  e.stopPropagation();
  if (S.openCardId) {
    const r = e.target.getBoundingClientRect();
    openMoveMenu(S.openCardId, r.left, r.bottom + 4);
  }
};

// ---------- inline title rename ----------
function startTitleEdit() {
  const c = card(S.openCardId);
  if (!c || editingTitle) return;
  editingTitle = true;
  titleInput.value = c.title || c.id;
  titleEl.hidden = true;
  titleInput.hidden = false;
  titleInput.focus();
  titleInput.select();
}
function stopTitleEdit() {
  editingTitle = false;
  titleInput.hidden = true;
  titleEl.hidden = false;
}
async function commitTitleEdit() {
  if (!editingTitle) return;
  const c = card(S.openCardId);
  const to = titleInput.value.trim();
  stopTitleEdit();
  if (!c) return;
  if (!to || to === (c.title || '')) { render(); return; } // reject empty / no-op
  try { await api.patchCard(c.id, { title: to }); } // SSE board push repaints tile + detail live
  catch (e) { alert(e.message); render(); }
}
titleEl.onclick = startTitleEdit;
titleInput.onkeydown = (e) => {
  if (e.key === 'Enter') { e.preventDefault(); commitTitleEdit(); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stopTitleEdit(); render(); }
};
titleInput.onblur = commitTitleEdit;

// ---------- inline body (description) edit ----------
// Mirrors the title editor: an editingBody flag guards re-render clobber while
// the textarea is open; save persists through the same PATCH path as any body
// update, and the SSE board push repaints the rendered markdown live.
const bodyEl = document.getElementById('dt-body');
const bodyEditBtn = document.getElementById('dt-body-edit');
const bodyEditor = document.getElementById('dt-body-editor');
const bodyInput = document.getElementById('dt-body-input');
let editingBody = false;
function startBodyEdit() {
  const c = card(S.openCardId);
  if (!c || editingBody) return;
  editingBody = true;
  bodyInput.value = c.body || '';
  bodyEl.hidden = true;
  bodyEditBtn.hidden = true;
  bodyEditor.hidden = false;
  bodyInput.focus();
}
function stopBodyEdit() {
  editingBody = false;
  bodyEditor.hidden = true;
  bodyEl.hidden = false;
  bodyEditBtn.hidden = false;
}
async function commitBodyEdit() {
  if (!editingBody) return;
  const c = card(S.openCardId);
  const to = bodyInput.value;
  stopBodyEdit();
  if (!c || to === (c.body || '')) { render(); return; } // no-op
  try { await api.patchCard(c.id, { body: to }); }
  catch (e) { alert(e.message); render(); }
}
bodyEditBtn.onclick = startBodyEdit;
document.getElementById('dt-body-save').onclick = commitBodyEdit;
document.getElementById('dt-body-cancel').onclick = () => { stopBodyEdit(); render(); };
bodyInput.onkeydown = (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitBodyEdit(); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stopBodyEdit(); render(); }
};

// ---------- artifact viewer (popup) ----------
const avOverlay = document.getElementById('av-overlay');
const avModal = document.getElementById('av-modal');
const avName = document.getElementById('av-name');
const avBody = document.getElementById('av-body');
const avImgWrap = document.getElementById('av-img-wrap');
const avImg = document.getElementById('av-img');
const avVideoWrap = document.getElementById('av-video-wrap');
const avVideo = document.getElementById('av-video');
const avAudioWrap = document.getElementById('av-audio-wrap');
const avAudio = document.getElementById('av-audio');
const avFrame = document.getElementById('av-frame');
const avExpand = document.getElementById('av-expand');
const avDownload = document.getElementById('av-download');
const avSrcBtn = document.getElementById('av-src');
const avCopyBtn = document.getElementById('av-copy');
const avEditBtn = document.getElementById('av-edit');
const MD_EXT = /\.(md|markdown)$/i;
const HTML_EXT = /\.html?$/i;
const DRAW_EXT = /\.excalidraw$/i;
// Reset the shared overlay to a clean text-mode state (used by both openers).
function avReset(name, uri) {
  avName.textContent = name;
  avName.title = uri || name;
  avImgWrap.hidden = true;
  avImg.removeAttribute('src');
  avVideoWrap.hidden = true;
  avVideo.pause();
  avVideo.removeAttribute('src');
  avVideo.load(); // actually drop the previous stream (removeAttribute alone doesn't)
  avAudioWrap.hidden = true;
  avAudio.pause();
  avAudio.removeAttribute('src');
  avAudio.load(); // actually drop the previous stream (removeAttribute alone doesn't)
  avFrame.hidden = true;
  avFrame.removeAttribute('src'); // drop the previous page so it can't linger
  avBody.hidden = false;
  avBody.className = '';
  avDownload.hidden = true;
  avMd = null;
  avShowSrc = false;
  avSrcBtn.hidden = true;
  avSrcBtn.classList.remove('on');
  avText = null;
  avCopyBtn.hidden = true;
  avCopyBtn.textContent = '⧉';
  avCopyBtn.classList.remove('ok');
  avEditBtn.hidden = true;
  avEditable = null;
  avModal.classList.remove('expanded'); // each open starts at the default size
  avOverlay.hidden = false;
}
// Markdown preview with a rendered ⇄ source toggle (the </> button in the
// head). avMd holds the raw text while a markdown preview is up; the toggle
// re-renders in place, so it also survives expand/restore.
let avMd = null, avShowSrc = false;
// The full text source currently in the viewer (markdown or plain) — what the
// head ⧉ copies, regardless of the rendered ⇄ source toggle. Text-only: image /
// video / audio / iframe / download states never set it, so the button stays
// hidden there.
let avText = null;
function avCopyable(text) { avText = text; avCopyBtn.hidden = false; }
avCopyBtn.onclick = () => copyText(avText == null ? '' : avText).then((ok) => {
  avCopyBtn.textContent = ok ? '✓' : '✗';
  avCopyBtn.classList.toggle('ok', ok);
  setTimeout(() => { avCopyBtn.textContent = '⧉'; avCopyBtn.classList.remove('ok'); }, 1500);
});
function showMarkdown(text) {
  avMd = text;
  avSrcBtn.hidden = false;
  avCopyable(text);
  renderAvMd();
}
function renderAvMd() {
  avSrcBtn.classList.toggle('on', avShowSrc);
  if (avShowSrc) { avBody.className = ''; avBody.textContent = avMd; }
  else { avBody.className = 'md'; avBody.innerHTML = md(avMd); mdEnhance(avBody); }
}
avSrcBtn.onclick = () => { avShowSrc = !avShowSrc; renderAvMd(); };

// ---------- editing a text artifact ----------
// The viewer stays what it was born as: something you open and close in ten
// seconds. Editing is where you stay, so ✎ LEAVES the popup — it hands the file
// to the file screen (filepane.js), which takes the board's place with the chat
// still at its side. This module is the part that knows the file is a card
// artifact; the screen and the editor below it never learn that.
//
// Saving writes the file for real (PUT /api/artifact), carrying the version the
// GET handed out. Two things are kept per uri: the draft (so leaving the screen
// and coming back never loses typing) and the version last seen on disk, which
// is what makes a concurrent write a 409 on the screen instead of a silent
// overwrite.
const drafts = new Map();   // uri -> edited text, until it is saved
const versions = new Map(); // uri -> sha256 of the content this browser read
let avEditable = null;      // { uri, name, markdown, content } while a text artifact is up

// Offer ✎ for the text we just put in the viewer (markdown or plain source).
function avEditableText(uri, name, markdown, content) {
  avEditable = { uri, name, markdown, content };
  avEditBtn.hidden = false;
}
// Hand a file to the file screen — the ✎ route and the drawing route both come
// through here. `extra` carries what differs (markdown / draw, and the text).
function toFileScreen(uri, name, extra) {
  const c = card(S.openCardId);
  closeArtifact();
  // The card panel is a board-area overlay and the board is what we are
  // leaving — but the chat must NOT follow it back to the lieutenant: it stays
  // on this card's thread, which is where the conversation about this file goes.
  closeDetail({ keepChat: true });
  openFile(Object.assign({
    key: uri,
    name,
    crumb: c && {
      label: cardEmoji(c) + ' ' + (c.title || c.id),
      title: 'back to this card',
      onClick: () => { closeFile(); openDetail(c.id); },
    },
    onChange: (text) => drafts.set(uri, text),
    onSave: (text, svg) => saveArtifactText(uri, text, svg, c && c.id),
  }, extra));
}
avEditBtn.onclick = () => {
  if (!avEditable) return;
  const { uri, name, markdown, content } = avEditable;
  toFileScreen(uri, name, {
    markdown,
    content: drafts.has(uri) ? drafts.get(uri) : content,
    saved: content, // what is on disk — a restored draft is still unsaved typing
  });
};
// A drawing is not something you glance at and close — it is a surface you stay
// in, like editing. So it skips the popup entirely and opens straight on the
// file screen, where the canvas takes the board's place with the chat at its side.
async function openDrawing(uri, name) {
  let r;
  try { r = await api.artifact(uri); }
  catch (e) {
    avReset(name, uri);
    avBody.textContent = '⚠ cannot open this drawing — ' + e.message;
    return;
  }
  if (!drafts.has(uri)) versions.set(uri, r.version || '');
  toFileScreen(uri, name, {
    draw: true,
    content: drafts.has(uri) ? drafts.get(uri) : r.content,
    saved: r.content,
  });
}
// The save the file screen calls. Resolves with the line it should show, or
// rejects with the one it should show in red — the screen prints what it is
// told and never learns what an artifact is.
async function saveArtifactText(uri, text, svg, cardId) {
  try {
    return await landed(uri, await api.saveArtifact(uri, text, versions.get(uri) || ''), text, svg, cardId);
  } catch (e) {
    // 409: someone (or something) else wrote this file since we read it.
    if (e.status !== 409) throw e;
    const disk = e.body && e.body.content;
    // A DRAWING resolves this itself, because that is the whole reason it merges
    // shape by shape: take their copy, merge it with his, and write THAT against
    // the version the refusal just handed us — in the same breath, so the pin
    // never exists on its own. It must not: the canvas saves itself on a timer,
    // so a pinned version with no merge behind it is a clean overwrite of
    // somebody's work that no human ever chose.
    if (fileMerges() && fileKey() === uri) {
      const merged = disk == null ? null : fileResolve(disk);
      if (merged == null) {
        // Unreadable, or nothing to merge into. Then the refusal STANDS — and
        // the version stays where it was, so the next automatic save is refused
        // again instead of going through clean.
        throw new Error('this file changed on disk and could not be merged — nothing was written, and your drawing is still here.');
      }
      const r = await api.saveArtifact(uri, merged, e.body.version);
      const note = await landed(uri, r, merged, svg, cardId);
      return { note: '↻ the other hand got there first — merged and ' + note, saved: merged };
    }
    // Text cannot be merged, so a human decides. He reads this, and clicking 💾
    // again is that decision — which is the only reason pinning is sound here.
    if (e.body && e.body.version) versions.set(uri, e.body.version);
    throw new Error('this file changed on disk since you opened it — nothing was written, and your text is still here. ' +
      'Save again to overwrite the disk version, or copy your text out first.');
  }
}
// A write landed: remember the version it produced, drop the draft, and put the
// picture beside it. Returns the line to show.
async function landed(uri, r, text, svg, cardId) {
  versions.set(uri, r.version);
  drafts.delete(uri); // what is on disk IS this text now
  if (avEditable && avEditable.uri === uri) avEditable.content = text;
  const also = svg ? await saveSvg(uri, svg, cardId) : '';
  return 'saved — ' + r.bytes + ' bytes on disk' + also;
}
// A drawing renders in Excalidraw and nowhere else, which would make it
// invisible in card bodies, reports and explains — where mermaid already shows.
// So every save also drops the picture next to the file as <name>.excalidraw.svg
// and lists it on the card, which is what makes it servable and viewable.
//
// It is DERIVED output, not the deliverable: it goes through the same guarded
// write, but a 409 on it just means someone else's render got there first, and
// the newest drawing is the one that should be showing — so it is redone once
// against what is on disk. Nothing here can turn a saved drawing into a failed
// save; the worst it does is say the picture is missing.
async function saveSvg(uri, svg, cardId) {
  const su = uri + '.svg';
  try {
    const text = await svg(); // taken now, of what actually landed — not of a scene we did not write
    if (cardId) await api.addArtifact(cardId, su, uriBasename(su)); // idempotent; also what makes it writable
    try {
      versions.set(su, (await api.saveArtifact(su, text, versions.get(su) || '')).version);
    } catch (e) {
      if (e.status !== 409 || !e.body || !e.body.version) throw e;
      versions.set(su, (await api.saveArtifact(su, text, e.body.version)).version);
    }
    return ' + svg';
  } catch (e) {
    return ' (no svg — ' + (e && e.message ? e.message : 'export failed') + ')';
  }
}
// The other hand wrote a file (SSE `artifact` from a landed PUT: {uri, version,
// by}). Four hands means the screen follows by itself — a reload button here
// would make this two hands taking turns.
//   buffer clean → take the new text in place, changed lines marked. No asking:
//                  there is nothing of his to lose, so there is no decision.
//   buffer dirty → say it and let HIM choose. The one case that earns a click.
// The write's own client hears its echo and does nothing (`by`), and the version
// check covers the case where two clients already agree on the text.
export async function artifactWritten(ev) {
  const uri = ev && ev.uri;
  if (!uri || (ev.by && ev.by === api.clientId)) return; // our own save coming back
  if (fileKey() !== uri) return; // nothing of ours is open on it; a later open re-reads anyway
  if (versions.get(uri) === ev.version) return;
  let r;
  try { r = await api.artifact(uri); } catch (e) { return; } // gone or unreadable — the save will say so
  if (fileKey() !== uri) return; // he left the screen while we were fetching
  const take = (note) => {
    versions.set(uri, r.version);
    drafts.delete(uri);
    if (avEditable && avEditable.uri === uri) avEditable.content = r.content;
    fileUpdate(r.content, note);
  };
  // A drawing never has to choose: the shapes merge, and the ones he has his
  // hands on are left alone. That is the whole point of merging by element —
  // there is nothing of his to lose, dirty or not, so there is nothing to ask.
  if (!fileDirty() || fileMerges()) return take('↻ the other hand wrote this file');
  // Dirty: his text is NOT touched and the version stays pinned to what his
  // draft started from, so saving it is still a 409 — the last line of defense
  // holds even if he ignores this line entirely.
  fileNotice('⚠ the other hand wrote this file while you have unsaved text here — nothing of yours was touched.',
    'warn', [
      { label: '↻ show me theirs', title: 'load the version on disk, changed lines marked — your unsaved text goes', onClick: () => take('↻ loaded the version on disk') },
      { label: '✋ keep mine', title: 'leave your text alone (saving it will ask you to confirm the overwrite)', onClick: () => {} },
    ]);
}

// An artifact entry may carry a content-type hint ({uri, label, type}) — e.g.
// the auto-attached worker brief is markdown in a `.prompt` file. The hint
// wins; the extension regex is the fallback.
const isMdArtifact = (art, name) => (art && art.type) === 'markdown' || MD_EXT.test(name);
async function openArtifact(uri) {
  const name = uriBasename(uri) || uri;
  if (DRAW_EXT.test(name)) return openDrawing(uri, name); // a drawing opens as a canvas, not as its JSON
  avReset(name, uri);
  avBody.textContent = 'loading…';
  // A promoted chat attachment resolves through the attachment viewer (images
  // preview inline, text shows content, binary downloads) rather than the
  // text-only /api/artifact path.
  const c = card(S.openCardId);
  const at = c && (c.attributes || {}).artifacts && (c.attributes.artifacts.find((a) => a && a.uri === uri));
  const title = (at && at.label) || name; // the curated label shows as the viewer title
  avName.textContent = title;
  const am = /^attachment:\/\/(.+)$/.exec(uri);
  if (am) {
    return openAttachment({ id: am[1], name: (at && at.label) || name, mime: '', type: at && at.type });
  }
  // Non-attachment artifact (file:// / bare path). Dispatch by extension: an
  // image renders inline from the raw byte serve; text/markdown keeps the text
  // preview; a known binary offers a download instead of "no preview".
  const rawUrl = '/api/artifact?uri=' + encodeURIComponent(uri) + '&raw=1';
  const offerDownload = (msg) => {
    avBody.hidden = false; avImgWrap.hidden = true; avImg.removeAttribute('src');
    avDownload.href = rawUrl; avDownload.setAttribute('download', name); avDownload.hidden = false;
    avBody.className = ''; avBody.textContent = msg;
  };
  if (IMG_EXT.test(name)) {
    avDownload.href = rawUrl; avDownload.setAttribute('download', name); avDownload.hidden = false;
    avBody.hidden = true; avImgWrap.hidden = false; avImg.src = rawUrl; avImg.alt = title;
    return;
  }
  if (VIDEO_EXT.test(name)) {
    // Inline player fed by the same raw serve the ⬇ button uses. No autoplay.
    avDownload.href = rawUrl; avDownload.setAttribute('download', name); avDownload.hidden = false;
    avBody.hidden = true; avVideoWrap.hidden = false; avVideo.src = rawUrl;
    return;
  }
  if (AUDIO_EXT.test(name)) {
    // Inline player fed by the same raw serve the ⬇ button uses. No autoplay.
    avDownload.href = rawUrl; avDownload.setAttribute('download', name); avDownload.hidden = false;
    avBody.hidden = true; avAudioWrap.hidden = false; avAudio.src = rawUrl;
    return;
  }
  if (HTML_EXT.test(name)) {
    // A rendered .html/.htm page (teach-me, report): show it live in a sandboxed
    // iframe (allow-scripts, no same-origin) fed by the raw serve, which sends a
    // matching CSP. These pages want room — open expanded by default.
    avDownload.href = rawUrl; avDownload.setAttribute('download', name); avDownload.hidden = false;
    avBody.hidden = true; avImgWrap.hidden = true;
    avFrame.hidden = false; avFrame.src = rawUrl;
    avModal.classList.add('expanded');
    return;
  }
  if (BIN_EXT.test(name)) return offerDownload('No inline preview for this file type. Use ⬇ to download.');
  // Text / markdown (or unknown) → the existing text preview. A genuine binary
  // (null bytes → 415) or over-cap text (413, "too large") falls through to a
  // download offer, carrying the server's message.
  try {
    const r = await api.artifact(uri);
    const markdown = isMdArtifact(at, name);
    // An unsaved draft is what the captain last typed — show that, not the copy
    // on disk. The version follows the same rule: while a draft is open it stays
    // pinned to the disk state the draft was started from, so a write that lands
    // underneath it is still a 409 when he finally saves.
    if (!drafts.has(uri)) versions.set(uri, r.version || '');
    const text = drafts.has(uri) ? drafts.get(uri) : r.content;
    if (markdown) {
      showMarkdown(text); // rendered via md.js, with the ⇄ source toggle
    } else {
      avBody.className = '';
      avBody.textContent = text; // non-markdown: plain preformatted text
      avCopyable(text);
    }
    avEditableText(uri, name, markdown, r.content); // ✎ turns the preview into an editor
  } catch (e) {
    offerDownload('⚠ no preview — ' + e.message + ' (use ⬇ to download)'); // binary / too large / unreadable
  }
}
// Open a chat attachment: images preview inline, text-ish types show their
// content, everything else downloads. Served straight from /api/attachments/:id
// (never /api/artifact — an attachment need not be a promoted card artifact).
const TEXTY_MIME = /^(text\/|application\/(json|xml|javascript|x-sh|x-yaml|yaml|csv|x-www-form-urlencoded)|image\/svg)/;
const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;
const VIDEO_EXT = /\.(mp4|mov|webm|m4v)$/i;
const isVideoMime = (m) => /^video\//.test(String(m || ''));
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac)$/i;
const isAudioMime = (m) => /^audio\//.test(String(m || ''));
const TEXT_EXT = /\.(md|markdown|txt|log|json|ya?ml|csv|js|ts|py|sh|css|html?)$/i;
// Known binaries — never worth a text preview; offer a download straight away.
const BIN_EXT = /\.(pdf|zip|gz|tgz|tar|xlsx?|docx?|pptx?|bin|exe|dmg|iso|woff2?|ttf|otf|parquet|pkl|npz|so|dll|wasm|class|jar)$/i;
export async function openAttachment(att) {
  const url = '/api/attachments/' + encodeURIComponent(att.id);
  const name = att.name || '';
  avReset(name || att.id, name);
  avDownload.href = url;
  avDownload.setAttribute('download', name || 'file');
  avDownload.hidden = false;
  const showImage = () => { avBody.hidden = true; avImgWrap.hidden = false; avImg.src = url; avImg.alt = name; };
  const showVideo = () => { avBody.hidden = true; avVideoWrap.hidden = false; avVideo.src = url; };
  const showAudio = () => { avBody.hidden = true; avAudioWrap.hidden = false; avAudio.src = url; };
  const showText = (text) => {
    if (isMdArtifact(att, name)) showMarkdown(text);
    else { avBody.className = ''; avBody.textContent = text; avCopyable(text); }
  };
  const mime = String(att.mime || '');
  // Decide from mime/extension when possible; a promoted artifact carries only
  // {uri, label}, so its mime may be unknown — then consult the served
  // Content-Type before falling back to a download.
  if (isImageMime(mime) || (!mime && IMG_EXT.test(name))) return showImage();
  if (isVideoMime(mime) || (!mime && VIDEO_EXT.test(name))) return showVideo();
  if (isAudioMime(mime) || (!mime && AUDIO_EXT.test(name))) return showAudio();
  if (TEXTY_MIME.test(mime) || (!mime && TEXT_EXT.test(name))) {
    avBody.textContent = 'loading…';
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      showText(await r.text());
    } catch (e) { avBody.textContent = '⚠ no preview — ' + e.message + ' (use ⬇ to download)'; }
    return;
  }
  if (mime) { avBody.textContent = 'No inline preview for this file type. Use ⬇ to download.'; return; }
  // Unknown mime AND an undecided name (e.g. a promoted image with a custom
  // label): ask the server what it is, then render accordingly.
  avBody.textContent = 'loading…';
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const ct = (r.headers.get('content-type') || '').split(';')[0];
    if (isImageMime(ct)) return showImage();
    if (isVideoMime(ct)) return showVideo();
    if (isAudioMime(ct)) return showAudio();
    if (TEXTY_MIME.test(ct)) return showText(await r.text());
    avBody.textContent = 'No inline preview for this file type. Use ⬇ to download.';
  } catch (e) { avBody.textContent = '⚠ no preview — ' + e.message + ' (use ⬇ to download)'; }
}
// A close hook lets main.js run one deferred render when the viewer closes
// (renders are skipped while it's open — see the reading-mode guard). Mirrors
// state.js onRender: a setter avoids a circular import back into main.js.
let onCloseFn = () => {};
export function onArtifactClose(fn) { onCloseFn = fn; }
export function closeArtifact() { avOverlay.hidden = true; avVideo.pause(); avAudio.pause(); onCloseFn(); }
export function artifactOpen() { return !avOverlay.hidden; }
document.getElementById('av-close').onclick = closeArtifact;
// Maximize / restore the viewer (pure CSS class toggle — see #av-modal.expanded).
avExpand.onclick = () => { avModal.classList.toggle('expanded'); };
avOverlay.onclick = (e) => { if (e.target === avOverlay) closeArtifact(); };

// ---------- owner menu (reassign the owning lieutenant) ----------
// Popover twin of the board's move-menu (shares its look — see app.css): lists
// the OTHER lieutenants by name with their color dot; picking one PATCHes
// {owner} and the SSE board push repaints chip + tile live. Opened by the ✎ on
// the owner chip, which only renders while no worker is bound (the server
// refuses owner changes otherwise). Closes on select / outside click / Esc
// (main.js).
const omEl = document.getElementById('owner-menu');
function openOwnerMenu(cardId, x, y) {
  const c = card(cardId);
  if (!c) return;
  omEl.textContent = '';
  const head = document.createElement('div');
  head.className = 'mm-head';
  head.textContent = 'hand card to';
  omEl.appendChild(head);
  const others = lieutenants().filter((l) => l.id !== c.owner);
  if (!others.length) {
    const none = document.createElement('div');
    none.className = 'mm-none';
    none.textContent = 'no other lieutenant';
    omEl.appendChild(none);
  }
  for (const l of others) {
    const b = document.createElement('button');
    b.type = 'button';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = lieutenantColor(l.id);
    b.appendChild(dot);
    b.appendChild(document.createTextNode(l.name || l.id));
    b.onclick = async () => {
      closeOwnerMenu();
      try { await api.patchCard(cardId, { owner: l.id }); }
      catch (e) { alert(e.message); }
    };
    omEl.appendChild(b);
  }
  omEl.hidden = false;
  const r = omEl.getBoundingClientRect();
  omEl.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
  omEl.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
}
export function closeOwnerMenu() { omEl.hidden = true; }
export function ownerMenuOpen() { return !omEl.hidden; }
document.addEventListener('click', (e) => { if (!omEl.hidden && !omEl.contains(e.target)) closeOwnerMenu(); });

// Opening the card clears its unread: level-1 events and lieutenant replies both
// derive from the same per-card read marker server-side, so one POST covers
// both. The chat panel only marks the thread when IT is visible (and only on
// unread messages), which misses the mobile detail view and event-only unread —
// this is the detail-side half. Debounced like chat.js maybeMarkRead: keyed by
// the newest unread-relevant ts so re-renders never spam the endpoint.
let lastMarked = { id: '', ts: '' };
function maybeMarkCardRead(c) {
  if (document.hidden) return;
  if (!cardStatus(c).unread) return; // server-derived; false once the marker lands
  const ts = cardActivityTs(c);
  if (lastMarked.id === c.id && lastMarked.ts === ts) return; // already sent
  lastMarked = { id: c.id, ts };
  api.markThreadRead('card:' + c.id).catch(() => { lastMarked = { id: '', ts: '' }; });
}

function attrHtml(k, v) {
  const isUrl = /^https?:\/\//.test(String(v));
  const val = isUrl
    ? '<a class="v" href="' + esc(v) + '" target="_blank" rel="noopener">' + esc(String(v).replace(/^https?:\/\/(www\.)?/, '')) + '</a>'
    : '<span class="v">' + esc(String(v)) + '</span>';
  return '<span class="attr"><span class="k">' + esc(k) + '</span>' + val + '</span>';
}

export function renderDetail() {
  if (!S.openCardId) { el.hidden = true; return; }
  let c = card(S.openCardId);
  let arch = null; // the archive record when this is a frozen snapshot
  if (!c) {
    const frozen = archivedCard(S.openCardId);
    if (!frozen) { closeDetail(); return; }
    c = frozen.c;
    arch = frozen.arch;
  }
  el.hidden = false;
  el.classList.toggle('frozen', !!arch);
  // header actions per mode: live cards talk and move; a frozen snapshot's one
  // action is unarchive (restoring keeps the panel open — it becomes the live card)
  document.getElementById('dt-talk').hidden = !!arch;
  document.getElementById('dt-menu-btn').hidden = !!arch;
  const unBtn = document.getElementById('dt-unarch');
  unBtn.hidden = !arch;
  if (arch) unBtn.onclick = () => unarchive(c.id, unBtn);
  titleEl.title = arch ? '' : 'click to rename'; // rename is live-only (the editor no-ops on frozen ids)

  const emojiEl = document.getElementById('dt-emoji');
  const emoji = cardEmoji(c);
  if (emojiEl.textContent !== emoji) emojiEl.textContent = emoji;
  if (!editingTitle && titleEl.textContent !== (c.title || c.id)) titleEl.textContent = c.title || c.id; // don't clobber an in-progress rename
  // sub line: id + timestamps, plus a worker-id chip when a worker is attached.
  // Same whitelist as the tile stripe (board.js) — only known states render, so
  // no server value ever reaches the class name; the id itself is esc()'d.
  // Frozen snapshots swap the worker chip for when/why they were archived.
  const WORKER_STATES = { working: 1, 'needs-you': 1, idle: 1 };
  const w = cardStatus(c).worker;
  const worker = !arch && w && w.id && WORKER_STATES[w.state] ? w : null;
  const rsn = arch && (arch.reason === 'merged' ? 'merged' : 'killed');
  setHtmlIfChanged(document.getElementById('dt-sub'),
    esc(c.id + ' · ' + c.type + ' · created ') + agoSpanHtml(c.created) + esc(' ago') +
    (arch
      ? esc(' · archived ') + agoSpanHtml(arch.ts) + esc(' ago') +
        '<span class="tv-rsn tv-rsn-' + rsn + '"' + (arch.note ? ' title="' + esc(arch.note) + '"' : '') + '>' +
        (rsn === 'merged' ? '🏁 merged' : '🪦 killed') + '</span>'
      : esc(' · updated ') + agoSpanHtml(cardRecency(c)) + esc(' ago')) +
    (worker ? '<span class="dt-worker dt-worker-' + worker.state + '" title="worker: ' + esc(worker.state) + '">' + esc(worker.id) + '</span>' : ''));

  // attributes header. The owner (the owning lieutenant) leads, in the
  // lieutenant's color and clickable as a filter. prs and artifacts are
  // structured lists with dedicated renderers below, so they are excluded from
  // the generic key:value chips.
  const at = c.attributes || {};
  const attrsEl = document.getElementById('dt-attrs');
  // data-card keys the markup to THIS card: the chip handlers below close over
  // c, so a same-looking attrs row on another card must not skip the rebuild
  const attrsChanged = setHtmlIfChanged(attrsEl,
    '<span class="attr attr-owner" data-card="' + esc(c.id) + '" title="click: filter by lieutenant · alt-click: exclude"><span class="k">lieutenant</span>' +
    '<span class="v" style="color:' + esc(lieutenantColor(c.owner)) + '">' + esc((lieutenant(c.owner) || {}).name || c.owner) + '</span>' +
    // ✎ only while no worker is bound — mirrors the server guard on owner PATCH.
    // Rendered in the markup (not appended after) so a worker binding/unbinding
    // changes the innerHTML signature and setHtmlIfChanged rebuilds the row.
    // Frozen snapshots never offer it: nothing about them is editable.
    (worker || arch ? '' : '<button type="button" class="owner-edit" title="change owner (only while no worker is bound)">✎</button>') +
    '</span>' +
    (c.pendingOrder ? '<span class="attr"><span class="k">pending</span><span class="v">⏳ ' + esc(c.pendingOrder.kind) + '</span></span>' : '') +
    Object.entries(at)
      .filter(([k]) => k !== 'emoji' && k !== 'prs' && k !== 'artifacts')
      .map(([k, v]) => attrHtml(k, v)).join('') +
    cardPrs(c).map((pr) => prChipHtml(pr, true)).join(''));
  const ownerChip = attrsChanged && attrsEl.querySelector('.attr-owner');
  if (ownerChip) {
    ownerChip.style.cursor = 'pointer';
    ownerChip.onclick = (e) => toggleFilter('owner', c.owner, e.altKey);
    const edit = ownerChip.querySelector('.owner-edit');
    if (edit) edit.onclick = (e) => {
      e.stopPropagation(); // the chip click is the owner filter, not the menu
      const r = edit.getBoundingClientRect();
      openOwnerMenu(c.id, r.left, r.bottom + 4);
    };
  }

  // labels (user-owned) — DOM-built, so guarded by a signature (card + each
  // chip's rendered markup, covering name/color/filter state) instead of an
  // innerHTML cache; the handlers close over c, hence c.id in the signature
  const labWrap = document.getElementById('dt-labels');
  const labSig = c.id + '|' + (arch ? 'frozen|' : '') + (c.labels || []).map((n) => labelChipHtml(n, filterSelected('label', n))).join('');
  if (labWrap.__bcSig !== labSig) {
    labWrap.__bcSig = labSig;
    labWrap.textContent = '';
    for (const name of c.labels || []) {
      const chip = document.createElement('span');
      chip.className = 'dlabel';
      chip.innerHTML = labelChipHtml(name, filterSelected('label', name));
      chip.querySelector('.label').onclick = (e) => toggleFilter('label', name, e.altKey);
      if (!arch) { // frozen labels filter but never change
        const x = document.createElement('button');
        x.type = 'button'; x.textContent = '✕'; x.title = 'remove label';
        x.onclick = () => saveCardLabels(c.id, (c.labels || []).filter((v) => v !== name));
        chip.appendChild(x);
      }
      labWrap.appendChild(chip);
    }
    if (!arch) {
      const add = document.createElement('button');
      add.type = 'button';
      add.id = 'dt-label-add';
      add.setAttribute('data-label-add', '');
      add.textContent = '+ label';
      add.onclick = () => openLabelPicker(c.id, add);
      labWrap.appendChild(add);
    }
  }

  // body (don't clobber an in-progress description edit). mdEnhance runs
  // unconditionally: it is per-node guarded, so an unchanged body is a no-op,
  // and enhanced DOM (copy buttons, diagrams) never changes the cached html
  // string setHtmlIfChanged compares against.
  if (!editingBody) {
    setHtmlIfChanged(bodyEl, md(c.body || ''));
    mdEnhance(bodyEl);
    bodyEditBtn.hidden = !!arch; // description edit is live-only
  }

  // artifacts: attributes.artifacts [{uri, label}] — shown by FILENAME, not the
  // raw uri. http(s) uris open normally; anything else (file:// / local paths)
  // opens in the artifact viewer popup, served by GET /api/artifact.
  const artEl = document.getElementById('dt-artifacts');
  const artsChanged = setHtmlIfChanged(artEl, artifactsHtml(cardArtifacts(c)));
  if (artsChanged) artEl.querySelectorAll('.a-uri[data-view]').forEach((n) => {
    n.onclick = () => openArtifact(n.dataset.view);
  });

  // frozen thread snapshot, inline: live cards converse in the chat panel, but
  // an archived card's thread is part of the snapshot — show it read-only here
  const thHead = document.getElementById('dt-thread-head');
  const thEl = document.getElementById('dt-thread');
  const showThread = !!arch && (c.thread || []).length > 0;
  thHead.hidden = thEl.hidden = !showThread;
  if (showThread) {
    setHtmlIfChanged(thEl, (c.thread || []).map((m) =>
      '<div class="ftm' + (m.author === 'user' ? ' mine' : '') + '">' +
      '<span class="fta">' + esc(m.author) + '</span>' +
      '<div class="ftb md">' + md(m.text || '') + '</div>' +
      '<span class="fts">' + hhmm(m.ts) + '</span></div>').join(''));
  }

  // event timeline (newest first)
  const evEl = document.getElementById('dt-events');
  const events = (c.events || []).slice().reverse();
  // kind emoji from the effective kinds map, for any level; unknown kind = no emoji
  setHtmlIfChanged(evEl, events.map((e) =>
    '<div class="ev lvl' + e.level + '"><span class="dot"></span><div class="bd">' +
    '<div class="tx">' + (kindEmoji(e.kind) ? esc(kindEmoji(e.kind)) + ' ' : '') + esc(e.text) + '</div>' +
    '<div class="sub">' + esc(e.actor || '') + ' · ' + hhmm(e.ts) + ' · ' + agoSpanHtml(e.ts) + ' ago</div>' +
    '</div></div>').join('') || '<div class="ev"><div class="bd"><div class="sub">no events yet</div></div></div>');

  if (!arch) maybeMarkCardRead(c); // frozen snapshots have no read state to advance
}
