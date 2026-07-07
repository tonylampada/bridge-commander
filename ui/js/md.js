// tiny markdown renderer — escape-first, no HTML injection
import { esc } from './util.js';

function mdInline(s) {
  return s
    .replace(/`([^`]+)`/g, (_, c) => '<code>' + c + '</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

// GFM pipe table: split "| a | b |" into trimmed cells (leading/trailing pipes optional)
function tableCells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}
const TABLE_SEP = /^\s*\|(?:\s*:?-+:?\s*\|)*\s*:?-+:?\s*\|?\s*$/; // |---|:--:| separator row

export function md(src) {
  const lines = esc(src || '').split('\n');
  let out = '', inCode = false, inList = false, para = [];
  // A single newline inside a paragraph is a soft break -> <br> (GitHub
  // `breaks: true`). Lines are joined with \n (a sentinel: neither the escaped
  // source lines nor mdInline's output ever contain \n), inline markdown is
  // applied, then each \n becomes <br>. Blank lines still separate paragraphs
  // (they flush para), and fenced code is emitted on the inCode path below, so
  // its newlines stay literal and never reach here.
  const flushPara = () => { if (para.length) { out += '<p>' + mdInline(para.join('\n')).replace(/\n/g, '<br>') + '</p>'; para = []; } };
  const closeList = () => { if (inList) { out += '</ul>'; inList = false; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flushPara(); closeList();
      out += inCode ? '</code></pre>' : '<pre><code>';
      inCode = !inCode; continue;
    }
    if (inCode) { out += line + '\n'; continue; }
    const h = /^(#{1,3})\s+(.*)/.exec(line);
    if (h) { flushPara(); closeList(); out += '<h' + h[1].length + '>' + mdInline(h[2]) + '</h' + h[1].length + '>'; continue; }
    const li = /^\s*[-*]\s+(.*)/.exec(line);
    if (li) { flushPara(); if (!inList) { out += '<ul>'; inList = true; } out += '<li>' + mdInline(li[1]) + '</li>'; continue; }
    // pipe table: a |-line followed by a |---|---| separator row; anything else
    // starting with | falls through to normal paragraph text
    if (/^\s*\|/.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      flushPara(); closeList();
      out += '<div class="tbl"><table><thead><tr>' +
        tableCells(line).map((c) => '<th>' + mdInline(c) + '</th>').join('') + '</tr></thead><tbody>';
      i += 2;
      for (; i < lines.length && /^\s*\|/.test(lines[i]); i++) {
        out += '<tr>' + tableCells(lines[i]).map((c) => '<td>' + mdInline(c) + '</td>').join('') + '</tr>';
      }
      i--; // the for-loop's own i++ moves past the last row
      out += '</tbody></table></div>';
      continue;
    }
    if (!line.trim()) { flushPara(); closeList(); continue; }
    para.push(line);
  }
  flushPara(); closeList();
  if (inCode) out += '</code></pre>';
  return out;
}
