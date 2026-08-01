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
//
// Not one size below is in pixels. Everything asks its own surface for degrees
// of the captain's field — `this.px(deg)` — and the surface knows how far away
// it is standing. Sizes authored in canvas pixels are what made the first room
// unreadable: 21 px is comfortable at 1.55 m and gone at 3.1 m, and the pixels
// could not tell the difference.

import { Surface, wrap, COL } from './surface.js';
import { face } from './faces.js';
import { PANEL, TYPE, HIT, BAR, FRONT, eyeDistance, placeWindow } from './room.js';

const WINDOW_D = eyeDistance(placeWindow(0, 1));   // where a window first lands

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
    super({ ...PANEL.bar, distanceM: eyeDistance(BAR), title: '', closable: false });
  }

  paint(doc) {
    const g = this.begin();
    const w = this.canvas.width, h = this.canvas.height;
    const lts = doc.lieutenants || [];
    const cell = w / Math.max(1, lts.length);
    // ponytail: past ~11 lieutenants a cell is under the 3° + 1.6° a hand can
    // land on. Page the bar when that is a real number of lieutenants.
    const gap = this.px(HIT.gap);
    const r = Math.min(this.px(1.7), h * 0.28);
    lts.forEach((l, i) => {
      const x = i * cell;
      const owed = !!l.chatOwed;
      g.save();
      g.beginPath();
      g.rect(x, 0, cell, h);
      g.clip();                       // a long name stays in its own cell
      g.fillStyle = owed ? '#1d2836' : '#111823';
      g.fillRect(x + gap / 2, this.px(0.2), cell - gap, h - this.px(0.4));
      // A lieutenant waiting on the captain is the only thing in this room that
      // is allowed to shout, because it is the only thing that is his move.
      if (owed) {
        g.fillStyle = COL.accent;
        g.fillRect(x + gap / 2, this.px(0.2), this.px(0.22), h - this.px(0.4));
      }
      face(g, l.avatar, x + cell / 2, h * 0.38, r, l.color || COL.accent);
      g.fillStyle = owed ? COL.text : COL.dim;
      g.font = this.font(TYPE.meta, 600);
      g.textAlign = 'center';
      g.fillText(l.name || l.id, x + cell / 2, h - this.px(0.5));
      g.textAlign = 'left';
      g.restore();
      // The plate is what he aims at, and the 1.6° between two plates is what
      // keeps the wrong lieutenant from answering.
      this.region(x + gap / 2, 0, cell - gap, h, { kind: 'lieutenant', id: l.id });
    });
    this.end();
  }
}

// ---------- the board: where he decides what to look at next ----------

export class BoardPanel extends Surface {
  constructor() {
    super({ ...PANEL.board, distanceM: eyeDistance(FRONT), title: 'board', closable: false });
  }

  paint(doc) {
    const g = this.begin();
    const top = this.chrome(g, doc.title || '');
    const w = this.canvas.width, h = this.canvas.height;
    const pad = this.px(0.8), gap = this.px(HIT.gap), floor = this.px(HIT.min);
    const lh = this.line(TYPE.body);
    const cols = (doc.columns || []).filter((c) => c.id !== 'peer');
    const cw = w / Math.max(1, cols.length);
    const ltColour = new Map((doc.lieutenants || []).map((l) => [l.id, l.color || COL.dim]));

    cols.forEach((col, ci) => {
      const x = ci * cw;
      const mine = (doc.cards || []).filter((c) => c.column === col.id);
      g.fillStyle = COL.faint;
      g.font = this.font(TYPE.meta, 600);
      g.fillText((col.title || col.id) + '  ' + mine.length, x + pad, top + this.px(1.6));
      g.strokeStyle = COL.edge;
      g.lineWidth = Math.max(1, this.px(0.06));
      if (ci) { g.beginPath(); g.moveTo(x, top); g.lineTo(x, h); g.stroke(); }

      let y = top + this.px(2.6);
      for (const c of mine) {
        const owed = c.status && (c.status.owed || c.status.unread);
        const working = c.status && c.status.worker && c.status.worker.state === 'live';
        g.font = this.font(TYPE.body);
        const lines = wrap(g, c.title || c.id, cw - pad * 2 - this.px(0.8)).slice(0, 2);
        // A card is a target before it is a label: never shorter than 3°, even
        // when its title is one line.
        const boxH = Math.max(floor, lines.length * lh + this.px(0.6));
        if (y + boxH > h - gap) {
          g.fillStyle = COL.faint;
          g.font = this.font(TYPE.meta);
          g.fillText('+' + (mine.length - mine.indexOf(c)) + ' more', x + pad, y + this.px(1.2));
          break;
        }
        g.fillStyle = owed ? '#18222e' : '#101720';
        g.fillRect(x + pad * 0.5, y, cw - pad, boxH);
        g.fillStyle = ltColour.get(c.owner) || COL.dim;
        g.fillRect(x + pad * 0.5, y, this.px(0.18), boxH);
        const dot = this.px(0.22);
        if (working) { g.fillStyle = COL.good; g.beginPath(); g.arc(x + cw - pad, y + this.px(0.7), dot, 0, Math.PI * 2); g.fill(); }
        if (owed) { g.fillStyle = COL.accent; g.beginPath(); g.arc(x + cw - pad, y + this.px(0.7), dot, 0, Math.PI * 2); g.fill(); }
        g.fillStyle = owed ? COL.text : COL.dim;
        lines.forEach((ln, i) => g.fillText(ln, x + pad, y + this.px(0.3) + lh * (i + 0.78)));
        this.region(x + pad * 0.5, y, cw - pad, boxH, { kind: 'card', id: c.id });
        y += boxH + gap;
      }
    });
    this.end();
  }
}

