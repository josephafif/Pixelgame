// Multiplayer additions to the HUD: where you are (town / wild / clan land),
// your ping, a small chat, the death screen and (with ?debug=1) a network
// overlay showing how smooth the connection is.

import { $, h, clear } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { isModalOpen } from '../ui/modal.js';

export class MpHud {
  constructor(game, app) {
    this.game = game;
    this.app = app;
    const hud = $('#hud');
    this.zone = h('div.mp-zone', { 'aria-live': 'polite' });
    this.chatLog = h('div.mp-chat-log', { 'aria-live': 'polite' });
    this.chatBtn = h('button.mp-chat-btn', { 'aria-label': 'Chatt', onclick: (e) => { e.currentTarget.blur(); this.openChat(); } }, icon('chat', 20));
    this.debug = h('div.mp-debug', { hidden: !new URLSearchParams(location.search).has('debug') });
    hud.append(this.zone, this.chatLog, this.chatBtn, this.debug);
    this.net = $('#net-status');
    game.on('hud', (s) => this.update(s));
    game.on('chat', (msg) => this.addLine(msg));
    game.on('death', (info) => this.death(info));
    addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || isModalOpen() || !app.started) return;
      // T opens the chat (Enter attacks, like in single player).
      if (e.code === 'KeyT' && !e.repeat) {
        e.preventDefault();
        this.openChat('all');
      }
    });
  }

  update(s) {
    const z = s.zone;
    if (z) {
      const text = `${z.label}${z.protectedNow ? ' · skyddad' : z.newbie ? ' · nybörjarskydd' : ''}`;
      if (this.zone.textContent !== text) this.zone.textContent = text;
      this.zone.dataset.kind = z.kind;
    }
    if (this.net) {
      const t = `● ${s.ping} ms`;
      if (this.net.textContent !== t) this.net.textContent = t;
      this.net.classList.toggle('slow', s.ping > 180);
    }
    if (!this.debug.hidden) {
      const d = this.game.netDebug();
      this.debug.textContent = `ping ${d.ping} ms · interp ${d.interpMs} ms · väntande inputs ${d.pending} · rättningar ${d.corrections} (stora ${d.bigCorrections}) · senaste fel ${d.lastError.toFixed(3)} · ${d.kbps} kbit/s · ${d.entities} entiteter`;
    }
  }

  addLine(msg) {
    const line = msg.t === 'sys'
      ? h('div.line.sys', msg.text)
      : h('div.line', { class: msg.ch === 'clan' ? 'clan' : null },
        h('b', `${msg.tag ? `[${msg.tag}] ` : ''}${msg.from}: `), msg.text);
    this.chatLog.append(line);
    while (this.chatLog.children.length > 6) this.chatLog.firstChild.remove();
    setTimeout(() => line.classList.add('old'), 12000);
  }

  openChat(channel = 'all') {
    if (this.input) {
      this.input.focus();
      return;
    }
    let ch = channel;
    const field = h('input', { type: 'text', maxlength: 200, placeholder: 'Skriv… (/help för kommandon)', enterkeyhint: 'send' });
    const toggle = h('button.mp-chat-ch', {
      onclick: () => {
        ch = ch === 'all' ? 'clan' : 'all';
        toggle.textContent = ch === 'all' ? 'Alla' : 'Klan';
        field.focus();
      },
    }, ch === 'all' ? 'Alla' : 'Klan');
    const close = () => {
      bar.remove();
      this.input = null;
      this.game.resume('chat');
    };
    const send = () => {
      const text = field.value.trim();
      if (text) this.game.chat(text, ch);
      close();
    };
    field.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') send();
      if (e.key === 'Escape') close();
    });
    const bar = h('div.mp-chat-bar', toggle, field, h('button.btn-primary', { onclick: send }, 'Skicka'), h('button', { onclick: close, 'aria-label': 'Stäng' }, '×'));
    $('#hud').append(bar);
    this.input = field;
    this.game.pause('chat');
    field.focus();
  }

  death(info) {
    const el = $('#death');
    if (!el) return;
    clear(el).append(
      h('h2', 'Du föll'),
      h('p', info?.by ? `${info.by} besegrade dig.` : 'Du återuppstår snart.'),
      h('p.small', 'En del av det du bar ligger kvar i en säck där du dog.'));
  }
}
