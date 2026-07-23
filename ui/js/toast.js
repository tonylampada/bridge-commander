// toast.js — fixed top-right toast stack for board notifications. The
// container is created lazily (mirrors voice.js's floating "speaking" bubble)
// so nothing exists in the DOM until the first toast is pushed.
const MAX_VISIBLE = 4;
const DISMISS_MS = 6000;

let root = null;
let openCard = null;
export function onOpenCard(fn) { openCard = fn; }
let openLt = null;
export function onOpenLieutenant(fn) { openLt = fn; }

function ensureRoot() {
  if (root) return root;
  root = document.createElement('div');
  root.id = 'toast-stack';
  document.body.appendChild(root);
  return root;
}

// e: { emoji, text, cardTitle, actor, card, lieutenant }
export function push(e) {
  const stack = ensureRoot();
  const el = document.createElement('div');
  el.className = 'toast';

  const em = document.createElement('span');
  em.className = 'em';
  em.textContent = e.emoji || '';

  const bd = document.createElement('div');
  bd.className = 'bd';
  const tx = document.createElement('div');
  tx.className = 'tx';
  tx.textContent = e.text || '';
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = [e.cardTitle, e.actor].filter(Boolean).join(' · ');
  bd.append(tx, sub);

  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'x';
  x.title = 'dismiss';
  x.textContent = '✕';

  el.append(em, bd, x);

  let timer = null;
  const dismiss = () => { clearTimeout(timer); el.remove(); };
  const arm = () => { timer = setTimeout(dismiss, DISMISS_MS); };
  el.onmouseenter = () => clearTimeout(timer);
  el.onmouseleave = arm;
  x.onclick = (ev) => { ev.stopPropagation(); dismiss(); };
  // card-less toasts (a lieutenant's main-chat message) land in that
  // lieutenant's conversation instead of dying on the click
  el.onclick = () => {
    if (e.card && openCard) openCard(e.card);
    else if (e.lieutenant && openLt) openLt(e.lieutenant);
    dismiss();
  };

  stack.appendChild(el);
  while (stack.children.length > MAX_VISIBLE) stack.firstChild.remove();
  arm();
}
