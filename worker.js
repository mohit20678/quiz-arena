import { DurableObject } from 'cloudflare:workers';
import DEFAULT_QUESTIONS from './questions.json';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const enc = new TextEncoder();
const b64u = (value) => {
  const bytes = typeof value === 'string' ? enc.encode(value) : new Uint8Array(value);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
function unb64u(text) {
  let s = String(text).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}
async function verifyPassword(password, env) {
  const salt = unb64u(env.ADMIN_SALT_B64);
  const expected = unb64u(env.ADMIN_HASH_B64);
  const key = await crypto.subtle.importKey('raw', enc.encode(String(password || '')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256
  );
  return equalBytes(new Uint8Array(bits), expected);
}
async function isAuthorized(request, env) {
  const token = parseCookies(request.headers.get('cookie')).quiz_session;
  if (!token || !token.includes('.')) return false;
  const [payload, signature] = token.split('.');
  if ((await hmac(env.SESSION_SECRET, payload)) !== signature) return false;
  try {
    const data = JSON.parse(new TextDecoder().decode(unb64u(payload)));
    return data.email === env.ADMIN_EMAIL && data.exp > Date.now();
  } catch (_) { return false; }
}
function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}
function validateQuestionSet(raw) {
  if (!Array.isArray(raw) || !raw.length) throw new Error('add at least one question');
  if (raw.length > 30) throw new Error('maximum 30 questions');
  return raw.map((q, i) => {
    const type = String(q.type || 'mcq');
    const label = `question ${i + 1}`;
    // MCQs use seconds (default 20); written questions can be set in minutes by the admin.
    const seconds = type === 'mcq'
      ? Math.min(300, Math.max(5, Number(q.seconds) || 20))
      : Math.min(1800, Math.max(5, Number(q.seconds) || 120));
    if (!['mcq', 'short', 'essay', 'paragraph'].includes(type)) throw new Error(`${label}: unknown type`);
    const passage = type === 'paragraph' ? String(q.passage || '').trim() : '';
    if (type === 'paragraph' && !passage) throw new Error(`${label}: paragraph needs a passage`);

    if (type === 'mcq' || (type === 'paragraph' && q.method === 'mcq')) {
      const subs = type === 'mcq'
        ? [{ text: String(q.text || ''), options: q.options, correct: q.correct }]
        : (Array.isArray(q.subs) ? q.subs : []);
      if (!subs.length || subs.length > 10) throw new Error(`${label}: choose 1 to 10 MCQs`);
      const validated = subs.map((sub, j) => {
        const text = String(sub.text || '').trim();
        const options = (Array.isArray(sub.options) ? sub.options : []).slice(0, 4).map((o) => String(o).trim());
        const correct = Number(sub.correct);
        if (!text || options.length !== 4 || options.some((o) => !o) ||
            !Number.isInteger(correct) || correct < 0 || correct > 3) {
          throw new Error(`${label}, MCQ ${j + 1}: needs text, four options and a correct option`);
        }
        return { text, options, correct };
      });
      return type === 'mcq'
        ? { type, seconds, text: validated[0].text, options: validated[0].options, correct: validated[0].correct }
        : { type, seconds, passage, method: 'mcq', subs: validated };
    }

    const text = String(q.text || '').trim();
    if (!text) throw new Error(`${label}: needs question text`);
    const keywords = (Array.isArray(q.keywords) ? q.keywords : []).map((k) => String(k).trim()).filter(Boolean);
    return { type, seconds, text, passage: passage || undefined, method: 'written', keywords, requireAll: Boolean(q.requireAll) };
  });
}

function answerMatchesKeywords(text, keywords, requireAll = false) {
  const normalize = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const answer = normalize(text);
  if (!answer) return false;
  const entries = (keywords || []).map((k) => String(k).split('|').map(normalize).filter(Boolean)).filter((e) => e.length);
  if (!entries.length) return answer.length >= 10;
  const matched = entries.map((alts) => alts.some((a) => answer.includes(a)));
  return requireAll ? matched.every(Boolean) : matched.some(Boolean);
}

/* ------------------------------------------------------------------ */
/* Durable Object — one live quiz room, persistent question storage     */
/* ------------------------------------------------------------------ */

export class QuizRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sockets = new Map(); // ws -> { role, id, token }
    this.ready = false;
    this.g = {
      phase: 'idle', questions: [], currentIndex: -1, answers: new Map(), players: new Map(),
      roundDuration: 20, endsAt: 0, autoAdvanceAt: 0, roundStartedAt: 0, undo: null,
      rate: new Map(), history: [], feedback: [], pending: [], events: [],
    };
  }

  async init() {
    if (this.ready) return;
    this.ready = true;
    const stored = await this.ctx.storage.get('questions');
    this.g.questions = validateQuestionSet(stored || DEFAULT_QUESTIONS);
    this.g.history = (await this.ctx.storage.get('history')) || [];
    this.g.feedback = (await this.ctx.storage.get('feedback')) || [];
    this.g.pending = (await this.ctx.storage.get('pending')) || [];
  }

  async fetch(request) {
    await this.init();
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/health') return json({ ok: true, phase: this.g.phase, players: this.connected().length });

    if (path === '/rate-check') {
      const { ip } = await request.json();
      const r = this.g.rate.get(ip);
      if (r && r.lockedUntil > Date.now()) return json({ ok: false });
      return json({ ok: true });
    }
    if (path === '/rate-fail') {
      const { ip } = await request.json();
      const r = this.g.rate.get(ip) || { count: 0, lockedUntil: 0 };
      r.count += 1;
      if (r.count >= 5) { r.lockedUntil = Date.now() + 15 * 60 * 1000; r.count = 0; }
      this.g.rate.set(ip, r);
      return json({ ok: true });
    }
    if (path === '/rate-clear') {
      const { ip } = await request.json();
      this.g.rate.delete(ip);
      return json({ ok: true });
    }

    if (path === '/questions' && request.method === 'GET') return json({ questions: this.g.questions });
    if (path === '/questions' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (_) { return json({ error: 'Invalid request.' }, 400); }
      try {
        const cleaned = validateQuestionSet(body.questions);
        await this.ctx.storage.put('questions', cleaned);
        this.g.questions = cleaned;
        return json({ ok: true, count: cleaned.length });
      } catch (err) { return json({ error: err.message }, 400); }
    }

    if (path === '/clear-data' && request.method === 'POST') {
      this.g.history = [];
      this.g.feedback = [];
      this.g.pending = [];
      this.g.events = [];
      await this.ctx.storage.put('history', this.g.history);
      await this.ctx.storage.put('feedback', this.g.feedback);
      await this.ctx.storage.put('pending', this.g.pending);
      this.resetGame();
      return json({ ok: true });
    }

    if (path === '/answers' && request.method === 'GET') {
      return json({
        players: this.leaderboard(),
        questions: this.g.questions,
        history: this.g.history,
        feedback: this.g.feedback,
        pending: this.g.pending,
      });
    }

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected websocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const role = path.startsWith('/ws/admin') ? 'admin'
      : path.startsWith('/ws/display') ? 'display' : 'student';
    const token = url.searchParams.get('token');

    // Second-tab detection (same rule as the local version).
    if (role === 'student' && token) {
      const existing = [...this.g.players.values()].find((p) => p.token === token);
      if (existing && existing.connected && existing.ws && existing.ws.readyState === WebSocket.OPEN && existing.ws !== server) {
        existing.rejoins = (existing.rejoins || 0) + 1;
        const banned = existing.rejoins >= 2;
        if (banned) existing.banned = true;
        await this.flagPending(existing, 'second tab');
        this.send(existing.ws, { type: 'error', code: banned ? 'blocked' : 'second_tab', message: banned ? 'This place was opened in a second tab too many times. It is now blocked.' : 'Another tab opened this quiz. This tab has been signed out.' });
        this.send(server, { type: 'error', code: banned ? 'blocked' : 'second_tab', message: banned ? 'You used both chances. This place is now blocked.' : 'You opened this quiz in a second tab. This tab has been signed out. You have one more chance.' });
        try { existing.ws.close(4003, 'second tab'); } catch (_) {}
        try { server.close(4003, 'second tab'); } catch (_) {}
        return new Response(null, { status: 101, webSocket: client });
      }
    }

    if (role === 'admin') {
      if (this.adminWs && this.adminWs.readyState === WebSocket.OPEN && this.adminWs !== server) {
        this.send(this.adminWs, { type: 'error', code: 'second_tab', message: 'Another tab opened the admin panel. This tab has been signed out.' });
        this.send(server, { type: 'error', code: 'second_tab', message: 'You opened the admin panel in a second tab. This tab has been signed out.' });
        try { this.adminWs.close(4003, 'second tab'); } catch (_) {}
        try { server.close(4003, 'second tab'); } catch (_) {}
        return new Response(null, { status: 101, webSocket: client });
      }
      this.adminWs = server;
    }

    const meta = { role, id: null, token };
    this.sockets.set(server, meta);
    server.addEventListener('message', (event) => this.onMessage(server, event.data));
    server.addEventListener('close', () => this.onClose(server));

    if (role === 'admin') this.send(server, { type: 'state', state: this.adminState() });
    else if (role === 'display') this.send(server, { type: 'state', state: this.displayState() });
    return new Response(null, { status: 101, webSocket: client });
  }

  send(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch (_) { /* peer gone */ }
  }

  broadcast() {
    for (const [ws, meta] of this.sockets) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (meta.role === 'admin') this.send(ws, { type: 'state', state: this.adminState() });
      else if (meta.role === 'display') this.send(ws, { type: 'state', state: this.displayState() });
      else {
        const p = this.g.players.get(meta.id);
        if (p) this.send(ws, { type: 'state', state: this.studentState(p) });
      }
    }
  }

  broadcastAnswerUpdate(playerId) {
    for (const [ws, meta] of this.sockets) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (meta.role === 'admin') this.send(ws, { type: 'state', state: this.adminState() });
      else if (meta.id === playerId) {
        const p = this.g.players.get(playerId);
        if (p) this.send(ws, { type: 'state', state: this.studentState(p) });
      }
    }
  }

  connected() { return [...this.g.players.values()].filter((p) => p.connected && !p.removed); }

  leaderboard() {
    return [...this.g.players.values()].filter((p) => !p.removed)
      .map((p) => ({
        id: p.id, name: p.name, rollNumber: p.rollNumber, team: p.team,
        score: p.score, correct: p.correctCount, streak: p.streak,
        bestStreak: p.bestStreak, joinedAt: p.joinedAt, total: this.g.questions.length,
      }))
      .sort((a, b) => b.score - a.score || b.correct - a.correct || b.bestStreak - a.bestStreak || a.joinedAt - b.joinedAt)
      .map((p, i) => ({ ...p, rank: i + 1 }));
  }

  rankOf(id) {
    const row = this.leaderboard().find((p) => p.id === id);
    return row ? row.rank : 0;
  }

  publicAnswer(a) {
    if (!a) return null;
    if (a.answers) return { answers: a.answers };
    return a.option !== undefined ? { option: a.option } : { text: a.text };
  }

  projectedQuestion(q) {
    const view = { type: q.type, text: q.text };
    if (q.type === 'mcq') view.options = q.options;
    if (q.type === 'paragraph') {
      view.passage = q.passage;
      view.method = q.method;
      if (q.method === 'mcq') view.subs = q.subs.map((s) => ({ text: s.text, options: s.options }));
    }
    return view;
  }

  studentState(p) {
    const q = this.g.questions[this.g.currentIndex];
    const live = this.g.phase === 'question' || this.g.phase === 'roundEnd';
    const me = { id: p.id, name: p.name, rollNumber: p.rollNumber, team: p.team };
    if (this.g.phase === 'roundEnd') {
      me.score = p.score;
      me.rank = this.rankOf(p.id);
    } else if (this.g.phase !== 'question') {
      me.score = p.score; me.correct = p.correctCount; me.streak = p.streak;
      me.bestStreak = p.bestStreak; me.rank = this.rankOf(p.id); me.total = this.g.questions.length;
    }
    const state = {
      phase: this.g.phase, round: this.g.currentIndex + 1, totalRounds: this.g.questions.length,
      duration: this.g.roundDuration, playerCount: this.connected().length,
      answeredCount: this.g.answers.size, autoAdvanceAt: this.g.autoAdvanceAt, me,
    };
    if (live && q) state.question = this.projectedQuestion(q);
    if (this.g.phase === 'question') {
      state.endsAt = this.g.endsAt;
      state.myAnswer = this.publicAnswer(this.g.answers.get(p.id));
    }
    if (this.g.phase === 'roundEnd') {
      state.myAnswer = this.publicAnswer(this.g.answers.get(p.id));
      state.leaderboard = this.leaderboard().map((r) => ({
        id: r.id, name: r.name, rollNumber: r.rollNumber, rank: r.rank, score: r.score,
      }));
    }
    if (this.g.phase === 'gameEnd') state.leaderboard = this.leaderboard();
    return state;
  }

  displayState() {
    const q = this.g.questions[this.g.currentIndex];
    const showBoard = this.g.phase === 'roundEnd' || this.g.phase === 'gameEnd';
    return {
      phase: this.g.phase,
      round: this.g.currentIndex + 1,
      totalRounds: this.g.questions.length,
      endsAt: this.g.phase === 'question' ? this.g.endsAt : 0,
      duration: this.g.roundDuration,
      question: (this.g.phase === 'question' || this.g.phase === 'roundEnd') && q
        ? this.projectedQuestion(q) : null,
      leaderboard: showBoard ? this.leaderboard() : [],
      events: this.g.events.slice(0, 12),
      joined: this.connected().length,
    };
  }

  adminState() {
    const q = this.g.questions[this.g.currentIndex];
    const board = this.leaderboard();
    return {
      phase: this.g.phase, round: this.g.currentIndex + 1, totalRounds: this.g.questions.length,
      duration: this.g.roundDuration, configured: this.g.questions.length > 0,
      availableQuestions: this.g.questions.length,
      endsAt: this.g.phase === 'question' ? this.g.endsAt : 0,
      answeredCount: this.g.answers.size, onlineCount: this.connected().length,
      autoAdvanceAt: this.g.autoAdvanceAt,
      canUndo: this.g.phase === 'roundEnd' && !!this.g.undo,
      pending: this.g.pending,
      players: board.map((p) => ({
        ...p, connected: this.g.players.get(p.id)?.connected || false,
        answered: this.g.answers.has(p.id),
      })),
      leaderboard: board,
      question: (this.g.phase === 'question' || this.g.phase === 'roundEnd') && q
        ? { ...this.projectedQuestion(q), index: this.g.currentIndex } : null,
    };
  }

  clearTimer() { this.ctx.storage.deleteAlarm(); }

  endRound() {
    if (this.g.phase !== 'question') return;
    this.g.undo = {
      index: this.g.currentIndex, duration: this.g.roundDuration,
      answers: new Map(this.g.answers),
      players: new Map([...this.g.players].map(([id, p]) => [id, {
        score: p.score, correctCount: p.correctCount, streak: p.streak, bestStreak: p.bestStreak,
      }])),
    };
    const q = this.g.questions[this.g.currentIndex];
    const entry = {
      round: this.g.currentIndex + 1,
      index: this.g.currentIndex,
      question: q,
      answers: [...this.g.answers].map(([id, answer]) => {
        const p = this.g.players.get(id);
        return {
          playerId: id,
          name: p?.name || '',
          rollNumber: p?.rollNumber || '',
          team: p?.team || '',
          answer,
        };
      }),
      at: Date.now(),
    };
    this.g.history.push(entry);
    this.ctx.storage.put('history', this.g.history).catch(() => {});
    this.clearTimer();
    this.g.phase = 'roundEnd';
    // Ranking is shown for 5 seconds, then the next question starts automatically.
    this.g.autoAdvanceAt = Date.now() + 5000;
    this.ctx.storage.setAlarm(this.g.autoAdvanceAt);
    this.broadcast();
  }

  undoRound() {
    if (this.g.phase !== 'roundEnd' || !this.g.undo) return;
    const s = this.g.undo;
    this.g.currentIndex = s.index;
    this.g.answers = new Map(s.answers);
    for (const [id, stats] of s.players) {
      const p = this.g.players.get(id);
      if (p) Object.assign(p, stats);
    }
    const last = this.g.history[this.g.history.length - 1];
    if (last && last.index === s.index) {
      this.g.history.pop();
      this.ctx.storage.put('history', this.g.history).catch(() => {});
    }
    this.g.roundDuration = s.duration;
    this.g.phase = 'question';
    this.g.roundStartedAt = Date.now();
    this.g.endsAt = this.g.roundStartedAt + this.g.roundDuration * 1000;
    this.g.autoAdvanceAt = 0;
    this.g.undo = null;
    this.clearTimer();
    this.ctx.storage.setAlarm(this.g.endsAt);
    this.broadcast();
  }

  startRound() {
    if (this.g.phase !== 'lobby' && this.g.phase !== 'roundEnd') return;
    if (this.g.currentIndex + 1 >= this.g.questions.length) {
      this.clearTimer(); this.g.undo = null; this.g.phase = 'gameEnd';
      this.ctx.storage.put('lastResults', this.leaderboard()).catch(() => {});
      this.broadcast(); return;
    }
    this.g.currentIndex += 1;
    this.g.answers = new Map();
    this.g.undo = null;
    this.g.phase = 'question';
    this.g.roundDuration = this.g.questions[this.g.currentIndex]?.seconds || 30;
    this.g.roundStartedAt = Date.now();
    this.g.endsAt = this.g.roundStartedAt + this.g.roundDuration * 1000;
    this.g.autoAdvanceAt = 0;
    this.clearTimer();
    this.ctx.storage.setAlarm(this.g.endsAt);
    this.broadcast();
  }

  createGame() {
    this.clearTimer();
    this.g.questions = this.g.questions.slice();
    this.g.roundDuration = this.g.questions[0]?.seconds || 30;
    this.g.currentIndex = -1;
    this.g.answers = new Map();
    this.g.endsAt = 0;
    this.g.undo = null;
    this.g.events = [];
    this.g.phase = 'lobby';
    for (const [id, p] of this.g.players) if (!p.connected) this.g.players.delete(id);
    for (const p of this.g.players.values()) {
      p.score = 0; p.correctCount = 0; p.streak = 0; p.bestStreak = 0;
    }
    for (const [ws, meta] of this.sockets) this.send(ws, { type: 'game_reset' });
    this.broadcast();
  }

  resetGame() {
    this.clearTimer();
    this.g.phase = 'idle';
    this.g.questions = this.g.questions.slice();
    this.g.currentIndex = -1;
    this.g.answers = new Map();
    this.g.endsAt = 0;
    this.g.undo = null;
    this.g.events = [];
    for (const [id, p] of this.g.players) if (!p.connected) this.g.players.delete(id);
    for (const p of this.g.players.values()) {
      p.score = 0; p.correctCount = 0; p.streak = 0; p.bestStreak = 0;
    }
    for (const [ws] of this.sockets) this.send(ws, { type: 'game_reset' });
    this.broadcast();
  }

  alarm() {
    if (this.g.phase === 'question') this.endRound();
    else if (this.g.phase === 'roundEnd') this.startRound();
  }

  validatePlayer(msg) {
    const name = String(msg.name ?? '').trim().slice(0, 40);
    const rollNumber = String(msg.rollNumber ?? '').trim().slice(0, 30);
    const team = String(msg.team ?? '').trim().slice(0, 40);
    if (!name) return 'Please enter your name.';
    if (!rollNumber) return 'Please enter your roll number.';
    return { name, rollNumber, team };
  }

  addEvent(text, kind = 'info') {
    this.g.events.unshift({ text, kind, at: Date.now() });
    if (this.g.events.length > 40) this.g.events.length = 40;
  }

  async flagPending(player, reason) {
    if (!player) return;
    const existing = this.g.pending.find((x) => x.id === player.id);
    if (existing) {
      existing.reason = reason;
      existing.at = Date.now();
    } else {
      this.g.pending.push({
        id: player.id,
        name: player.name,
        rollNumber: player.rollNumber,
        reason,
        at: Date.now(),
      });
      this.addEvent(`${player.name} (${player.rollNumber}) left the quiz — ${reason}`, 'warn');
    }
    await this.ctx.storage.put('pending', this.g.pending);
  }

  async approvePlayers(id, all, ids) {
    const list = ids
      ? this.g.pending.filter((x) => ids.includes(x.id))
      : all ? this.g.pending.slice() : this.g.pending.filter((x) => x.id === id);
    for (const item of list) {
      const p = this.g.players.get(item.id);
      if (p) {
        this.addEvent(`${p.name} was allowed back by the admin`, 'good');
        p.banned = false;
        p.removed = false;
        p.denied = false;
        p.rejoins = 0;
        for (const [ws, meta] of this.sockets) {
          if (meta.id === p.id || meta.token === p.token) this.send(ws, { type: 'approved' });
        }
      }
    }
    this.g.pending = this.g.pending.filter((x) => !list.includes(x));
    await this.ctx.storage.put('pending', this.g.pending);
    this.broadcast();
  }

  async denyPlayers(id, all, ids) {
    const list = ids
      ? this.g.pending.filter((x) => ids.includes(x.id))
      : all ? this.g.pending.slice() : this.g.pending.filter((x) => x.id === id);
    for (const item of list) {
      const p = this.g.players.get(item.id);
      if (p) {
        this.addEvent(`${p.name} was denied re-entry by the admin`, 'warn');
        p.banned = true;
        p.denied = true;
        for (const [ws, meta] of this.sockets) {
          if (meta.id === p.id || meta.token === p.token) {
            this.send(ws, { type: 'error', code: 'denied', message: 'The admin denied your rejoin request.' });
            try { ws.close(4006, 'rejoin denied'); } catch (_) { /* ignore */ }
          }
        }
      }
    }
    this.g.pending = this.g.pending.filter((x) => !list.includes(x));
    await this.ctx.storage.put('pending', this.g.pending);
    this.broadcast();
  }

  onClose(ws) {
    const meta = this.sockets.get(ws);
    this.sockets.delete(ws);
    if (this.adminWs === ws) this.adminWs = null;
    if (!meta || meta.role !== 'student') return;
    const p = this.g.players.get(meta.id);
    if (p && p.ws === ws) { p.connected = false; p.ws = null; }
    this.broadcast();
  }

  async onMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    if (!msg || typeof msg.type !== 'string') return;
    const meta = this.sockets.get(ws);
    if (!meta) return;

    switch (msg.type) {
      case 'join': {
        if (meta.role !== 'student') return;
        const valid = this.validatePlayer(msg);
        if (typeof valid === 'string') return this.send(ws, { type: 'error', message: valid });
        let p = null;
        if (msg.token) p = [...this.g.players.values()].find((x) => x.token === msg.token);
        if (p) {
          if (p.denied) return this.send(ws, { type: 'error', code: 'denied', message: 'The admin denied your rejoin request.' });
          if (p.removed) return this.send(ws, { type: 'error', code: 'removed', message: 'You were removed from this quiz. Ask the admin to allow you back.' });
          if (p.banned) return this.send(ws, { type: 'error', code: 'blocked', message: 'This place is paused. Send a rejoin request and wait for the admin.' });
          const otherOpen = p.connected && p.ws && p.ws.readyState === WebSocket.OPEN && p.ws !== ws;
          if (otherOpen) {
            p.rejoins = (p.rejoins || 0) + 1;
            const banned = p.rejoins >= 2;
            if (banned) p.banned = true;
            await this.flagPending(p, 'second tab');
            this.send(p.ws, { type: 'error', code: banned ? 'blocked' : 'second_tab', message: 'Another tab opened this quiz. This tab has been signed out.' });
            this.send(ws, { type: 'error', code: banned ? 'blocked' : 'second_tab', message: banned ? 'You used both chances. This place is now blocked.' : 'You opened this quiz in a second tab. This tab has been signed out. You have one more chance.' });
            try { p.ws.close(4003, 'second tab'); } catch (_) {}
            try { ws.close(4003, 'second tab'); } catch (_) {}
            return;
          }
          if ((p.rejoins || 0) >= 2) {
            p.banned = true;
            return this.send(ws, { type: 'error', code: 'blocked', message: 'You used all your rejoin chances. This place can no longer enter the quiz.' });
          }
          p.rejoins = (p.rejoins || 0) + 1;
        } else {
          const duplicate = [...this.g.players.values()].find(
            (x) => !x.removed && x.connected && x.rollNumber && x.rollNumber === valid.rollNumber
          );
          if (duplicate) {
            return this.send(ws, {
              type: 'error',
              code: 'duplicate',
              message: 'This roll number is already joined on another device. Use the device that joined first.',
            });
          }
          if (this.g.players.size >= 150) return this.send(ws, { type: 'error', message: 'This quiz is full. Please try again later.' });
          p = {
            id: crypto.randomUUID(), token: crypto.randomUUID(), score: 0, correctCount: 0,
            streak: 0, bestStreak: 0, rejoins: 0, banned: false, removed: false, denied: false, joinedAt: Date.now(), connected: true, ws,
          };
          this.g.players.set(p.id, p);
        }
        p.name = valid.name; p.rollNumber = valid.rollNumber; p.team = valid.team;
        p.connected = true; p.ws = ws; meta.id = p.id; meta.token = p.token;
        this.send(ws, { type: 'joined', id: p.id, token: p.token, name: p.name });
        this.send(ws, { type: 'state', state: this.studentState(p) });
        this.broadcast();
        break;
      }

      case 'answer': {
        if (meta.role !== 'student') return;
        const p = this.g.players.get(meta.id);
        if (!p) return;
        if (this.g.phase !== 'question') return this.send(ws, { type: 'error', message: 'There is no active question right now.' });
        if (this.g.answers.has(p.id)) return this.send(ws, { type: 'error', message: 'You have already answered this question.' });
        const q = this.g.questions[this.g.currentIndex];
        let answer;
        if (q.type === 'mcq') {
          const option = Number(msg.optionIndex);
          if (!Number.isInteger(option) || option < 0 || option > 3) return this.send(ws, { type: 'error', message: 'Please choose one of the four options.' });
          answer = { option, correct: option === q.correct };
        } else if (q.type === 'paragraph' && q.method === 'mcq') {
          const answers = Array.isArray(msg.answers) ? msg.answers.map(Number) : [];
          if (answers.length !== q.subs.length || answers.some((a, i) => !Number.isInteger(a) || a < 0 || a > 3)) {
            return this.send(ws, { type: 'error', message: 'Please answer every question in the passage.' });
          }
          const right = q.subs.filter((s, i) => answers[i] === s.correct).length;
          answer = { answers, correct: right === q.subs.length, partial: right, totalSubs: q.subs.length };
        } else {
          const text = String(msg.text ?? '').trim().slice(0, 2000);
          if (text.length < 3) return this.send(ws, { type: 'error', message: 'Please write your answer before submitting.' });
          answer = { text, correct: answerMatchesKeywords(text, q.keywords, q.requireAll) };
        }

        const timeMs = Math.max(0, Date.now() - this.g.roundStartedAt);
        let earned = 0;
        if (answer.correct) {
          p.streak += 1;
          const speed = Math.round(50 * Math.max(0, 1 - timeMs / (this.g.roundDuration * 1000)));
          earned = 100 + speed + (p.streak - 1) * 20;
          p.correctCount += 1;
          p.bestStreak = Math.max(p.bestStreak, p.streak);
        } else if (answer.totalSubs) {
          earned = Math.round((answer.partial / answer.totalSubs) * 100);
          p.streak = 0;
        } else p.streak = 0;
        p.score += earned;
        answer.points = earned;
        answer.timeMs = timeMs;
        this.g.answers.set(p.id, answer);
        this.broadcastAnswerUpdate(p.id);
        const active = this.connected();
        if (active.length > 0 && active.every((t) => this.g.answers.has(t.id))) this.endRound();
        break;
      }

      case 'create_game': if (meta.role === 'admin') this.createGame(); break;
      case 'start_round': case 'next_round': if (meta.role === 'admin') this.startRound(); break;
      case 'end_round': if (meta.role === 'admin') this.endRound(); break;
      case 'undo_round': if (meta.role === 'admin') this.undoRound(); break;
      case 'reset_game': if (meta.role === 'admin') this.resetGame(); break;
      case 'approve_player':
        if (meta.role === 'admin') await this.approvePlayers(String(msg.id || ''), false);
        break;
      case 'approve_all':
        if (meta.role === 'admin') await this.approvePlayers('', true);
        break;
      case 'deny_player':
        if (meta.role === 'admin') await this.denyPlayers(String(msg.id || ''), false);
        break;
      case 'deny_all':
        if (meta.role === 'admin') await this.denyPlayers('', true);
        break;
      case 'approve_selected':
        if (meta.role === 'admin') await this.approvePlayers('', false, Array.isArray(msg.ids) ? msg.ids : []);
        break;
      case 'deny_selected':
        if (meta.role === 'admin') await this.denyPlayers('', false, Array.isArray(msg.ids) ? msg.ids : []);
        break;
      case 'request_rejoin': {
        if (meta.role !== 'student') return;
        const player = (msg.token && [...this.g.players.values()].find((x) => x.token === msg.token)) ||
          [...this.g.players.values()].find((x) => x.rollNumber === String(msg.rollNumber || ''));
        if (!player) return this.send(ws, { type: 'error', message: 'We could not find your details. Please join again.' });
        player.name = String(msg.name || player.name).trim().slice(0, 40) || player.name;
        player.rollNumber = String(msg.rollNumber || player.rollNumber).trim().slice(0, 30) || player.rollNumber;
        await this.flagPending(player, 'rejoin request');
        this.send(ws, { type: 'rejoin_requested' });
        this.broadcast();
        break;
      }
      case 'away': {
        if (meta.role !== 'student') return;
        const p = this.g.players.get(meta.id);
        if (!p || p.removed) return;
        p.rejoins = (p.rejoins || 0) + 1;
        const banned = p.rejoins >= 2;
        if (banned) p.banned = true;
        await this.flagPending(p, 'left quiz tab');
        this.send(ws, {
          type: 'error',
          code: banned ? 'blocked' : 'away',
          message: banned
            ? 'You left the quiz tab twice. This place is now blocked.'
            : 'You switched away from the quiz tab. This device has been signed out. You have one more chance.',
        });
        p.connected = false;
        if (p.ws === ws) p.ws = null;
        for (const [sock, clientMeta] of this.sockets) {
          if (clientMeta.id === p.id && sock !== this.adminWs) {
            this.sockets.delete(sock);
            try { sock.close(4005, 'left quiz tab'); } catch (_) { /* ignore */ }
          }
        }
        try { ws.close(4005, 'left quiz tab'); } catch (_) { /* ignore */ }
        this.broadcast();
        break;
      }
      case 'remove_player': {
        if (meta.role !== 'admin') return;
        const target = this.g.players.get(String(msg.id || ''));
        if (!target) return;
        target.removed = true;
        await this.flagPending(target, 'removed by admin');
        target.connected = false;
        if (target.ws) {
          this.send(target.ws, { type: 'error', code: 'removed', message: 'The admin removed you from this quiz.' });
          const socket = target.ws;
          target.ws = null;
          for (const [wsClient, clientMeta] of this.sockets) {
            if (clientMeta.id === target.id && wsClient !== this.adminWs) {
              this.sockets.delete(wsClient);
              try { wsClient.close(4004, 'removed by admin'); } catch (_) { /* ignore */ }
            }
          }
          try { socket.close(4004, 'removed by admin'); } catch (_) { /* ignore */ }
        }
        this.broadcast();
        break;
      }
      case 'feedback': {
        if (meta.role !== 'student') return;
        const p = this.g.players.get(meta.id);
        const rate = (v) => Math.min(5, Math.max(1, Number(v) || 0));
        const rating = rate(msg.website || msg.rating);
        const website = rating;
        const games = rate(msg.games);
        const questions = rate(msg.questions);
        const issue = String(msg.issue || '').trim().slice(0, 3);
        const issueDetails = String(msg.issueDetails || '').trim().slice(0, 1000);
        const improve = String(msg.improve || msg.comment || '').trim().slice(0, 1000);
        if (!website) return this.send(ws, { type: 'error', message: 'Please choose a rating for the website.' });
        this.g.feedback.push({
          name: p?.name || '', rollNumber: p?.rollNumber || '', team: p?.team || '',
          rating, website, games, questions, issue, issueDetails, improve,
          comment: improve, at: Date.now(),
        });
        this.ctx.storage.put('feedback', this.g.feedback).catch(() => {});
        this.send(ws, { type: 'feedback_saved' });
        break;
      }
      case 'leave': {
        if (meta.role === 'student') {
          const p = this.g.players.get(meta.id);
          if (p && p.ws === ws) { p.connected = false; p.ws = null; }
          meta.role = null; meta.id = null;
          this.broadcast();
        }
        break;
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Worker — static assets, login/session APIs, WebSocket routing        */
/* ------------------------------------------------------------------ */

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

function withSecurity(response) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!path.startsWith('/api/') && !path.startsWith('/ws/') && path !== '/health') {
      return withSecurity(await env.ASSETS.fetch(request));
    }

    // A fresh room name guarantees all clients run the newest game rules after an upgrade.
    const stub = env.QUIZ_ROOM.get(env.QUIZ_ROOM.idFromName('quiz-main-v8'));

    if (path === '/health') return withSecurity(await stub.fetch(new Request(url, { headers: request.headers })));

    if (path === '/api/admin/session' && request.method === 'GET') {
      return withSecurity(json({ authorized: await isAuthorized(request, env) }));
    }

    if (path === '/api/login' && request.method === 'POST') {
      const ip = request.headers.get('cf-connecting-ip') || 'unknown';
      const gate = await stub.fetch(new Request('https://quiz/rate-check', { method: 'POST', body: JSON.stringify({ ip }) }));
      if (!(await gate.json()).ok) return withSecurity(json({ error: 'Too many failed attempts. Please wait 15 minutes.' }, 429));
      let body;
      try { body = await request.json(); } catch (_) { return withSecurity(json({ error: 'Invalid request.' }, 400)); }
      const email = String(body.email ?? '').trim().toLowerCase();
      const ok = email === env.ADMIN_EMAIL && await verifyPassword(body.password, env);
      if (!ok) {
        await stub.fetch(new Request('https://quiz/rate-fail', { method: 'POST', body: JSON.stringify({ ip }) }));
        return withSecurity(json({ error: 'Invalid email or password.' }, 401));
      }
      await stub.fetch(new Request('https://quiz/rate-clear', { method: 'POST', body: JSON.stringify({ ip }) }));
      const payload = b64u(JSON.stringify({ email: env.ADMIN_EMAIL, exp: Date.now() + 8 * 60 * 60 * 1000 }));
      const signature = await hmac(env.SESSION_SECRET, payload);
      return withSecurity(json({ ok: true }, 200, {
        'set-cookie': `quiz_session=${payload}.${signature}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`,
      }));
    }

    if (path === '/api/logout' && request.method === 'POST') {
      return withSecurity(json({ ok: true }, 200, {
        'set-cookie': 'quiz_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0',
      }));
    }

    if (path === '/api/admin/questions') {
      if (!(await isAuthorized(request, env))) return withSecurity(json({ error: 'Not authorized.' }, 401));
      const target = new Request('https://quiz/questions', request);
      if (request.method === 'GET') return withSecurity(await stub.fetch(target));
      if (request.method === 'POST') return withSecurity(await stub.fetch(target));
      return withSecurity(json({ error: 'Method not allowed.' }, 405));
    }

    if (path === '/api/admin/clear-data' && request.method === 'POST') {
      if (!(await isAuthorized(request, env))) return withSecurity(json({ error: 'Not authorized.' }, 401));
      return withSecurity(await stub.fetch(new Request('https://quiz/clear-data', { method: 'POST' })));
    }

    if (path === '/api/admin/answers' && request.method === 'GET') {
      if (!(await isAuthorized(request, env))) return withSecurity(json({ error: 'Not authorized.' }, 401));
      const target = new Request('https://quiz/answers', { headers: request.headers });
      return withSecurity(await stub.fetch(target));
    }

    if (path.startsWith('/ws/')) {
      if (path === '/ws/admin' && !(await isAuthorized(request, env))) {
        return new Response('Unauthorized', { status: 401 });
      }
      return stub.fetch(request); // Durable Object upgrades the connection
    }

    return withSecurity(json({ error: 'Not found.' }, 404));
  },
};
