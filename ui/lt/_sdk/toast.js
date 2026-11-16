// A small toast for lieutenant pages (actions.js errors, comment.js confirmations).
// Lives in its own shadow root so the page's CSS and ours never meet.
let stack = null;

function mount() {
  const host = document.createElement('bc-toast');
  host.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483647;pointer-events:none';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<style>'
    + '.s{display:flex;flex-direction:column;gap:6px;align-items:center}'
    + '.t{font:13px/1.35 system-ui,sans-serif;color:#f5f7fa;background:#1f2633;border:1px solid #3a4456;'
    + 'border-radius:8px;padding:8px 12px;max-width:min(520px,calc(100vw - 32px));box-shadow:0 4px 16px #0006;'
    + 'white-space:pre-wrap;word-break:break-word;pointer-events:auto}'
    + '.t.err{background:#4a1d22;border-color:#a3444f}'
    + '</style><div class="s" role="status" aria-live="polite"></div>';
  document.documentElement.appendChild(host);
  return root.querySelector('.s');
}

export function toast(text, kind) {
  if (!stack) stack = mount();
  const el = document.createElement('div');
  el.className = 't' + (kind === 'error' ? ' err' : '');
  el.textContent = String(text);
  stack.appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3000);
}
