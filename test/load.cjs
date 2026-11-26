'use strict';
/* 80-student load test: join, answer, auto-end, ranking broadcast. */
const WebSocket = require('ws');
const assert = require('assert');
const PORT = Number(process.env.PORT) || 8787;
const HTTP = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}`;
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const COUNT = Number(process.env.COUNT) || 80;

function client(path, cookie) {
  const ws = new WebSocket(WS + path, cookie ? { headers: { Cookie: cookie } } : {});
  const inbox = [];
  const waiters = [];
  let error = null;
  ws.on('error', (e) => { error = e; });
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    inbox.push(m);
    const i = waiters.findIndex((w) => w.match(m));
    if (i !== -1) waiters.splice(i, 1)[0].resolve(m);
  });
  return {
    ready: new Promise((r, j) => { ws.on('open', r); ws.on('error', j); }),
    send: (o) => ws.send(JSON.stringify(o)),
    next(match, ms = 15000) {
      const found = inbox.findIndex(match);
      if (found !== -1) return Promise.resolve(inbox.splice(found, 1)[0]);
      return new Promise((r, j) => {
        const t = setTimeout(() => j(new Error('timed out')), ms);
        waiters.push({ match, resolve: (m) => { clearTimeout(t); r(m); } });
      });
    },
    state(predicate, ms = 15000) {
      return this.next((m) => m.type === 'state' && predicate(m.state), ms).then((m) => m.state);
    },
    error: () => error,
    close: () => ws.close(),
  };
}

(async () => {
  if (!PASSWORD) { console.error('Set ADMIN_PASSWORD.'); process.exit(1); }
  const login = await fetch(`${HTTP}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'mohithedau1@gmail.com', password: PASSWORD }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const admin = client('/ws/admin', cookie);
  await admin.ready;
  admin.send({ type: 'reset_game' });
  await admin.state((s) => s.phase === 'idle');

  const students = [];
  for (let i = 0; i < COUNT; i++) {
    const s = client('/ws/student');
    await s.ready;
    s.send({ type: 'join', name: `Student ${i + 1}`, rollNumber: `LOAD${String(i + 1).padStart(3, '0')}` });
    await s.next((m) => m.type === 'joined');
    students.push(s);
  }
  const lobby = await admin.state((s) => s.onlineCount === COUNT, 20000);

  admin.send({ type: 'create_game' });
  await students[0].state((s) => s.phase === 'lobby', 15000);
  admin.send({ type: 'start_round' });
  const q = await students[0].state((s) => s.phase === 'question' && s.round === 1, 15000);

  const t0 = Date.now();
  for (const s of students) s.send({ type: 'answer', optionIndex: 1 });
  const ended = await students[0].state((s) => s.phase === 'roundEnd' && s.round === 1, 20000);
  assert.strictEqual(ended.leaderboard.length, COUNT, 'every student appears in the ranking');
  assert(ended.leaderboard.every((r) => r.score !== undefined), 'ranking has points for everyone');
  const elapsed = Date.now() - t0;
  const failures = students.filter((s) => s.error()).length;
  assert.strictEqual(failures, 0, 'no socket errors');

  console.log(`PASS: ${COUNT} students joined, answered, auto-ended and ranked in ${elapsed} ms with 0 errors.`);
  admin.close(); students.forEach((s) => s.close());
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
