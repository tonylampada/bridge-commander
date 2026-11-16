// Comment on selected text — on every lieutenant page, no page code needed: the
// board adds <script type="module" src="/lt/_sdk/comment.js"> to each HTML file
// it serves under /lt/<id>/ (server.js serveLtPage).
//
// Select text → a "💬 Comentar" chip under the selection → a box with the quote
// and a textarea → Enviar. It POSTs /lt/<id>/comment and lands as a captain
// message in the lieutenant's main chat: the quote, the page path, the comment.
import { toast } from './toast.js';

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font: 14px/1.4 system-ui, -apple-system, Segoe UI, sans-serif; }
.chip { position: absolute; padding: 6px 12px; border-radius: 16px; border: 1px solid #3a4456;
  background: #1f2633; color: #f5f7fa; cursor: pointer; box-shadow: 0 3px 12px #0005; white-space: nowrap; }
.chip:hover { background: #2b3546; }
.box { position: absolute; width: min(360px, calc(100vw - 32px)); padding: 10px; border-radius: 10px;
  border: 1px solid #c9d1dc; background: #fff; color: #18202c; box-shadow: 0 8px 28px #0004; }
blockquote { margin: 0 0 8px; padding: 4px 8px; border-left: 3px solid #7aa7ff; color: #4a5566;
  max-height: 84px; overflow: auto; white-space: pre-wrap; font-size: 13px; }
textarea { width: 100%; min-height: 72px; resize: vertical; padding: 6px 8px; border-radius: 6px;
  border: 1px solid #c9d1dc; background: inherit; color: inherit; }
.row { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
.hint { flex: 1; font-size: 12px; color: #7a8696; }
button.b { padding: 6px 12px; border-radius: 6px; border: 1px solid #c9d1dc; background: transparent; color: inherit; cursor: pointer; }
button.send { background: #2f6fed; border-color: #2f6fed; color: #fff; }
button.send:disabled { opacity: .6; cursor: default; }
@media (prefers-color-scheme: dark) {
  .box { background: #1b2230; color: #e8edf4; border-color: #3a4456; }
  blockquote { color: #aab4c3; }
  textarea, button.b { border-color: #3a4456; }
}
[hidden] { display: none !important; }
`;

function mount(id) {
  const host = document.createElement('bc-comment');
  // A child of <html>, not <body>: a positioned body would shift absolute coordinates.
  host.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;z-index:2147483646';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<style>' + CSS + '</style>'
    + '<button type="button" class="chip" hidden>💬 Comentar</button>'
    + '<form class="box" hidden><blockquote></blockquote>'
    + '<textarea placeholder="Seu comentário…" aria-label="Comentário"></textarea>'
    + '<div class="row"><span class="hint">Ctrl+Enter envia · Esc fecha</span>'
    + '<button type="button" class="b cancel">Cancelar</button>'
    + '<button type="submit" class="b send">Enviar</button></div></form>';
  document.documentElement.appendChild(host);
  const chip = root.querySelector('.chip');
  const box = root.querySelector('.box');
  const quoteEl = root.querySelector('blockquote');
  const ta = root.querySelector('textarea');
  const send = root.querySelector('.send');
  let picked = null; // {text, x, y} of the selection the chip offers

  // The selection worth commenting on, or null: real text, outside any form field.
  function selection() {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const text = sel.toString().trim();
    if (!text) return null;
    const range = sel.getRangeAt(0);
    const n = range.commonAncestorContainer;
    const el = n.nodeType === 1 ? n : n.parentElement;
    if (el && (el === host || el.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'))) return null;
    const rects = range.getClientRects();
    const r = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    return { text, x: r.left + window.scrollX, y: r.bottom + window.scrollY };
  }
  function place(el, x, y) {
    const maxX = window.scrollX + document.documentElement.clientWidth - el.offsetWidth - 8;
    el.style.left = Math.max(window.scrollX + 8, Math.min(x, maxX)) + 'px';
    el.style.top = (y + 8) + 'px';
  }
  function refresh() {
    if (!box.hidden) return; // the box holds its own quote until it closes
    picked = selection();
    chip.hidden = !picked;
    if (picked) place(chip, picked.x, picked.y);
  }
  let t = 0;
  const soon = () => { clearTimeout(t); t = setTimeout(refresh, 180); };
  document.addEventListener('selectionchange', soon);
  document.addEventListener('mouseup', soon);
  window.addEventListener('resize', soon);

  // mousedown would collapse the selection before the click lands
  chip.addEventListener('mousedown', (e) => e.preventDefault());
  chip.addEventListener('click', () => {
    if (!picked) return;
    chip.hidden = true;
    quoteEl.textContent = picked.text.length > 600 ? picked.text.slice(0, 600) + '…' : picked.text;
    box.hidden = false;
    place(box, picked.x, picked.y);
    ta.focus();
  });
  function close() {
    box.hidden = true;
    ta.value = '';
    picked = null;
    refresh();
  }
  root.querySelector('.cancel').addEventListener('click', close);
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); box.requestSubmit(); }
  });
  // A click elsewhere closes an empty box; one with words in it stays.
  document.addEventListener('mousedown', (e) => {
    if (!box.hidden && !e.composedPath().includes(host) && !ta.value.trim()) close();
  });
  box.addEventListener('submit', async (e) => {
    e.preventDefault();
    const comment = ta.value.trim();
    if (!comment || !picked) { ta.focus(); return; }
    send.disabled = true;
    try {
      const r = await fetch('/lt/' + encodeURIComponent(id) + '/comment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quote: picked.text, comment, page: location.pathname }),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok || !body || !body.ok) throw new Error((body && body.error) || 'HTTP ' + r.status);
      toast('Comentário enviado' + (body.to ? ' para ' + body.to : ''));
      document.getSelection().removeAllRanges();
      close();
    } catch (err) {
      toast('Comentário não enviado: ' + err.message, 'error');
    } finally { send.disabled = false; }
  });
}

const m = /^\/lt\/([^/]+)\//.exec(location.pathname);
if (m && !window.__bcComment) {
  window.__bcComment = true;
  mount(decodeURIComponent(m[1]));
}
