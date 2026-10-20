// The lieutenant page screen: lieutenants/<id>/page/ (served at /lt/<id>/) in
// an iframe where the board was, with the chat still at its side. The
// lieutenant writes the page; the board only frames it and says how old it is.
//
// The entry point is the 📄 button in the chat header, shown only when the
// lieutenant behind the conversation has a page (`lt.page` on the board
// payload). Both the button and the screen's header carry the "updated" stamp,
// and it turns amber past a day so a slipped refresh schedule is visible.
import { S, lieutenant } from './state.js';
import { esc, agoSpanHtml, setHtmlIfChanged } from './util.js';

const STALE_MS = 24 * 60 * 60 * 1000;
const el = document.getElementById('page-screen');
const headEl = document.getElementById('pg-head');
const frameEl = document.getElementById('pg-frame');
let modeSwitch = () => {}; // set by main.js — flipping the main area's mode is its job
export function onPageModeSwitch(fn) { modeSwitch = fn; }

let shownLt = null;  // whose page the screen is on
let loaded = '';     // `${id}|${updated}` the iframe last loaded

function pageUrl(id) { return '/lt/' + encodeURIComponent(id) + '/'; }
function stale(page) { return Date.now() - Date.parse(page.updated) > STALE_MS; }

export function openPage(id) {
  shownLt = id;
  S.view = 'board'; // on a phone the page takes the board tab
  modeSwitch('page');
}

// chat.js hands over the button and the lieutenant the header is showing.
let btn = null, currentLt = () => null;
export function mountPageButton(el, current) {
  btn = el;
  currentLt = current;
  btn.onclick = () => { const lt = currentLt(); if (lt && lt.page) openPage(lt.id); };
}
export function syncPageButton() {
  if (!btn) return;
  const lt = currentLt();
  const page = lt && lt.page;
  btn.hidden = !page;
  if (!page) return;
  btn.classList.toggle('stale', stale(page));
  btn.classList.toggle('on', S.boardMode === 'page' && shownLt === lt.id);
  btn.title = (lt.name || lt.id) + "'s page · updated " + new Date(page.updated).toLocaleString();
  setHtmlIfChanged(btn, '📄' + agoSpanHtml(page.updated, 'cp-ago'));
}

export function renderPageScreen() {
  const lt = shownLt ? lieutenant(shownLt) : null;
  const page = lt && lt.page;
  const back = '<button type="button" id="pg-back" class="fs-back" title="back to the board">⟵</button>';
  if (!page) {
    setHtmlIfChanged(headEl, back + '<span class="pg-title">📄 page</span>');
    if (loaded) { frameEl.removeAttribute('src'); loaded = ''; }
    frameEl.hidden = true;
    let empty = el.querySelector('.pg-empty');
    if (!empty) { empty = document.createElement('div'); empty.className = 'pg-empty empty'; el.appendChild(empty); }
    empty.textContent = lt ? (lt.name || lt.id) + ' has no page yet' : 'no such lieutenant';
    wireBack();
    return;
  }
  const old = el.querySelector('.pg-empty');
  if (old) old.remove();
  frameEl.hidden = false;
  const url = pageUrl(lt.id);
  setHtmlIfChanged(headEl, back +
    '<span class="pg-title">📄 ' + esc(lt.name || lt.id) + '</span>' +
    '<span class="pg-upd' + (stale(page) ? ' stale' : '') + '" title="' + esc(new Date(page.updated).toLocaleString()) + '">updated · ' +
      agoSpanHtml(page.updated) + '</span>' +
    '<span class="pg-sp"></span>' +
    '<button type="button" id="pg-reload" class="pg-act" title="reload the page">↻</button>' +
    '<a class="pg-act" href="' + esc(url) + '" target="_blank" rel="noopener">open in new tab ↗</a>');
  wireBack();
  document.getElementById('pg-reload').onclick = () => { loaded = ''; renderPageScreen(); };
  // A new stamp means the lieutenant rewrote it: load the new one. Anything
  // else (every other board event) leaves the frame — and its scroll — alone.
  const key = lt.id + '|' + page.updated;
  if (key !== loaded) {
    loaded = key;
    frameEl.src = url + '?v=' + encodeURIComponent(page.updated);
  }
}
let leave = () => {};
export function onPageBack(fn) { leave = fn; }
function wireBack() { document.getElementById('pg-back').onclick = () => leave(); }
// Leaving the screen unloads the page: its scripts stop with it.
export function forgetPage() {
  if (!loaded) return;
  frameEl.removeAttribute('src');
  loaded = '';
}
