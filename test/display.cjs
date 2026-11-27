'use strict';
const WebSocket = require('ws');
const assert = require('assert');
const PORT = Number(process.env.PORT) || 8787;
const HTTP = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}`;
const PASSWORD = process.env.ADMIN_PASSWORD || '';

function client(path, cookie) {
  const ws = new WebSocket(WS + path, cookie ? { headers: { Cookie: cookie } } : {});
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    inbox.push(m);
    const i = waiters.findIndex((w) => w.match(m));
    if (i !== -1) waiters.splice(i, 1)[0].resolve(m);
  });
  return {
    ready: new Promise((r, j) => { ws.on('open', r); ws.on('error', j); }),
    send: (o) => ws.send(JSON.stringify(o)),
    next(match, ms = 6000) {
      const found = inbox.findIndex(match);
      if (found !== -1) return Promise.resolve(inbox.splice(found, 1)[0]);
      return new Promise((r, j) => {
        const t = setTimeout(() => j(new Error('timed out')), ms);
        waiters.push({ match, resolve: (m) => { clearTimeout(t); r(m); } });
      });
    },
    state(predicate, ms = 6000) {
      return this.next((m) => m.type === 'state' && predicate(m.state), ms).then((m) => m.state);
    },
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
  await fetch(`${HTTP}/api/admin/clear-data`, { method: 'POST', headers: { Cookie: cookie } });

  const admin = client('/ws/admin', cookie);
  const display = client('/ws/display');
  const student = client('/ws/student');
  await Promise.all([admin.ready, display.ready, student.ready]);

  admin.send({ type: 'reset_game' });
  await admin.state((s) => s.phase === 'idle');
  student.send({ type: 'join', name: 'Display Test', rollNumber: 'DP1' });
  await student.next((m) => m.type === 'joined');
  admin.send({ type: 'create_game' });
  await student.state((s) => s.phase === 'lobby');

  admin.send({ type: 'start_round' });
  const q = await display.state((s) => s.phase === 'question' && s.question);
  assert.strictEqual(q.question.correct, undefined, 'display hides correct option');
  assert(q.question.options, 'display shows options');
  assert.strictEqual(q.leaderboard.length, 0, 'no rankings during the question');

  student.send({ type: 'answer', optionIndex: 1 });
  await student.state((s) => s.phase === 'question' && s.myAnswer);
  admin.send({ type: 'end_round' });
  const ranked = await display.state((s) => s.phase === 'roundEnd' && s.leaderboard.length === 1);
  assert.strictEqual(ranked.leaderboard[0].name, 'Display Test');
  assert.strictEqual(ranked.question.correct, undefined, 'still no correct answer after round');

  student.send({ type: 'away' });
  const kicked = await display.state((s) => s.events.some((e) => e.text.includes('Display Test')));
  assert(kicked, 'display shows kicked-out event');

  console.log('PASS: display shows question, rankings and events only — no answers or controls.');
  admin.close(); display.close(); student.close();
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
