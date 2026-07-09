// ansi.js — tiny zero-dep ANSI SGR → HTML converter for pane frames.
// Handles reset, bold/dim, 16-color and 256-color (and, defensively, truecolor)
// fg/bg as inline-styled <span>s. Text is HTML-escaped BEFORE any markup is
// added. Non-SGR escape sequences (cursor movement, OSC titles, …) are
// stripped — capture-style frames are mostly SGR + text, but be defensive.

// 16-color terminal palette (normal 0-7, bright 8-15), tuned for a dark surface.
const BASE16 = [
  '#3b4453', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fc0', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
];
const CUBE = [0, 95, 135, 175, 215, 255]; // xterm 6×6×6 color-cube levels

function hex2(n) { return n.toString(16).padStart(2, '0'); }
function rgb(r, g, b) { return '#' + hex2(r) + hex2(g) + hex2(b); }

// xterm 256-color index → css color (0-15 base, 16-231 cube, 232-255 grays)
function color256(n) {
  if (!Number.isInteger(n) || n < 0 || n > 255) return null;
  if (n < 16) return BASE16[n];
  if (n < 232) {
    const v = n - 16;
    return rgb(CUBE[Math.floor(v / 36)], CUBE[Math.floor(v / 6) % 6], CUBE[v % 6]);
  }
  const g = 8 + (n - 232) * 10;
  return rgb(g, g, g);
}


// ansiToHtml(frame) -> html string. Runs of text under one SGR state become one
// <span style>; unstyled runs stay bare text.
export function ansiToHtml(str) {
  const st = { bold: false, dim: false, fg: null, bg: null };
  let out = '';
  let buf = '';        // pending text under bufStyle
  let bufStyle = '';   // the css of the text sitting in buf

  const styleOf = () => {
    const parts = [];
    if (st.fg) parts.push('color:' + st.fg);
    if (st.bg) parts.push('background:' + st.bg);
    if (st.bold) parts.push('font-weight:700');
    if (st.dim) parts.push('opacity:.55');
    return parts.join(';');
  };
  const flush = () => {
    if (!buf) return;
    out += bufStyle ? '<span style="' + bufStyle + '">' + buf + '</span>' : buf;
    buf = '';
  };

  // One SGR parameter list. Handles both semicolon args (38;5;196 / 38;2;r;g;b)
  // and colon subparams (38:5:196, 38:2::r:g:b).
  const applySgr = (raw) => {
    const parts = (raw === '' ? '0' : raw).split(';');
    for (let p = 0; p < parts.length; p++) {
      const item = parts[p];
      const code = parseInt(item.split(':')[0], 10);
      if (Number.isNaN(code) || code === 0) { st.bold = false; st.dim = false; st.fg = null; st.bg = null; }
      else if (code === 1) st.bold = true;
      else if (code === 2) st.dim = true;
      else if (code === 22) { st.bold = false; st.dim = false; }
      else if (code >= 30 && code <= 37) st.fg = BASE16[code - 30];
      else if (code >= 90 && code <= 97) st.fg = BASE16[code - 90 + 8];
      else if (code === 39) st.fg = null;
      else if (code >= 40 && code <= 47) st.bg = BASE16[code - 40];
      else if (code >= 100 && code <= 107) st.bg = BASE16[code - 100 + 8];
      else if (code === 49) st.bg = null;
      else if (code === 38 || code === 48) {
        let mode;
        let args;
        if (item.includes(':')) { // colon form: self-contained subparams
          const sub = item.split(':');
          mode = sub[1];
          args = sub.length >= 6 ? sub.slice(3) : sub.slice(2); // 38:2::r:g:b carries a colorspace slot
        } else {
          mode = parts[p + 1];
          if (mode === '5') { args = [parts[p + 2]]; p += 2; }
          else if (mode === '2') { args = parts.slice(p + 2, p + 5); p += 4; }
          else { args = []; p += 1; }
        }
        let col = null;
        if (mode === '5') col = color256(parseInt(args[0], 10));
        else if (mode === '2') {
          const [r, g, b] = args.map((v) => parseInt(v, 10));
          if ([r, g, b].every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) col = rgb(r, g, b);
        }
        if (code === 38) st.fg = col; else st.bg = col;
      }
      // anything else (italic, underline, blink, …): ignored, deliberately small
    }
  };

  let cur = ''; // css of the CURRENT SGR state (recomputed only on SGR)
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '\x1b') {
      const n = str[i + 1];
      if (n === '[') { // CSI: apply if SGR (final 'm'), strip anything else
        let j = i + 2;
        while (j < str.length && !/[@-~]/.test(str[j])) j++;
        if (j < str.length && str[j] === 'm') {
          applySgr(str.slice(i + 2, j));
          cur = styleOf();
        }
        i = j < str.length ? j : str.length;
        continue;
      }
      if (n === ']') { // OSC: strip to BEL or ST (ESC \)
        let j = i + 2;
        while (j < str.length && str[j] !== '\x07' && !(str[j] === '\x1b' && str[j + 1] === '\\')) j++;
        i = str[j] === '\x1b' ? j + 1 : j;
        continue;
      }
      i++; // lone ESC + one byte: drop
      continue;
    }
    if (cur !== bufStyle) { flush(); bufStyle = cur; }
    buf += c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c;
  }
  flush();
  return out;
}
