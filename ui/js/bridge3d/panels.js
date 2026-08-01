// panels.js — what the room actually shows.
//
// Three tiers, and the order matters because it is the captain's own:
//
//   LIEUTENANTS  always in front, never closed. Talking to a lieutenant IS the
//                interaction; everything else in the room is optional.
//   BOARD        the remembering surface. You read it to reload what is in
//                flight and decide where your attention goes next. Always
//                available, not always in front.
//   WINDOWS      the work. A card and its chat, side by side, grabbed, resized,
//                closed. As many as attention allows.
//
// A terminal is not on this list on purpose. It is a glance — open the eye, see
// that something really is happening, close it — and it comes back later at
// that size.

import { Surface, wrap, COL, FONT, UI } from './surface.js';

const PAD = 22;

function ago(ts) {
  const ms = Date.now() - new Date(ts).getTime();
  if (!Number.isFinite(ms)) return '';
  const m = Math.round(ms / 60000);
  if (m < 1) return 'now';
  if (m < 60) return m + 'm';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h';
  return Math.round(h / 24) + 'd';
}

// ---------- the lieutenants: the one thing always in front ----------

export class LieutenantBar extends Surface {
  constructor() {
    super({ widthM: 1.5, heightM: 0.16, title: '', closable: false });
  }

  paint(doc) {
    const g = this.begin();
    const w = this.canvas.width, h = this.canvas.height;
    const lts = doc.lieutenants || [];
    const cell = w / Math.max(1, lts.length);
    lts.forEach((l, i) => {
      const x = i * cell;
      const owed = !!l.chatOwed;
      g.fillStyle = owed ? '#1d2836' : '#111823';
      g.fillRect(x + 3, 6, cell - 6, h - 12);
      // A lieutenant waiting on the captain is the only thing in this room that
      // is allowed to shout, because it is the only thing that is his move.
      if (owed) {
        g.fillStyle = COL.accent;
        g.fillRect(x + 3, 6, 5, h - 12);
      }
      g.fillStyle = l.color || COL.accent;
      g.beginPath();
      g.arc(x + cell / 2, h * 0.36, 13, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = owed ? COL.text : COL.dim;
      g.font = '600 24px ' + UI;
      g.textAlign = 'center';
      g.fillText(l.name || l.id, x + cell / 2, h * 0.78);
      g.textAlign = 'left';
      this.region(x, 0, cell, h, { kind: 'lieutenant', id: l.id });
    });
    this.end();
  }
}

// ---------- the board: where he decides what to look at next ----------

export class BoardPanel extends Surface {
  constructor() {
    super({ widthM: 1.9, heightM: 1.05, title: 'board', closable: false });
  }

  paint(doc) {
    const g = this.begin();
    const top = this.chrome(g, doc.title || '');
    const w = this.canvas.width, h = this.canvas.height;
    const cols = (doc.columns || []).filter((c) => c.id !== 'peer');
    const cw = w / Math.max(1, cols.length);
    const ltColour = new Map((doc.lieutenants || []).map((l) => [l.id, l.color || COL.dim]));

    cols.forEach((col, ci) => {
      const x = ci * cw;
      const mine = (doc.cards || []).filter((c) => c.column === col.id);
      g.fillStyle = COL.faint;
      g.font = '600 22px ' + UI;
      g.fillText((col.title || col.id) + '  ' + mine.length, x + PAD, top + 34);
      g.strokeStyle = COL.edge;
      g.lineWidth = 2;
      if (ci) { g.beginPath(); g.moveTo(x, top); g.lineTo(x, h); g.stroke(); }

      let y = top + 60;
      for (const c of mine) {
        if (y > h - 44) {
          g.fillStyle = COL.faint;
          g.font = '20px ' + UI;
          g.fillText('+' + (mine.length - (mine.indexOf(c))) + ' more', x + PAD, y + 20);
          break;
        }
        const owed = c.status && (c.status.owed || c.status.unread);
        const working = c.status && c.status.worker && c.status.worker.state === 'live';
        g.font = '21px ' + UI;
        const lines = wrap(g, c.title || c.id, cw - PAD * 2 - 18).slice(0, 2);
        const boxH = 14 + lines.length * 26;
        g.fillStyle = owed ? '#18222e' : '#101720';
        g.fillRect(x + PAD - 8, y - 4, cw - PAD * 2 + 16, boxH);
        g.fillStyle = ltColour.get(c.owner) || COL.dim;
        g.fillRect(x + PAD - 8, y - 4, 4, boxH);
        if (working) { g.fillStyle = COL.good; g.beginPath(); g.arc(x + cw - PAD - 4, y + 8, 5, 0, Math.PI * 2); g.fill(); }
        if (owed) { g.fillStyle = COL.accent; g.beginPath(); g.arc(x + cw - PAD - 4, y + 8, 5, 0, Math.PI * 2); g.fill(); }
        g.fillStyle = owed ? COL.text : COL.dim;
        lines.forEach((ln, i) => g.fillText(ln, x + PAD + 4, y + 20 + i * 26));
        this.region(x, y - 4, cw, boxH, { kind: 'card', id: c.id });
        y += boxH + 10;
      }
    });
    this.end();
  }
}

// ---------- a window: the card, and its chat beside it ----------

export class CardWindow extends Surface {
  constructor(cardId) {
    super({ widthM: 1.5, heightM: 0.95, title: '', closable: true });
    this.cardId = cardId;
  }

