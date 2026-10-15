/*
 * Timers Sequenciais + Buffer — versão web com sessões sincronizadas.
 *
 * Como a sincronia funciona
 * -------------------------
 * O estado da sessão (configuração + andamento) é um único objeto JSON publicado
 * como mensagem RETIDA no tópico MQTT `gfnp-timers/v1/<código>/state`.
 * Quem entra na sessão recebe imediatamente a última versão. Cada alteração
 * gera uma nova revisão (`rev`) e vence quem tiver a revisão maior.
 *
 * O tempo nunca é transmitido "tick a tick": o estado guarda quanto cada timer já
 * acumulou e o instante (epoch ms) em que o timer atual voltou a correr. Cada
 * navegador calcula o relógio localmente, então todos mostram o mesmo valor.
 *
 * Por redundância, o app conecta a dois brokers públicos ao mesmo tempo e publica
 * em ambos; se um cair, o outro mantém a sessão.
 */
'use strict';

(function () {
  // ------------------------------------------------------------------ consts
  const PALETTE = ['#3b82f6', '#14b8a6', '#a855f7', '#ec4899', '#eab308', '#06b6d4', '#84cc16', '#f472b6'];
  const C = { green: '#22c55e', amber: '#f59e0b', orange: '#f97316', red: '#ef4444', fg: '#e2e8f0', muted: '#94a3b8', gray: '#475569' };
  const TOPIC_ROOT = 'gfnp-timers/v1';
  const CODE_ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
  const params = new URLSearchParams(location.search);
  const BROKERS = (params.get('broker') || 'wss://broker.emqx.io:8084/mqtt,wss://broker.hivemq.com:8884/mqtt')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const HEARTBEAT_MS = 20000;
  const PEER_TTL_MS = 65000;
  const JOIN_WAIT_MS = 4000;
  const R = 150;
  const CIRC = 2 * Math.PI * R;

  // ------------------------------------------------------------------- utils
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const store = {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* sem storage */ } },
  };
  function rid(n) {
    const a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return Array.from(a, (x) => CODE_ALPHA[x % CODE_ALPHA.length]).join('');
  }
  const pad = (n) => String(n).padStart(2, '0');
  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }
  const ceilS = (x) => Math.ceil(x - 1e-6);
  function parseDuration(text, allowZero = false) {
    const t = String(text).trim().replace(',', '.');
    if (!t) return NaN;
    let sec;
    if (t.includes(':')) {
      const parts = t.split(':').map((p) => (p === '' ? NaN : Number(p)));
      if (parts.some((p) => !isFinite(p) || p < 0)) return NaN;
      if (parts.length === 2) sec = parts[0] * 60 + parts[1];
      else if (parts.length === 3) sec = parts[0] * 3600 + parts[1] * 60 + parts[2];
      else return NaN;
    } else {
      if (!/^\d*\.?\d+$/.test(t)) return NaN;
      sec = parseFloat(t) * 60;
    }
    sec = Math.round(sec);
    if (!isFinite(sec) || sec < 0 || (sec === 0 && !allowZero) || sec > 172800) return NaN;
    return sec;
  }
  function durText(sec) {
    return sec % 60 === 0 ? String(sec / 60) : `${Math.floor(sec / 60)}:${pad(sec % 60)}`;
  }
  const colorFor = (f) => (f > 0.5 ? C.green : f > 0.2 ? C.amber : C.orange);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const hhmm = (ms) => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  function colorOf(str) {
    let h = 0;
    for (const ch of String(str)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }
  function initials(name) {
    const p = String(name || '?').trim().split(/\s+/);
    return ((p[0] || '?')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
  }

  // ------------------------------------------------------------------- model
  const Model = {
    defaultConfig() {
      return {
        title: '',
        timers: [
          { id: rid(6), name: 'Timer 1', dur: 1200 },
          { id: rid(6), name: 'Timer 2', dur: 600 },
          { id: rid(6), name: 'Timer 3', dur: 900 },
        ],
        buffer: 1800,
        giveback: false,
      };
    },
    initialRun(n) {
      return { started: false, finished: false, running: false, index: 0, since: 0,
        elapsed: Array(n).fill(0), done: Array(n).fill(false) };
    },
    newState(owner) {
      const config = Model.defaultConfig();
      return { v: 1, rev: 0, by: '', owner: owner || '', hostOnly: false, config, run: Model.initialRun(config.timers.length) };
    },
    sanitize(s) {
      if (!s || typeof s !== 'object' || !s.config || !s.run) return null;
      const cfg = s.config;
      if (!Array.isArray(cfg.timers) || !cfg.timers.length || cfg.timers.length > 60) return null;
      const timers = cfg.timers.map((t, i) => ({
        id: String((t && t.id) || rid(6)).slice(0, 16),
        name: String((t && t.name) || `Timer ${i + 1}`).slice(0, 40),
        dur: Math.max(1, Math.min(172800, Math.round(Number(t && t.dur) || 60))),
      }));
      const n = timers.length;
      const r = s.run;
      const arr = (a, f) => Array.from({ length: n }, (_, i) => f(Array.isArray(a) ? a[i] : undefined));
      const run = {
        started: !!r.started, finished: !!r.finished, running: !!r.running && !r.finished,
        index: Math.max(0, Math.min(n, Number(r.index) | 0)), since: Number(r.since) || 0,
        elapsed: arr(r.elapsed, (x) => Math.max(0, Number(x) || 0)),
        done: arr(r.done, (x) => !!x),
      };
      if (!run.finished && run.index >= n) run.index = n - 1;
      return {
        v: 1, rev: Number(s.rev) || 0, by: String(s.by || '').slice(0, 24), owner: String(s.owner || '').slice(0, 24),
        hostOnly: !!s.hostOnly,
        config: {
          title: String(cfg.title || '').slice(0, 40), timers,
          buffer: Math.max(0, Math.min(172800, Math.round(Number(cfg.buffer) || 0))),
          giveback: !!cfg.giveback,
        },
        run,
      };
    },
    newer(a, b) {
      if (!b) return true;
      if (!a) return false;
      if (a.rev !== b.rev) return a.rev > b.rev;
      return (a.by || '') > (b.by || '');
    },
    derive(s, t) {
      const r = s.run, cfg = s.config;
      const live = r.running && !r.finished;
      const timers = cfg.timers.map((tm, i) => {
        let e = r.elapsed[i] || 0;
        if (live && i === r.index) e += Math.max(0, (t - r.since) / 1000);
        return { ...tm, i, elapsed: e, remaining: Math.max(0, tm.dur - e), overtime: Math.max(0, e - tm.dur), done: !!r.done[i] };
      });
      const used = timers.reduce((a, x) => a + x.overtime, 0);
      const credit = cfg.giveback ? timers.reduce((a, x) => a + (x.done ? x.remaining : 0), 0) : 0;
      const cap = cfg.buffer + credit;
      return {
        timers, used, credit, cap, left: cap - used, buffer: cfg.buffer, giveback: cfg.giveback,
        cur: r.finished ? null : timers[r.index],
        plannedRemaining: timers.reduce((a, x) => a + (x.done ? 0 : x.remaining), 0),
        totalElapsed: timers.reduce((a, x) => a + x.elapsed, 0),
        started: r.started, running: live, finished: r.finished, index: r.index, n: timers.length,
      };
    },
    apply(s, action, t, me) {
      const n = clone(s);
      let r = n.run;
      const fold = () => {
        if (r.running && !r.finished) {
          r.elapsed[r.index] = (r.elapsed[r.index] || 0) + Math.max(0, (t - r.since) / 1000);
          r.since = t;
        }
      };
      switch (action.type) {
        case 'play':
          if (r.finished || r.running) return s;
          if (!r.started) { n.run = r = Model.initialRun(n.config.timers.length); r.started = true; }
          r.running = true; r.since = t;
          break;
        case 'pause':
          if (!r.running) return s;
          fold(); r.running = false;
          break;
        case 'next':
          if (!r.started || r.finished) return s;
          fold();
          r.done[r.index] = true;
          r.index += 1;
          if (r.index >= n.config.timers.length) { r.finished = true; r.running = false; } else { r.since = t; }
          break;
        case 'reset':
          n.run = Model.initialRun(n.config.timers.length);
          break;
        case 'config':
          if (r.started) return s;
          n.config = action.config;
          n.run = Model.initialRun(action.config.timers.length);
          break;
        case 'hostOnly':
          n.hostOnly = !!action.value;
          break;
        default:
          return s;
      }
      n.rev = Math.max(Math.round(t), (s.rev || 0) + 1);
      n.by = me;
      return n;
    },
  };

  // -------------------------------------------------------------------- sync
  class Sync {
    constructor(code, me, handlers) {
      this.me = me;
      this.h = handlers;
      this.tState = `${TOPIC_ROOT}/${code}/state`;
      this.tPres = `${TOPIC_ROOT}/${code}/p/`;
      this.clients = [];
      this.gotState = new Set();
      this.presence = {};
      this.hb = null;
      this.stopped = false;
    }
    start(presence) {
      this.presence = presence;
      if (typeof mqtt === 'undefined') { this.h.status(0, BROKERS.length); return; }
      BROKERS.forEach((url, i) => {
        let cl;
        try {
          cl = mqtt.connect(url, {
            clientId: `tt_${this.me}_${i}_${rid(4)}`, clean: true, keepalive: 30,
            reconnectPeriod: 4000, connectTimeout: 10000, protocolVersion: 4,
            will: { topic: this.tPres + this.me, payload: '', retain: true, qos: 0 },
          });
        } catch (e) { return; }
        cl.on('connect', () => {
          this.gotState.delete(i);
          cl.subscribe([this.tState, this.tPres + '+'], { qos: 1 });
          this.pubPresence(cl);
          setTimeout(() => { if (!this.stopped && cl.connected && !this.gotState.has(i)) this.h.seed(cl); }, 2500);
          this.status();
        });
        ['close', 'offline', 'error', 'reconnect', 'end'].forEach((ev) => cl.on(ev, () => this.status()));
        cl.on('message', (topic, payload) => {
          const text = payload ? payload.toString() : '';
          if (topic === this.tState) {
            this.gotState.add(i);
            if (!text) return;
            try { this.h.state(JSON.parse(text), cl); } catch (e) { /* ignora lixo */ }
          } else if (topic.startsWith(this.tPres)) {
            const id = topic.slice(this.tPres.length);
            let p = null;
            if (text) { try { p = JSON.parse(text); } catch (e) { p = null; } }
            this.h.presence(id, p);
          }
        });
        this.clients.push(cl);
      });
      this.hb = setInterval(() => this.clients.forEach((c) => c.connected && this.pubPresence(c)), HEARTBEAT_MS);
      this.status();
    }
    pubPresence(cl) {
      cl.publish(this.tPres + this.me, JSON.stringify({ ...this.presence, ts: now() }), { retain: true, qos: 0 });
    }
    setPresence(p) {
      this.presence = p;
      this.clients.forEach((c) => c.connected && this.pubPresence(c));
    }
    publish(st, only) {
      const msg = JSON.stringify(st);
      (only ? [only] : this.clients).forEach((c) => { if (c.connected) c.publish(this.tState, msg, { retain: true, qos: 1 }); });
    }
    status() { this.h.status(this.clients.filter((c) => c.connected).length, BROKERS.length); }
    stop() {
      this.stopped = true;
      clearInterval(this.hb);
      this.clients.forEach((c) => {
        try { if (c.connected) c.publish(this.tPres + this.me, '', { retain: true, qos: 0 }); c.end(false); } catch (e) { /* noop */ }
      });
      this.clients = [];
    }
  }

  // ------------------------------------------------------------- sound/wake
  const Sound = {
    ctx: null,
    on: store.get('tt_sound', true),
    unlock() {
      if (!this.ctx) { try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; } }
      if (this.ctx.state === 'suspended') this.ctx.resume();
    },
    beep(freqs, dur = 0.18) {
      if (!this.on || !this.ctx) return;
      let t = this.ctx.currentTime + 0.02;
      freqs.forEach((f) => {
        if (f) {
          const o = this.ctx.createOscillator(), g = this.ctx.createGain();
          o.type = 'sine'; o.frequency.value = f;
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
          o.connect(g).connect(this.ctx.destination);
          o.start(t); o.stop(t + dur + 0.05);
        }
        t += dur + 0.06;
      });
    },
  };
  const vibrate = (p) => { try { navigator.vibrate && navigator.vibrate(p); } catch (e) { /* noop */ } };
  const Wake = {
    lock: null, busy: false,
    async want(on) {
      if (this.busy || !('wakeLock' in navigator)) return;
      this.busy = true;
      try {
        if (on && !this.lock && document.visibilityState === 'visible') {
          this.lock = await navigator.wakeLock.request('screen');
          this.lock.addEventListener('release', () => { this.lock = null; });
        } else if (!on && this.lock) {
          await this.lock.release(); this.lock = null;
        }
      } catch (e) { /* sem permissão */ }
      this.busy = false;
    },
  };

  // --------------------------------------------------------------------- app
  const App = {
    me: (() => { let id = store.get('tt_me'); if (!id) { id = rid(10); store.set('tt_me', id); } return id; })(),
    name: store.get('tt_name', ''),
    mode: null, code: null, state: null, sync: null, clockOffset: 0,
    peers: new Map(), net: { up: 0, total: 0 },
    waiting: false, waitTimer: null,
    alerted: new Set(), flashUntil: 0, toastUntil: 0, prevFinished: false,
    cfgTimer: null, cfgPending: false,
  };
  const now = () => Date.now() + App.clockOffset;
  window.__tt = { // usado nos testes automatizados
    App, Model, parseDuration, fmt,
    get Pip() { return Pip; },
    inject(st) { App.state = st; persist(); if (App.sync) App.sync.publish(st); renderAll(); },
  };

  async function syncClock() {
    if (!/^https?:$/.test(location.protocol)) return;
    try {
      const samples = [];
      for (let k = 0; k < 3; k++) {
        const t0 = Date.now();
        const res = await fetch(`${location.pathname}?_clk=${t0}`, { method: 'HEAD', cache: 'no-store' });
        const t1 = Date.now();
        const d = res.headers.get('Date');
        if (!d) return;
        samples.push({ off: Date.parse(d) + 500 - (t0 + t1) / 2, rtt: t1 - t0 });
      }
      samples.sort((a, b) => a.rtt - b.rtt);
      // relógios com NTP costumam estar a <1 s; só corrige desvios grandes
      if (Math.abs(samples[0].off) > 1500) App.clockOffset = samples[0].off;
    } catch (e) { /* offline */ }
  }

  // ------------------------------------------------------------------ router
  function route() {
    teardown();
    const h = decodeURIComponent(location.hash.replace(/^#/, ''));
    const m = h.match(/^s=([a-z0-9]{4,40})$/i);
    if (m) startSession(m[1].toLowerCase());
    else if (h === 'local') startLocal();
    else showHome();
  }
  function teardown() {
    if (App.sync) { App.sync.stop(); App.sync = null; }
    clearTimeout(App.waitTimer);
    clearTimeout(App.cfgTimer);
    App.cfgPending = false;
    App.peers.clear();
    App.alerted.clear();
    App.mode = null;
  }
  function showHome() {
    if (Pip.mode) Pip.close();
    $('#app').hidden = true;
    $('#home').hidden = false;
    $('#homeName').value = App.name;
    document.title = 'Timers Sequenciais + Buffer';
  }
  function showApp() {
    $('#home').hidden = true;
    $('#app').hidden = false;
    $('#rows').dataset.key = '';
    App.prevFinished = App.state.run.finished;
    renderAll();
  }
  function startLocal() {
    App.mode = 'local';
    App.code = null;
    App.state = Model.sanitize(store.get('tt_local')) || Model.newState(App.me);
    App.waiting = false;
    showApp();
  }
  function startSession(code) {
    App.mode = 'session';
    App.code = code;
    const cached = Model.sanitize(store.get('tt_s_' + code));
    const owned = store.get('tt_own_' + code, false);
    if (cached) App.state = cached;
    else if (owned) { App.state = Model.newState(App.me); App.state.rev = Math.round(now()); App.state.by = App.me; }
    else App.state = Model.newState('');
    App.waiting = !cached && !owned;
    if (App.waiting) {
      App.waitTimer = setTimeout(() => { App.waiting = false; renderAll(); }, JOIN_WAIT_MS);
    }
    App.sync = new Sync(code, App.me, {
      state: onRemoteState,
      presence: onPresence,
      status: (up, total) => { App.net = { up, total }; renderNet(); },
      seed: (cl) => { if (App.state.rev > 0) App.sync.publish(App.state, cl); },
    });
    App.sync.start(presence());
    showApp();
  }
  function presence() {
    return { name: App.name || 'Anônimo', owner: App.state && App.state.owner === App.me };
  }

  // ----------------------------------------------------------- state change
  function onRemoteState(raw, cl) {
    const st = Model.sanitize(raw);
    if (!st) return;
    if (Model.newer(st, App.state)) {
      const wasOwner = App.state.owner === App.me;
      App.state = st;
      if (App.waiting) { App.waiting = false; clearTimeout(App.waitTimer); }
      persist();
      renderAll();
      if (wasOwner !== (st.owner === App.me) && App.sync) App.sync.setPresence(presence());
    } else if (App.state.rev > 0 && Model.newer(App.state, st)) {
      App.sync.publish(App.state, cl); // este broker ficou com versão antiga: corrige
    }
  }
  function onPresence(id, p) {
    if (id === App.me) return;
    if (p && typeof p === 'object') App.peers.set(id, { name: String(p.name || 'Anônimo').slice(0, 24), owner: !!p.owner, ts: Number(p.ts) || 0 });
    else App.peers.delete(id);
    renderPeers();
  }
  function canControl() {
    if (App.mode !== 'session') return true;
    if (App.waiting) return false;
    const s = App.state;
    return !s.hostOnly || !s.owner || s.owner === App.me;
  }
  function commit(action) {
    if (!canControl()) {
      toast(App.waiting ? 'Conectando à sessão…' : 'Somente o anfitrião pode controlar esta sessão', C.amber);
      return false;
    }
    const next = Model.apply(App.state, action, now(), App.me);
    if (next === App.state) return false;
    App.state = next;
    persist();
    if (App.sync) App.sync.publish(next);
    renderAll();
    return true;
  }
  function persist() {
    if (App.mode === 'local') store.set('tt_local', App.state);
    else if (App.mode === 'session') store.set('tt_s_' + App.code, App.state);
  }

  // ------------------------------------------------------------ config edit
  function readConfigFromDOM() {
    let ok = true;
    const timers = $$('#rows .trow').map((row, i) => {
      const di = $('.r-dur', row);
      const d = parseDuration(di.value);
      di.classList.toggle('bad', isNaN(d));
      if (isNaN(d)) ok = false;
      return { id: row.dataset.id, name: $('.r-name', row).value.trim().slice(0, 40) || `Timer ${i + 1}`, dur: d };
    });
    const bi = $('#cfgBuffer');
    const b = parseDuration(bi.value, true);
    bi.classList.toggle('bad', isNaN(b));
    if (isNaN(b)) ok = false;
    if (!ok || !timers.length) return null;
    return { title: $('#cfgTitle').value.trim().slice(0, 40), timers, buffer: b, giveback: $('#cfgGiveback').checked };
  }
  function scheduleConfigCommit(delay = 350) {
    clearTimeout(App.cfgTimer);
    App.cfgPending = true;
    App.cfgTimer = setTimeout(flushConfig, delay);
  }
  function flushConfig() {
    clearTimeout(App.cfgTimer);
    if (!App.cfgPending) return;
    App.cfgPending = false;
    const cfg = readConfigFromDOM();
    renderSummary(cfg);
    if (cfg && JSON.stringify(cfg) !== JSON.stringify(App.state.config)) commit({ type: 'config', config: cfg });
  }
  function baseConfig() {
    clearTimeout(App.cfgTimer);
    App.cfgPending = false;
    return readConfigFromDOM() || clone(App.state.config);
  }
  function rowAction(act, id) {
    const cfg = baseConfig();
    const i = cfg.timers.findIndex((t) => t.id === id);
    if (i < 0) return;
    if (act === 'del') { if (cfg.timers.length <= 1) return; cfg.timers.splice(i, 1); }
    else if (act === 'up' && i > 0) [cfg.timers[i - 1], cfg.timers[i]] = [cfg.timers[i], cfg.timers[i - 1]];
    else if (act === 'down' && i < cfg.timers.length - 1) [cfg.timers[i + 1], cfg.timers[i]] = [cfg.timers[i], cfg.timers[i + 1]];
    else return;
    commit({ type: 'config', config: cfg });
  }
  function addTimer() {
    const cfg = baseConfig();
    if (cfg.timers.length >= 60) return;
    cfg.timers.push({ id: rid(6), name: `Timer ${cfg.timers.length + 1}`, dur: 600 });
    if (commit({ type: 'config', config: cfg })) {
      const last = $('#rows .trow:last-child .r-name');
      if (last) { last.focus(); last.select(); }
    }
  }

  // ------------------------------------------------------------------ render
  function renderAll() {
    renderTop();
    renderConfig();
    renderDash();
  }

  function renderTop() {
    const session = App.mode === 'session';
    $('#sessionBox').hidden = !session;
    $('#sessCode').textContent = App.code || '';
    $('#btnSound').classList.toggle('off', !Sound.on);
    $('#btnSound').textContent = Sound.on ? '🔔' : '🔕';
    $('#btnLeave').textContent = session ? 'Sair' : 'Início';
    renderNet();
    renderPeers();
  }
  function renderNet() {
    const el = $('#netStatus');
    el.className = 'net';
    let text, title;
    if (App.mode !== 'session') { text = 'Modo local'; title = 'Sem sincronia'; }
    else if (typeof mqtt === 'undefined') { el.classList.add('down'); text = 'Sem sincronia'; title = 'A biblioteca de sincronia não carregou'; }
    else if (App.net.up === 0) { el.classList.add('down'); text = 'Conectando…'; title = 'Tentando conectar aos servidores de sincronia'; }
    else if (App.waiting) { el.classList.add('partial'); text = 'Buscando sessão…'; title = 'Conectado, aguardando o estado da sessão'; }
    else if (App.net.up < App.net.total) { el.classList.add('partial'); text = 'Sincronizado'; title = `Conectado a ${App.net.up} de ${App.net.total} servidores`; }
    else { el.classList.add('ok'); text = 'Sincronizado'; title = `Conectado a ${App.net.up} de ${App.net.total} servidores`; }
    $('span', el).textContent = text;
    el.title = title;
  }
  function renderPeers() {
    const el = $('#peers');
    if (App.mode !== 'session') { el.innerHTML = ''; return; }
    const t = now();
    const list = [{ id: App.me, name: App.name || 'Você', owner: App.state.owner === App.me, me: true }];
    App.peers.forEach((p, id) => { if (t - p.ts < PEER_TTL_MS) list.push({ id, ...p, owner: App.state.owner === id }); });
    list.sort((a, b) => (b.owner - a.owner) || (b.me - a.me));
    const shown = list.slice(0, 6);
    el.innerHTML = shown.map((p) => `<div class="avatar${p.me ? ' me' : ''}" style="background:${colorOf(p.id)}" title="${esc(p.name)}${p.me ? ' (você, clique para trocar o nome)' : ''}${p.owner ? ' · anfitrião' : ''}">${esc(initials(p.name))}${p.owner ? '<span class="crown">👑</span>' : ''}</div>`).join('')
      + (list.length > shown.length ? `<div class="avatar" style="background:#475569">+${list.length - shown.length}</div>` : '')
      + `<span class="peers-count">${list.length} online</span>`;
  }

  function setVal(el, v) { if (document.activeElement !== el && el.value !== v) el.value = v; }

  function renderConfig() {
    const s = App.state, cfg = s.config;
    const locked = s.run.started || !canControl();
    const rowsEl = $('#rows');
    const key = cfg.timers.map((t) => t.id).join(',');
    if (rowsEl.dataset.key !== key) {
      rowsEl.innerHTML = cfg.timers.map((t, i) => `
        <div class="trow" data-id="${esc(t.id)}">
          <i class="dot" style="background:${PALETTE[i % PALETTE.length]}"></i>
          <input class="r-name" maxlength="40" value="${esc(t.name)}" aria-label="Nome do timer ${i + 1}">
          <input class="r-dur" inputmode="decimal" value="${esc(durText(t.dur))}" aria-label="Duração do timer ${i + 1}">
          <div class="r-act">
            <button data-act="up" title="Subir" ${i === 0 ? 'disabled' : ''}>▲</button>
            <button data-act="down" title="Descer" ${i === cfg.timers.length - 1 ? 'disabled' : ''}>▼</button>
            <button data-act="del" class="del" title="Remover" ${cfg.timers.length <= 1 ? 'disabled' : ''}>✕</button>
          </div>
        </div>`).join('');
      rowsEl.dataset.key = key;
    } else if (!App.cfgPending) { // não sobrescreve o que ainda está sendo digitado
      $$('.trow', rowsEl).forEach((row, i) => {
        const t = cfg.timers[i];
        const ni = $('.r-name', row);
        if (document.activeElement !== ni && ni.value.trim() !== t.name) ni.value = t.name;
        const di = $('.r-dur', row);
        if (document.activeElement !== di && parseDuration(di.value) !== t.dur) { di.value = durText(t.dur); di.classList.remove('bad'); }
      });
    }
    if (!App.cfgPending) {
      setVal($('#cfgTitle'), cfg.title);
      const bi = $('#cfgBuffer');
      if (document.activeElement !== bi && parseDuration(bi.value, true) !== cfg.buffer) { bi.value = durText(cfg.buffer); bi.classList.remove('bad'); }
      $('#cfgGiveback').checked = cfg.giveback;
    }

    $$('#config input, #config button').forEach((el) => {
      if (el.id === 'btnConfigClose' || el.id === 'cfgHostOnly') return;
      if (el.closest('.r-act') && !locked) return; // mantém o disabled de ▲▼✕ nas pontas
      el.disabled = locked;
    });
    if (!locked) {
      $$('.trow', rowsEl).forEach((row, i, all) => {
        $('[data-act=up]', row).disabled = i === 0;
        $('[data-act=down]', row).disabled = i === all.length - 1;
        $('[data-act=del]', row).disabled = all.length <= 1;
      });
    }

    $('#hostOnlyRow').hidden = App.mode !== 'session';
    $('#cfgHostOnly').checked = s.hostOnly;
    $('#cfgHostOnly').disabled = !(s.owner === App.me || !s.owner) || App.waiting;

    const note = $('#cfgLockNote');
    let msg = '';
    if (App.mode === 'session' && App.waiting) msg = 'Conectando à sessão…';
    else if (!canControl()) msg = 'Somente o anfitrião pode editar e controlar esta sessão.';
    else if (s.run.started) msg = 'Configuração travada durante a sessão. Clique em Reiniciar para editar.';
    note.textContent = msg;
    note.hidden = !msg;
    renderSummary(cfg);
  }
  function renderSummary(cfg) {
    const el = $('#cfgSummary');
    if (!cfg) { el.className = 'summary bad'; el.textContent = '⚠ Há uma duração inválida.'; return; }
    const total = cfg.timers.reduce((a, t) => a + t.dur, 0);
    el.className = 'summary';
    el.innerHTML = `<b>${cfg.timers.length}</b> timers · planejado <b>${fmt(total)}</b><br>com buffer: <b>${fmt(total + cfg.buffer)}</b>`;
  }

  // ---------------------------------------------------------------- dashboard
  function renderDash() {
    if (!App.state || $('#app').hidden) return;
    const t = now();
    const d = Model.derive(App.state, t);
    checkAlerts(d, t);
    renderRing(d, t);
    renderInfo(d, t);
    renderBuffer(d);
    renderTimeline(d);
    renderTable(d);
    renderBanner();
    Pip.render(d, t);
    if (App.toastUntil && t > App.toastUntil) { $('#toast').textContent = ''; App.toastUntil = 0; }
    Wake.want(d.running);
  }

  // Valores visuais do anel (usados pela tela principal e pelo PiP)
  function ringModel(d, t) {
    const blink = Math.floor(t / 500) % 2 === 0;
    const m = { frac: 0, color: C.green, main: '--:--', mainColor: C.muted, sub: '', subColor: C.muted,
      top: '', topColor: C.amber, knob: false, track: '', dot: 'transparent', icon: false,
      name: '', nameColor: C.fg, step: '', state: '', stateColor: C.muted };
    if (d.finished) {
      Object.assign(m, { frac: 1, color: C.green, main: '✔', mainColor: C.green, icon: true,
        top: 'CONCLUÍDO', topColor: C.green, sub: `total ${fmt(d.totalElapsed)}`,
        name: 'Concluído', nameColor: C.green, step: 'SESSÃO CONCLUÍDA',
        state: d.left >= 0 ? `Buffer restante ${fmt(d.left)}` : `Excedeu ${fmt(-d.left)}`,
        stateColor: d.left >= 0 ? C.green : C.red });
      return m;
    }
    const c = d.cur;
    m.dot = m.nameColor = PALETTE[c.i % PALETTE.length];
    m.name = c.name;
    m.step = `TIMER ${d.index + 1} DE ${d.n}`;
    if (c.overtime > 0) {
      m.track = '#3b1d24';
      m.frac = d.cap > 0 ? Math.max(0, d.left) / d.cap : 0;
      m.color = blink || !d.running ? C.red : C.orange;
      m.main = '+' + fmt(c.overtime); m.mainColor = C.red;
      m.sub = d.left < 0 ? 'BUFFER ESTOURADO' : d.running ? 'consumindo buffer' : 'em overtime';
      m.subColor = d.left >= 0 ? C.amber : C.red;
    } else {
      m.frac = c.remaining / c.dur;
      m.color = colorFor(m.frac);
      m.main = fmt(ceilS(c.remaining)); m.mainColor = m.color;
      m.sub = `de ${fmt(c.dur)}`;
      m.knob = m.frac > 0.002;
    }
    if (!d.running) m.top = d.started ? '⏸ PAUSADO' : 'PRONTO';
    if (!d.started) { m.state = 'Pronto para começar'; m.stateColor = C.muted; }
    else if (!d.running) { m.state = c.overtime > 0 ? 'Pausado em overtime' : 'Pausado'; m.stateColor = C.amber; }
    else if (c.overtime > 0 && d.left < 0) { m.state = `Buffer estourado em ${fmt(-d.left)}`; m.stateColor = C.red; }
    else if (c.overtime > 0) { m.state = 'Consumindo o buffer'; m.stateColor = C.red; }
    else if (d.running) { m.state = 'Em andamento'; m.stateColor = C.green; }
    else { m.state = 'Pausado'; m.stateColor = C.amber; }
    return m;
  }

  function renderRing(d, t) {
    const blink = Math.floor(t / 500) % 2 === 0;
    $('#ringFlash').style.opacity = t < App.flashUntil && blink ? 0.18 : 0;
    const m = ringModel(d, t);
    const arc = $('#ringArc');
    arc.style.stroke = m.color;
    arc.style.opacity = m.frac > 0.002 ? 1 : 0;
    arc.setAttribute('stroke-dasharray', `${(CIRC * Math.min(1, m.frac)).toFixed(2)} ${CIRC.toFixed(2)}`);
    $('#ringTrack').style.stroke = m.track;
    const kn = $('#ringKnob');
    kn.style.display = m.knob ? '' : 'none';
    if (m.knob) {
      const a = (-90 + 360 * m.frac) * Math.PI / 180;
      kn.setAttribute('cx', (180 + R * Math.cos(a)).toFixed(2));
      kn.setAttribute('cy', (180 + R * Math.sin(a)).toFixed(2));
    }
    const mainEl = $('#ringMain');
    mainEl.textContent = m.main;
    mainEl.style.fill = m.mainColor;
    mainEl.setAttribute('class', m.icon ? 'icon' : (m.main.length > 6 ? 'long' : ''));
    $('#ringSub').textContent = m.sub;
    $('#ringSub').style.fill = m.subColor;
    $('#ringTop').textContent = m.top;
    $('#ringTop').style.fill = m.topColor;
    $('#ringDot').style.fill = m.dot;
  }

  function renderInfo(d, t) {
    const s = App.state;
    const ctl = canControl();
    const title = s.config.title;
    $('#cElapsed').textContent = fmt(d.totalElapsed);
    const play = $('#btnPlay'), next = $('#btnNext'), reset = $('#btnReset');
    let docTitle;

    if (d.finished) {
      $('#step').textContent = (title ? title.toUpperCase() + ' · ' : '') + 'SESSÃO CONCLUÍDA';
      $('#curName').textContent = 'Todos os timers concluídos';
      $('#curName').style.color = C.green;
      setState(d.left >= 0 ? `Buffer restante: ${fmt(d.left)}` : `Excedeu o total em ${fmt(-d.left)}`, d.left >= 0 ? C.green : C.red);
      $('#nextLine').textContent = 'Clique em Reiniciar para uma nova rodada';
      $('#cEnd').textContent = '—';
      setCard('#cLimit', '—', C.fg);
      play.textContent = '▶ Play'; play.className = 'btn big green'; play.disabled = true;
      next.disabled = true;
      reset.disabled = !ctl;
      docTitle = '✔ Concluído';
    } else {
      const c = d.cur;
      $('#step').textContent = (title ? title.toUpperCase() + ' · ' : '') + `TIMER ${d.index + 1} DE ${d.n}`;
      $('#curName').textContent = c.name;
      $('#curName').style.color = PALETTE[c.i % PALETTE.length];
      if (!d.started) setState('Pressione ▶ Play para começar', C.muted);
      else if (!d.running) setState(c.overtime > 0 ? '⏸ Pausado em overtime' : '⏸ Pausado', C.amber);
      else if (c.overtime > 0 && d.left < 0) setState(`⚠ Buffer estourado em ${fmt(-d.left)}`, C.red);
      else if (c.overtime > 0) setState('⏰ Tempo esgotado: consumindo o buffer', C.red);
      else if (d.running) setState('▶ Em andamento', C.green);
      else setState('⏸ Pausado', C.amber);
      if (d.index + 1 < d.n) {
        const nt = d.timers[d.index + 1];
        $('#nextLine').textContent = `A seguir: ${nt.name} (${fmt(nt.dur)})`;
      } else $('#nextLine').textContent = 'Este é o último timer';

      const end = t + d.plannedRemaining * 1000;
      $('#cEnd').textContent = hhmm(end);
      if (d.left >= 0) setCard('#cLimit', hhmm(end + d.left * 1000), C.amber);
      else setCard('#cLimit', 'estourado', C.red);

      if (d.running) { play.textContent = '⏸ Pausar'; play.className = 'btn big amber-bg'; }
      else { play.textContent = d.started ? '▶ Retomar' : '▶ Play'; play.className = 'btn big green'; }
      play.disabled = !ctl;
      next.textContent = d.index === d.n - 1 ? '✔ Finalizar' : '⏭ Próximo';
      next.disabled = !ctl || !d.started;
      reset.disabled = !ctl || !d.started;
      docTitle = c.overtime > 0 ? `+${fmt(c.overtime)} · ${c.name}` : `${d.running ? '▶' : '⏸'} ${fmt(ceilS(c.remaining))} · ${c.name}`;
    }
    document.title = `${docTitle} — Timers`;

    if (d.finished && !App.prevFinished) { Sound.beep([660, 880, 1320]); toast('✔ Sessão concluída!', C.green); }
    App.prevFinished = d.finished;
  }
  function setState(text, color) { const el = $('#stateLine'); el.textContent = text; el.style.color = color; }
  function setCard(sel, text, color) { const el = $(sel); el.textContent = text; el.style.color = color; }

  function renderBuffer(d) {
    const bar = $('#bufBar'), fill = $('#bufFill');
    const consuming = !!(d.cur && d.cur.overtime > 0 && d.running && d.left >= 0);
    bar.classList.toggle('consuming', consuming);
    bar.classList.toggle('over', d.left < 0);
    let text;
    if (d.left < 0) {
      text = `ESTOURADO em ${fmt(-d.left)}`;
      $('#bufText').style.color = C.red;
      fill.style.width = '0';
      $('#bufPct').textContent = '';
      $('#bufMsg').textContent = 'SEM BUFFER';
    } else if (d.cap <= 0) {
      text = 'sem buffer configurado';
      $('#bufText').style.color = C.muted;
      fill.style.width = '0';
      $('#bufPct').textContent = '';
      $('#bufMsg').textContent = '';
    } else {
      const frac = d.left / d.cap;
      text = `${fmt(ceilS(d.left))} restantes de ${fmt(d.cap)}`;
      if (d.giveback && d.credit > 0) text += ` (+${fmt(d.credit)} de sobras)`;
      $('#bufText').style.color = C.fg;
      fill.style.width = `${(frac * 100).toFixed(2)}%`;
      fill.style.background = colorFor(frac);
      $('#bufPct').textContent = `${Math.round(frac * 100)}%`;
      $('#bufMsg').textContent = consuming ? '◀ consumindo' : '';
    }
    $('#bufText').textContent = text;
  }

  function renderTimeline(d) {
    const segs = d.timers.map((tm) => {
      const col = PALETTE[tm.i % PALETTE.length];
      const cur = !d.finished && tm.i === d.index;
      const pct = (Math.min(tm.elapsed, tm.dur) / tm.dur) * 100;
      const mark = tm.done ? (tm.overtime > 0 ? '✔+' : '✔') : '';
      const marker = cur && d.started && tm.overtime === 0 ? `<i class="tl-marker" style="left:${pct.toFixed(2)}%"></i>` : '';
      return `<div class="seg${cur ? ' cur' : ''}${tm.done ? ' done' : ''}" style="flex:${tm.dur} 1 0;--c:${col}">
        <div class="seg-bar"><div class="seg-fill" style="width:${pct.toFixed(2)}%"></div><span class="seg-mark">${mark}</span>${marker}</div>
        <div class="seg-label" title="${esc(tm.name)}">${esc(tm.name)}</div><div class="seg-dur">${fmt(tm.dur)}</div></div>`;
    });
    if (d.buffer > 0) {
      const usedPct = Math.min(1, d.used / d.buffer) * 100;
      const marker = d.cur && d.cur.overtime > 0 ? `<i class="tl-marker" style="left:${usedPct.toFixed(2)}%;--mc:${C.red}"></i>` : '';
      segs.push(`<div class="seg buf" style="flex:${d.buffer} 1 0">
        <div class="seg-bar"><div class="seg-fill" style="width:${usedPct.toFixed(2)}%"></div>${marker}</div>
        <div class="seg-label">Buffer</div><div class="seg-dur">${fmt(d.buffer)}</div></div>`);
    }
    $('#timeline').innerHTML = segs.join('');
  }

  function renderTable(d) {
    const rows = d.timers.map((tm) => {
      const cur = !d.finished && tm.i === d.index;
      let ico, icol;
      if (tm.done) { ico = '✔'; icol = tm.overtime > 0 ? C.orange : C.green; }
      else if (cur) { ico = d.running ? '▶' : '⏸'; icol = d.running ? C.green : C.amber; }
      else { ico = '•'; icol = C.gray; }
      const real = tm.done || (cur && d.started) ? fmt(tm.elapsed) : '—';
      let saldo, scol;
      if (tm.overtime > 0) { saldo = `+${fmt(tm.overtime)} do buffer`; scol = C.red; }
      else if (tm.done && tm.remaining >= 1) { saldo = `−${fmt(tm.remaining)} sobrou${d.giveback ? ' → buffer' : ''}`; scol = C.green; }
      else if (tm.done) { saldo = 'no tempo'; scol = C.green; }
      else { saldo = '—'; scol = C.gray; }
      return `<div class="tr${cur ? ' cur' : ''}${tm.done ? ' done' : ''}">
        <span class="ico" style="color:${icol}">${ico}</span>
        <i class="dot" style="background:${PALETTE[tm.i % PALETTE.length]}"></i>
        <span class="nm">${esc(tm.name)}</span>
        <span class="pl">${fmt(tm.dur)}</span>
        <span>${real}</span>
        <span class="saldo" style="color:${scol}">${saldo}</span></div>`;
    });
    $('#table').innerHTML = `<div class="tr head"><span></span><span></span><span>TIMER</span><span class="pl">PLANEJADO</span><span>REAL</span><span>SALDO</span></div>${rows.join('')}`;
  }

  function renderBanner() {
    const b = $('#banner');
    let msg = '';
    if (App.mode === 'session') {
      if (typeof mqtt === 'undefined') msg = 'A biblioteca de sincronia não carregou. O relógio funciona, mas sem compartilhar.';
      else if (App.waiting) msg = 'Conectando à sessão e buscando o estado atual…';
      else if (App.net.up === 0) msg = 'Sem conexão com os servidores de sincronia. O relógio continua correndo; as mudanças serão enviadas quando a conexão voltar.';
      else if (App.state.rev === 0) msg = 'Sessão nova ou ainda sem dados. Configure os timers e dê Play; quem entrar verá tudo em tempo real.';
    }
    if (b.textContent !== msg) b.textContent = msg;
    b.hidden = !msg;
  }


  // --------------------------------------------------------------------- PiP
  // Chrome/Edge desktop: Document Picture-in-Picture (mini-página com botões).
  // Demais (Safari, iOS, Android): vídeo gerado de um canvas + Media Session.
  const PIP_R = 84;
  const PIP_CIRC = 2 * Math.PI * PIP_R;
  const PIP_CSS = `
    *{box-sizing:border-box}
    html,body{margin:0;height:100%;background:#0f172a;color:#e2e8f0;overflow:hidden;
      font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;-webkit-font-smoothing:antialiased}
    body{display:flex;flex-direction:column;gap:8px;padding:12px;transition:background .2s}
    body.flash{background:#3b1d24}
    .hd{text-align:center;min-width:0}
    #pStep{font-size:11px;font-weight:800;letter-spacing:.08em;color:#94a3b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #pName{font-size:20px;font-weight:800;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    svg{flex:1;min-height:0;width:100%;overflow:visible}
    svg text{text-anchor:middle;font-variant-numeric:tabular-nums}
    #pTrk{fill:none;stroke-width:16;transition:stroke .3s}
    #pArc{fill:none;stroke-width:16;stroke-linecap:round;transition:stroke-dasharray .25s linear,stroke .3s}
    #pMain{font-size:40px;font-weight:800}
    #pMain.long{font-size:31px}
    #pMain.icon{font-size:48px}
    #pSub{font-size:12px;font-weight:700}
    #pTop{font-size:11px;font-weight:800;letter-spacing:.06em}
    #pState{text-align:center;font-size:13px;font-weight:700;min-height:16px}
    .bar{position:relative;height:22px;flex:none;border-radius:7px;background:#273449;overflow:hidden}
    .bar.over{background:repeating-linear-gradient(135deg,#ef4444 0 10px,#b91c1c 10px 20px)}
    #pFill{position:absolute;inset:0 auto 0 0;border-radius:7px;transition:width .25s linear}
    #pBuf{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
      font-size:12px;font-weight:800;color:#fff;text-shadow:0 1px 2px #0009;font-variant-numeric:tabular-nums}
    .btns{display:flex;gap:8px;flex:none}
    button{flex:1;border:0;border-radius:9px;padding:10px 6px;color:#fff;cursor:pointer;
      font-family:inherit;font-size:14px;font-weight:700;white-space:nowrap}
    button:hover:not(:disabled){filter:brightness(1.12)}
    button:disabled{background:#475569!important;color:#94a3b8;cursor:not-allowed}
    .g{background:#22c55e}.a{background:#f59e0b}.b{background:#3b82f6}
    @media (max-height:300px){#pStep,#pState{display:none}#pName{font-size:16px}}
    @media (max-height:200px){.bar{display:none}}
  `;
  const PIP_HTML = `
    <div class="hd"><div id="pStep"></div><div id="pName"></div></div>
    <svg viewBox="0 0 200 200" aria-label="Tempo restante">
      <circle id="pTrk" cx="100" cy="100" r="${PIP_R}"/>
      <circle id="pArc" cx="100" cy="100" r="${PIP_R}" transform="rotate(-90 100 100)"/>
      <text id="pTop" x="100" y="68"></text>
      <text id="pMain" x="100" y="114"></text>
      <text id="pSub" x="100" y="141"></text>
    </svg>
    <div id="pState"></div>
    <div class="bar" id="pBar"><div id="pFill"></div><span id="pBuf"></span></div>
    <div class="btns"><button id="pPlay" class="g"></button><button id="pNext" class="b"></button></div>`;

  function bufferLabel(d) {
    if (d.left < 0) return { text: `Buffer estourado +${fmt(-d.left)}`, frac: 0, over: true };
    if (d.cap <= 0) return { text: 'Sem buffer', frac: 0, over: false };
    return { text: `Buffer ${fmt(ceilS(d.left))}`, frac: d.left / d.cap, over: false };
  }

  const Pip = {
    mode: null, win: null, els: null, video: null, canvas: null, ctx: null, lastMeta: '',
    hasDoc() { return 'documentPictureInPicture' in window; },
    hasVideo() {
      const v = document.createElement('video');
      const canvasOk = typeof HTMLCanvasElement.prototype.captureStream === 'function';
      return canvasOk && ((document.pictureInPictureEnabled && typeof v.requestPictureInPicture === 'function')
        || typeof v.webkitSetPresentationMode === 'function');
    },
    supported() { return this.hasDoc() || this.hasVideo(); },

    async toggle() {
      if (this.mode) { this.close(); return; }
      try {
        if (this.hasDoc()) await this.openDoc();
        else await this.openVideo();
      } catch (e) {
        console.warn('PiP', e);
        toast('Não foi possível abrir a janela flutuante neste navegador', C.amber);
      }
      renderPipButton();
    },

    // ---- Document PiP
    async openDoc() {
      const w = await window.documentPictureInPicture.requestWindow({ width: 300, height: 400 });
      this.mount(w);
      this.mode = 'doc';
      w.addEventListener('pagehide', () => {
        if (this.win === w) { this.win = null; this.els = null; this.mode = null; renderPipButton(); }
      });
    },
    mount(w) { // separado para poder ser testado com uma janela comum
      const doc = w.document;
      doc.title = 'Timers';
      const st = doc.createElement('style');
      st.textContent = PIP_CSS;
      doc.head.appendChild(st);
      doc.body.innerHTML = PIP_HTML;
      const q = (id) => doc.getElementById(id);
      this.els = { step: q('pStep'), name: q('pName'), arc: q('pArc'), trk: q('pTrk'), main: q('pMain'), sub: q('pSub'),
        top: q('pTop'), state: q('pState'), bar: q('pBar'), fill: q('pFill'), buf: q('pBuf'), play: q('pPlay'), next: q('pNext') };
      this.els.play.addEventListener('click', togglePlay);
      this.els.next.addEventListener('click', () => commit({ type: 'next' }));
      doc.addEventListener('pointerdown', () => Sound.unlock());
      doc.addEventListener('keydown', (e) => {
        const k = e.key.toLowerCase();
        if (k === ' ') { e.preventDefault(); togglePlay(); }
        else if (k === 'n') commit({ type: 'next' });
        else if (k === 'p' || k === 'escape') this.close();
      });
      // A janela PiP fica visível, então o relógio dela não sofre throttling
      // quando a aba principal está em segundo plano.
      w.setInterval(renderDash, 250);
      this.win = w;
      renderDash();
    },
    renderDoc(d, t) {
      const e = this.els, m = ringModel(d, t);
      const title = App.state.config.title;
      e.step.textContent = (title ? title + ' · ' : '') + m.step;
      e.name.textContent = m.name;
      e.name.style.color = m.nameColor;
      e.trk.style.stroke = m.track || '#273449';
      e.arc.style.stroke = m.color;
      e.arc.style.opacity = m.frac > 0.002 ? 1 : 0;
      e.arc.setAttribute('stroke-dasharray', `${(PIP_CIRC * Math.min(1, m.frac)).toFixed(2)} ${PIP_CIRC.toFixed(2)}`);
      e.main.textContent = m.main;
      e.main.style.fill = m.mainColor;
      e.main.setAttribute('class', m.icon ? 'icon' : (m.main.length > 6 ? 'long' : ''));
      e.sub.textContent = m.sub;
      e.sub.style.fill = m.subColor;
      e.top.textContent = m.top;
      e.top.style.fill = m.topColor;
      e.state.textContent = m.state;
      e.state.style.color = m.stateColor;
      const b = bufferLabel(d);
      e.bar.classList.toggle('over', b.over);
      e.fill.style.width = `${(b.frac * 100).toFixed(2)}%`;
      e.fill.style.background = colorFor(b.frac);
      e.buf.textContent = b.text;
      const ctl = canControl();
      e.play.textContent = d.running ? '⏸ Pausar' : (d.started && !d.finished ? '▶ Retomar' : '▶ Play');
      e.play.className = d.running ? 'a' : 'g';
      e.play.disabled = d.finished || !ctl;
      e.next.textContent = !d.finished && d.index === d.n - 1 ? '✔ Finalizar' : '⏭ Próximo';
      e.next.disabled = !ctl || !d.started || d.finished;
      e.play.title = ctl ? 'Espaço' : 'Somente o anfitrião controla';
      this.win.document.body.classList.toggle('flash', t < App.flashUntil && Math.floor(t / 500) % 2 === 0);
      this.win.document.title = `${m.main} · ${m.name}`;
    },

    // ---- Video PiP (fallback)
    prepareVideo(force) {
      if (this.video || (!force && (this.hasDoc() || !this.hasVideo()))) return;
      const cv = document.createElement('canvas');
      cv.width = 640; cv.height = 360;
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.autoplay = true;
      v.setAttribute('playsinline', ''); v.setAttribute('muted', '');
      v.className = 'pip-video';
      v.setAttribute('aria-hidden', 'true');
      document.body.appendChild(v);
      this.canvas = cv; this.ctx = cv.getContext('2d'); this.video = v;
      this.draw(App.state ? Model.derive(App.state, now()) : null, now());
      if (cv.captureStream) { v.srcObject = cv.captureStream(8); v.play().catch(() => {}); }
      v.addEventListener('enterpictureinpicture', () => { this.mode = 'video'; renderPipButton(); });
      v.addEventListener('leavepictureinpicture', () => { this.mode = null; renderPipButton(); });
      v.addEventListener('webkitpresentationmodechanged', () => {
        this.mode = v.webkitPresentationMode === 'picture-in-picture' ? 'video' : null;
        renderPipButton();
      });
      // os botões da janela de vídeo controlam o relógio, não o vídeo
      v.addEventListener('pause', () => { if (this.mode === 'video') v.play().catch(() => {}); });
      if ('mediaSession' in navigator) {
        const set = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch (e) { /* ação não suportada */ } };
        set('play', () => { if (!App.state.run.running) togglePlay(); });
        set('pause', () => { if (App.state.run.running) togglePlay(); });
        set('nexttrack', () => commit({ type: 'next' }));
      }
    },
    async openVideo() {
      this.prepareVideo();
      const v = this.video;
      if (!v) throw new Error('Picture-in-Picture não suportado');
      this.draw(Model.derive(App.state, now()), now());
      if (v.requestPictureInPicture && document.pictureInPictureEnabled) {
        if (v.paused) await v.play();
        await v.requestPictureInPicture();
      } else {
        v.webkitSetPresentationMode('picture-in-picture');
      }
      this.mode = 'video';
    },
    draw(d, t) {
      const g = this.ctx, W = 640, H = 360;
      if (!g) return;
      const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
      const flash = d && t < App.flashUntil && Math.floor(t / 500) % 2 === 0;
      g.fillStyle = flash ? '#3b1d24' : '#0f172a';
      g.fillRect(0, 0, W, H);
      g.textBaseline = 'middle';
      if (!d) {
        g.fillStyle = C.muted; g.textAlign = 'center'; g.font = `800 34px ${FONT}`;
        g.fillText('Timers', W / 2, H / 2);
        return;
      }
      const m = ringModel(d, t);
      const cx = 178, cy = 180, r = 128;
      g.lineCap = 'round'; g.lineWidth = 22;
      g.strokeStyle = m.track || '#273449';
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
      if (m.frac > 0.002) {
        g.strokeStyle = m.color;
        g.beginPath(); g.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, m.frac)); g.stroke();
      }
      g.textAlign = 'center';
      g.fillStyle = m.mainColor;
      g.font = `800 ${m.icon ? 76 : m.main.length > 6 ? 48 : 62}px ${FONT}`;
      g.fillText(m.main, cx, cy + 4);
      g.fillStyle = m.subColor; g.font = `700 18px ${FONT}`;
      g.fillText(m.sub, cx, cy + 52);
      if (m.top) { g.fillStyle = m.topColor; g.font = `800 15px ${FONT}`; g.fillText(m.top, cx, cy - 56); }

      const x = 340, w = 272;
      const fit = (txt, font) => {
        g.font = font;
        if (g.measureText(txt).width <= w) return txt;
        let s2 = txt;
        while (s2.length > 1 && g.measureText(s2 + '…').width > w) s2 = s2.slice(0, -1);
        return s2 + '…';
      };
      g.textAlign = 'left';
      const title = App.state.config.title;
      g.fillStyle = C.muted; g.fillText(fit((title ? title.toUpperCase() + ' · ' : '') + m.step, `800 15px ${FONT}`), x, 62);
      g.fillStyle = m.nameColor; g.fillText(fit(m.name, `800 36px ${FONT}`), x, 102);
      g.fillStyle = m.stateColor; g.fillText(fit(m.state, `700 21px ${FONT}`), x, 146);

      const b = bufferLabel(d);
      g.fillStyle = C.amber; g.font = `800 15px ${FONT}`; g.fillText('◆ BUFFER GERAL', x, 204);
      const by = 222, bh = 34;
      const rr = (x0, y0, ww, hh, rad, fill) => {
        g.fillStyle = fill; g.beginPath();
        if (g.roundRect) g.roundRect(x0, y0, ww, hh, rad); else g.rect(x0, y0, ww, hh);
        g.fill();
      };
      rr(x, by, w, bh, 9, b.over ? C.red : '#273449');
      if (b.frac > 0) rr(x, by, Math.max(18, w * b.frac), bh, 9, colorFor(b.frac));
      g.fillStyle = '#fff'; g.font = `800 15px ${FONT}`; g.textAlign = 'center';
      g.fillText(b.text, x + w / 2, by + bh / 2 + 1);
      g.textAlign = 'left';
      let nextTxt = '';
      if (!d.finished) nextTxt = d.index + 1 < d.n ? `A seguir: ${d.timers[d.index + 1].name}` : 'Último timer';
      g.fillStyle = C.muted; g.fillText(fit(nextTxt, `600 17px ${FONT}`), x, 296);
    },

    render(d, t) {
      if (this.mode === 'doc' && this.els) this.renderDoc(d, t);
      if (this.mode === 'video' && this.ctx) {
        this.draw(d, t);
        if ('mediaSession' in navigator) {
          const ms = navigator.mediaSession;
          const meta = d.finished ? 'Concluído' : d.cur.name;
          if (meta !== this.lastMeta && window.MediaMetadata) {
            this.lastMeta = meta;
            try { ms.metadata = new MediaMetadata({ title: meta, artist: 'Timers', album: App.state.config.title || '' }); } catch (e) { /* noop */ }
          }
          try { ms.playbackState = d.running ? 'playing' : 'paused'; } catch (e) { /* noop */ }
        }
      }
    },
    close() {
      if (this.mode === 'doc' && this.win) { try { this.win.close(); } catch (e) { /* noop */ } }
      else if (this.mode === 'video') {
        if (document.pictureInPictureElement && document.exitPictureInPicture) document.exitPictureInPicture().catch(() => {});
        else if (this.video && this.video.webkitSetPresentationMode) { try { this.video.webkitSetPresentationMode('inline'); } catch (e) { /* noop */ } }
      }
      this.mode = null; this.win = null; this.els = null;
      renderPipButton();
    },
  };

  function renderPipButton() {
    const b = $('#btnPip');
    if (!b) return;
    b.hidden = !Pip.supported();
    b.classList.toggle('active', !!Pip.mode);
    b.title = Pip.mode ? 'Fechar janela flutuante (P)' : 'Abrir janela flutuante, Picture-in-Picture (P)';
  }

  // Relógio de atualização: um Worker não sofre o throttling de timers que o
  // navegador aplica a abas em segundo plano (alertas e PiP seguem em dia).
  function startTicker(fn, ms) {
    try {
      const url = URL.createObjectURL(new Blob([`setInterval(function(){postMessage(0)},${ms})`], { type: 'text/javascript' }));
      const w = new Worker(url);
      w.onmessage = fn;
      return;
    } catch (e) { /* sem Worker */ }
    setInterval(fn, ms);
  }

  // ------------------------------------------------------------------ alerts
  function toast(msg, color = C.red, secs = 4) {
    const el = $('#toast');
    el.textContent = msg;
    el.style.color = color;
    App.toastUntil = now() + secs * 1000;
  }
  function checkAlerts(d, t) {
    if (!d.started) { App.alerted.clear(); return; }
    if (d.finished || !d.cur) return;
    const c = d.cur;
    // aviso de 1 minuto (só para timers de 3 min ou mais)
    if (c.dur >= 180 && c.remaining <= 60 && c.remaining > 55 && d.running && !App.alerted.has('w' + c.i)) {
      App.alerted.add('w' + c.i);
      Sound.beep([660], 0.12);
      toast(`1 minuto restante em ${c.name}`, C.amber);
    }
    if (c.overtime > 0 && !App.alerted.has('o' + c.i)) {
      App.alerted.add('o' + c.i);
      if (c.overtime < 5) { // evita alarmar quem entrou na sessão depois
        Sound.beep([880, 0, 880, 0, 1320]);
        vibrate([200, 100, 200]);
        App.flashUntil = t + 2500;
        toast(`⏰ ${c.name} esgotado: agora consumindo o buffer`, C.red, 5);
      }
    }
    if (d.left < 0 && !App.alerted.has('buf')) {
      App.alerted.add('buf');
      if (-d.left < 5) {
        Sound.beep([660, 440, 660, 440], 0.22);
        vibrate([400, 150, 400]);
        App.flashUntil = t + 4000;
        toast('⚠ BUFFER ESGOTADO: além do tempo total!', C.red, 7);
      }
    }
  }

  // ------------------------------------------------------------------ events
  function inviteLink() {
    return `${location.origin}${location.pathname}${location.search}#s=${App.code}`;
  }
  function parseJoin(text) {
    const t = String(text).trim();
    const m = t.match(/s=([a-z0-9]{4,40})/i) || t.match(/^([a-z0-9]{4,40})$/i);
    return m ? m[1].toLowerCase() : null;
  }
  function saveName(v) {
    App.name = String(v || '').trim().slice(0, 24);
    store.set('tt_name', App.name);
    if (App.sync) App.sync.setPresence(presence());
  }
  function toggleConfig(open) {
    $('#config').classList.toggle('open', open);
    $('#scrim').classList.toggle('show', open);
  }

  function bind() {
    document.addEventListener('pointerdown', () => Sound.unlock(), { capture: true });
    document.addEventListener('keydown', () => Sound.unlock(), { capture: true });

    // home
    $('#homeName').addEventListener('change', (e) => saveName(e.target.value));
    $('#btnCreate').addEventListener('click', () => {
      saveName($('#homeName').value);
      const code = rid(8);
      store.set('tt_own_' + code, true);
      location.hash = 's=' + code;
    });
    $('#joinForm').addEventListener('submit', (e) => {
      e.preventDefault();
      saveName($('#homeName').value);
      const code = parseJoin($('#joinCode').value);
      if (!code) { $('#joinCode').classList.add('bad'); $('#joinCode').focus(); return; }
      $('#joinCode').classList.remove('bad');
      location.hash = 's=' + code;
    });
    $('#btnLocal').addEventListener('click', () => { saveName($('#homeName').value); location.hash = 'local'; });

    // topbar
    $('#btnCopy').addEventListener('click', async () => {
      const link = inviteLink();
      if (navigator.share && matchMedia('(pointer: coarse)').matches) {
        try { await navigator.share({ title: 'Sessão de timers', text: 'Entre na minha sessão de timers', url: link }); return; } catch (e) { /* cancelado */ }
      }
      try { await navigator.clipboard.writeText(link); toast('🔗 Link de convite copiado', C.green, 3); }
      catch (e) { window.prompt('Copie o link de convite:', link); }
    });
    $('#btnSound').addEventListener('click', () => {
      Sound.on = !Sound.on; store.set('tt_sound', Sound.on); Sound.unlock();
      if (Sound.on) Sound.beep([880], 0.1);
      renderTop();
    });
    $('#btnLeave').addEventListener('click', () => { location.hash = ''; });
    $('#btnPip').addEventListener('click', () => Pip.toggle());
    $('#peers').addEventListener('click', (e) => {
      if (!e.target.closest('.avatar.me')) return;
      const v = window.prompt('Seu nome nesta sessão:', App.name);
      if (v !== null) { saveName(v); renderPeers(); }
    });
    $('#btnConfigToggle').addEventListener('click', () => toggleConfig(!$('#config').classList.contains('open')));
    $('#btnConfigClose').addEventListener('click', () => toggleConfig(false));
    $('#scrim').addEventListener('click', () => toggleConfig(false));

    // config
    $('#rows').addEventListener('input', () => scheduleConfigCommit());
    $('#rows').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (b && !b.disabled) rowAction(b.dataset.act, b.closest('.trow').dataset.id);
    });
    $('#cfgTitle').addEventListener('input', () => scheduleConfigCommit(500));
    $('#cfgBuffer').addEventListener('input', () => scheduleConfigCommit());
    $('#cfgGiveback').addEventListener('change', () => scheduleConfigCommit(0));
    $('#cfgHostOnly').addEventListener('change', (e) => commit({ type: 'hostOnly', value: e.target.checked }));
    $('#btnAdd').addEventListener('click', addTimer);
    $('#config').addEventListener('focusout', () => setTimeout(() => { flushConfig(); renderConfig(); }, 0));

    // controles
    $('#btnPlay').addEventListener('click', togglePlay);
    $('#btnNext').addEventListener('click', () => commit({ type: 'next' }));
    $('#btnReset').addEventListener('click', doReset);
    document.addEventListener('keydown', (e) => {
      if ($('#app').hidden || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target.closest('input, textarea, select')) return;
      const k = e.key.toLowerCase();
      if (k === ' ' || k === 'spacebar') { e.preventDefault(); togglePlay(); }
      else if (k === 'n') commit({ type: 'next' });
      else if (k === 'r') doReset();
      else if (k === 'p') Pip.toggle();
    });

    window.addEventListener('hashchange', route);
    window.addEventListener('pagehide', () => { if (App.sync) App.sync.stop(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') renderDash(); });
  }
  function togglePlay() {
    if (App.state.run.running) commit({ type: 'pause' });
    else commit({ type: 'play' });
  }
  function doReset() {
    const r = App.state.run;
    if (!r.started) return;
    if (!r.finished && !window.confirm('Interromper a rodada atual e reiniciar todos os timers?')) return;
    commit({ type: 'reset' });
  }

  // -------------------------------------------------------------------- boot
  function repoLink() {
    const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
    const seg = location.pathname.split('/').filter(Boolean)[0];
    const a = $('#repoLink');
    if (m) a.href = `https://github.com/${m[1]}/${seg || m[1] + '.github.io'}`;
    else a.hidden = true;
  }

  bind();
  repoLink();
  syncClock();
  route();
  renderPipButton();
  Pip.prepareVideo();
  startTicker(renderDash, 200);
  setInterval(() => { if (App.mode === 'session') renderPeers(); }, 10000);
})();