// ---------- a window: the card, and its chat beside it ----------

export class CardWindow extends Surface {
  constructor(cardId) {
    super({ ...PANEL.card, distanceM: WINDOW_D, title: '', closable: true });
    this.cardId = cardId;
  }

  paint(doc) {
    const card = (doc.cards || []).find((c) => c.id === this.cardId);
    const g = this.begin();
    const pad = this.px(0.8);
    if (!card) {
      this.title = this.cardId;
      const top = this.chrome(g, 'gone from the board');
      g.fillStyle = COL.faint;
      g.font = this.font(TYPE.body);
      g.fillText('this card is no longer on the board', pad, top + this.px(2.4));
      return this.end();
    }
    const lt = (doc.lieutenants || []).find((l) => l.id === card.owner);
    this.title = card.title || card.id;
    const top = this.chrome(g, (lt && lt.name) || card.owner || '');

    const w = this.canvas.width, h = this.canvas.height;
    const lh = this.line(TYPE.body);
    // The chat is not a panel you go and find — it is the right-hand half of the
    // card, always, because reading the work and answering it are one act.
    const split = Math.round(w * 0.52);
    g.strokeStyle = COL.edge;
    g.lineWidth = Math.max(1, this.px(0.06));
    g.beginPath(); g.moveTo(split, top); g.lineTo(split, h); g.stroke();

    // left: what the card says
    let y = top + this.px(1.6);
    g.fillStyle = COL.faint;
    g.font = this.font(TYPE.meta);
    g.fillText(card.type + ' · ' + card.column + (card.labels && card.labels.length ? ' · ' + card.labels.join(' ') : ''), pad, y);
    y += lh;
    g.font = this.font(TYPE.body);
    for (const line of wrap(g, card.body || 'no body yet', split - pad * 2)) {
      if (y > h - lh) { g.fillStyle = COL.faint; g.fillText('…', pad, y); break; }
      const head = /^#{1,3}\s/.test(line);
      g.fillStyle = head ? COL.text : COL.dim;
      g.font = this.font(head ? TYPE.head : TYPE.body, head ? 600 : '');
      g.fillText(line.replace(/^#{1,3}\s*/, ''), pad, y);
      y += head ? this.line(TYPE.head) : lh;
    }

    // right: the last of the conversation, newest at the bottom
    this._chat(g, card.thread || [], split + pad, top, w - split - pad * 2, h, lt && lt.color);
    this.end();
  }

  // Painted from the bottom up: the newest line is the one he wants, and a chat
  // that scrolls off the top is normal where one that scrolls off the bottom is
  // a bug you notice every single time.
  //
  // Who is speaking is NOT written on every message. This is a conversation with
  // exactly one other party, and the title bar already names them and now wears
  // their face — a per-message name is the same word repeated down the whole
  // column, and it is the copy that scrolls away while the title bar stays. What
  // the board's own chat does is the same: the bubble's side carries the
  // identity, the footer carries the time.
  _chat(g, msgs, x, top, width, h, colour) {
    const pad = this.px(0.8), lh = this.line(TYPE.body);
    let y = h - pad;
    for (let i = msgs.length - 1; i >= 0 && y > top + lh; i--) {
      const m = msgs[i];
      const mine = m.author === 'user';
      g.font = this.font(TYPE.body);
      const lines = wrap(g, m.text || '', width - pad).slice(0, 8);
      const blockH = lines.length * lh + this.line(TYPE.meta);
      y -= blockH;
      // The oldest visible message runs off the TOP, and it has to stop at the
      // title bar rather than being painted over it.
      if (y < top + this.px(0.2)) break;
      g.fillStyle = mine ? '#16202c' : '#0f1620';
      g.fillRect(x - pad * 0.4, y - this.px(0.15), width + pad * 0.8, blockH);
      // The side bar is who: the captain's own accent against the lieutenant's
      // own colour, the same mark the board puts on a card for its owner.
      g.fillStyle = mine ? COL.accent : (colour || COL.dim);
      g.fillRect(x - pad * 0.4, y - this.px(0.15), this.px(0.18), blockH);
      g.fillStyle = COL.dim;
      g.font = this.font(TYPE.body);
      lines.forEach((ln, k) => g.fillText(ln, x + pad * 0.2, y + lh * (k + 0.78)));
      g.fillStyle = COL.faint;
      g.font = this.font(TYPE.meta);
      g.textAlign = 'right';
      g.fillText(ago(m.ts), x + width, y + blockH - this.px(0.25));
      g.textAlign = 'left';
      y -= this.px(0.4);
    }
  }
}

// ---------- a window: a lieutenant's chat on its own ----------

export class ChatWindow extends Surface {
  constructor(ltId) {
    super({ ...PANEL.chat, distanceM: WINDOW_D, title: '', closable: true });
    this.ltId = ltId;
  }

  paint(doc) {
    const lt = (doc.lieutenants || []).find((l) => l.id === this.ltId);
    const g = this.begin();
    this.title = (lt && lt.name) || this.ltId;
    // The face goes in the title bar, where the flat board puts it: this window
    // is one conversation with one lieutenant, and the bar is the one place that
    // says so and stays put while the messages scroll away underneath.
    const top = this.chrome(g, lt && lt.chatOwed ? '· waiting on you' : '',
      { avatar: lt && lt.avatar, colour: (lt && lt.color) || COL.accent });
    const w = this.canvas.width, h = this.canvas.height;
    const pad = this.px(0.8);
    CardWindow.prototype._chat.call(this, g, (lt && lt.chat) || [], pad, top, w - pad * 2, h, lt && lt.color);
    this.end();
  }
}