  paint(doc) {
    const card = (doc.cards || []).find((c) => c.id === this.cardId);
    const g = this.begin();
    if (!card) {
      this.title = this.cardId;
      const top = this.chrome(g, 'gone from the board');
      g.fillStyle = COL.faint;
      g.font = '24px ' + UI;
      g.fillText('this card is no longer on the board', PAD, top + 60);
      return this.end();
    }
    const lt = (doc.lieutenants || []).find((l) => l.id === card.owner);
    this.title = (card.title || card.id).slice(0, 46);
    const top = this.chrome(g, (lt && lt.name) || card.owner || '');

    const w = this.canvas.width, h = this.canvas.height;
    // The chat is not a panel you go and find — it is the right-hand half of the
    // card, always, because reading the work and answering it are one act.
    const split = Math.round(w * 0.52);
    g.strokeStyle = COL.edge;
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(split, top); g.lineTo(split, h); g.stroke();

    // left: what the card says
    let y = top + 34;
    g.fillStyle = COL.faint;
    g.font = '20px ' + UI;
    g.fillText(card.type + ' · ' + card.column + (card.labels && card.labels.length ? ' · ' + card.labels.join(' ') : ''), PAD, y);
    y += 30;
    g.font = '21px ' + UI;
    for (const line of wrap(g, card.body || 'no body yet', split - PAD * 2)) {
      if (y > h - 60) { g.fillStyle = COL.faint; g.fillText('…', PAD, y); break; }
      const head = /^#{1,3}\s/.test(line);
      g.fillStyle = head ? COL.text : COL.dim;
      g.font = (head ? '600 22px ' : '21px ') + UI;
      g.fillText(line.replace(/^#{1,3}\s*/, ''), PAD, y);
      y += 27;
    }

    // right: the last of the conversation, newest at the bottom
    this._chat(g, card.thread || [], split + PAD, top, w - split - PAD * 2, h, lt && lt.color);
    this.end();
  }

  // Painted from the bottom up: the newest line is the one he wants, and a chat
  // that scrolls off the top is normal where one that scrolls off the bottom is
  // a bug you notice every single time.
  //
  // Who is speaking is NOT written on every message. This is a conversation with
  // exactly one other party, and the title bar already names them — a per-message
  // name is the same word repeated down the whole column, and it is the copy that
  // scrolls away while the title bar stays. What the board's own chat does is the
  // same: the bubble's side carries the identity, the footer carries the time.
  _chat(g, msgs, x, top, width, h, colour) {
    let y = h - PAD;
    for (let i = msgs.length - 1; i >= 0 && y > top + 30; i--) {
      const m = msgs[i];
      const mine = m.author === 'user';
      g.font = '21px ' + UI;
      const lines = wrap(g, m.text || '', width - 16).slice(0, 8);
      const blockH = lines.length * 26 + 26;
      y -= blockH;
      // The oldest visible message runs off the TOP, and it has to stop at the
      // title bar rather than being painted over it.
      if (y < top + 6) break;
      g.fillStyle = mine ? '#16202c' : '#0f1620';
      g.fillRect(x - 8, y - 4, width + 16, blockH);
      // The side bar is who: the captain's own accent against the lieutenant's
      // own colour, the same mark the board puts on a card for its owner.
      g.fillStyle = mine ? COL.accent : (colour || COL.dim);
      g.fillRect(x - 8, y - 4, 4, blockH);
      g.fillStyle = COL.dim;
      g.font = '21px ' + UI;
      lines.forEach((ln, k) => g.fillText(ln, x + 4, y + 18 + k * 26));
      g.fillStyle = COL.faint;
      g.font = '18px ' + UI;
      g.textAlign = 'right';
      g.fillText(ago(m.ts), x + width, y + blockH - 6);
      g.textAlign = 'left';
      y -= 10;
    }
  }
}

// ---------- a window: a lieutenant's chat on its own ----------

export class ChatWindow extends Surface {
  constructor(ltId) {
    super({ widthM: 0.9, heightM: 0.95, title: '', closable: true });
    this.ltId = ltId;
  }

  paint(doc) {
    const lt = (doc.lieutenants || []).find((l) => l.id === this.ltId);
    const g = this.begin();
    this.title = (lt && lt.name) || this.ltId;
    const top = this.chrome(g, lt && lt.chatOwed ? '· waiting on you' : '');
    const w = this.canvas.width, h = this.canvas.height;
    CardWindow.prototype._chat.call(this, g, (lt && lt.chat) || [], PAD, top, w - PAD * 2, h, lt && lt.color);
    this.end();
  }
}
