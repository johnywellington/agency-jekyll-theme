'use strict';
/* Cliente AMI (Asterisk Manager Interface) sem dependências.
   Base aproveitada do Call Monitor: parser por blocos "\r\n\r\n", Ping a cada 30s,
   watchdog que força reconexão quando o túnel/ligação morre sem fechar o TCP,
   e religação automática. Acrescentado aqui: respostas de lista (EventList) —
   ações como PJSIPShowEndpoints devolvem vários eventos com o mesmo ActionID. */
const net = require('net');
const { EventEmitter } = require('events');

const WATCHDOG_MS = 75000; // 2 pings perdidos = ligação morta
const ACTION_TIMEOUT_MS = 10000;

class AMI extends EventEmitter {
  constructor({ host, port, user, pass }) {
    super();
    this.cfg = { host, port, user, pass };
    this.sock = null;
    this.connected = false;
    this.pending = new Map(); // ActionID -> { resolve, reject, timer, list, events }
    this.seq = 0;
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    if (this.sock) this.sock.destroy();
  }

  _connect() {
    const sock = net.connect(this.cfg.port, this.cfg.host);
    this.sock = sock;
    let buf = '';
    let lastRx = Date.now();
    let loggedIn = false;

    sock.on('connect', () => {
      this._write(sock, {
        Action: 'Login', Username: this.cfg.user, Secret: this.cfg.pass,
        Events: 'call', ActionID: 'login'
      });
    });

    sock.on('data', chunk => {
      lastRx = Date.now();
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\r\n\r\n')) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 4);
        const msg = {};
        for (const line of block.split('\r\n')) {
          const p = line.indexOf(': ');
          if (p > 0) msg[line.slice(0, p)] = line.slice(p + 2);
        }
        if (!loggedIn && msg.ActionID === 'login') {
          if (msg.Response === 'Success') {
            loggedIn = true;
            this.connected = true;
            this.emit('status', true);
          } else {
            this.emit('error', new Error('login AMI recusado: ' + (msg.Message || '')));
            sock.destroy();
          }
          continue;
        }
        this._dispatch(msg);
      }
    });

    const ping = setInterval(() => {
      if (sock.destroyed) return clearInterval(ping);
      if (loggedIn) this._write(sock, { Action: 'Ping', ActionID: 'ping' });
    }, 30000);

    const watchdog = setInterval(() => {
      if (sock.destroyed) return clearInterval(watchdog);
      if (Date.now() - lastRx > WATCHDOG_MS) {
        console.log(`AMI: sem dados há ${Math.round((Date.now() - lastRx) / 1000)}s — a reconectar`);
        sock.destroy();
      }
    }, 15000);

    sock.on('error', e => { if (!loggedIn) console.log('AMI: ' + e.message); });
    sock.on('close', () => {
      clearInterval(ping);
      clearInterval(watchdog);
      if (this.sock === sock) this.sock = null;
      for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('ligação AMI caiu')); this.pending.delete(id); }
      if (this.connected) { this.connected = false; this.emit('status', false); }
      if (!this.stopped) setTimeout(() => this._connect(), 3000);
    });
  }

  _write(sock, fields) {
    const lines = Object.entries(fields).flatMap(([k, v]) =>
      Array.isArray(v) ? v.map(x => `${k}: ${x}`) : [`${k}: ${v}`]);
    sock.write(lines.join('\r\n') + '\r\n\r\n');
  }

  _dispatch(msg) {
    const id = msg.ActionID;
    const p = id && this.pending.get(id);
    if (p) {
      if (msg.Response) {
        // resposta inicial: se abre uma lista, esperar pelo "EventList: Complete"
        if (msg.Response === 'Success' && /start/i.test(msg.EventList || '')) { p.head = msg; return; }
        // ações "simples" que respondem com um único evento a seguir (DBGet)
        if (msg.Response === 'Success' && p.expectEvent) { p.head = msg; return; }
        return this._finish(id, msg);
      }
      if (msg.Event) {
        if (/complete/i.test(msg.EventList || '') || /Complete$/.test(msg.Event)) {
          return this._finish(id, Object.assign({}, p.head, { events: p.events }));
        }
        p.events.push(msg);
        if (p.expectEvent && msg.Event === p.expectEvent) return this._finish(id, Object.assign({}, p.head, msg));
        // OriginateResponse também traz o ActionID, mas chega muito depois da resposta
        // e já não tem pendente — segue para os eventos normais em baixo
        return;
      }
    }
    if (msg.Event) this.emit('event', msg);
  }

  _finish(id, result) {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(result);
  }

  /* Envia uma ação e resolve com a resposta. Para listas, result.events traz os itens.
     opts.expectEvent: nome do evento que conclui a ação (ex.: 'DBGetResponse'). */
  action(fields, opts = {}) {
    return new Promise((resolve, reject) => {
      if (!this.sock || !this.connected) return reject(new Error('AMI não ligado'));
      const ActionID = fields.ActionID || ('cc' + Date.now().toString(36) + '-' + (++this.seq));
      const timer = setTimeout(() => {
        this.pending.delete(ActionID);
        reject(new Error('timeout AMI (' + fields.Action + ')'));
      }, opts.timeout || ACTION_TIMEOUT_MS);
      this.pending.set(ActionID, { resolve, reject, timer, events: [], head: null, expectEvent: opts.expectEvent });
      this._write(this.sock, Object.assign({}, fields, { ActionID }));
    });
  }
}

module.exports = AMI;
