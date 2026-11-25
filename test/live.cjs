'use strict';
/* Quick live check against the deployed Cloudflare URL. */
const WebSocket = require('ws');
const assert = require('assert');

const BASE = process.env.BASE || 'https://quiz-arena.quiz-arena-hitam.workers.dev';
const PASSWORD = process.env.ADMIN_PASSWORD || '';

function client(path, cookie) {
  const ws = new WebSocket(BASE.replace('https', 'wss') + path, cookie ? { headers: { Cookie: cookie } } : {});
  const inbox = [];
  const waiters = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    inbox.push(msg);
    const i = waiters.findIndex((w) => w.match(msg));
    if (i !== -1) waiters.splice(i, 1)[0].resolve(msg);
  });
  return {
    ready: new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); }),
    send: (o) => ws.send(JSON.stringify(o)),
    next(match, ms = 10000) {
      const found = inbox.findIndex(match);
      if (found !== -1) return Promise.resolve(inbox.splice(found, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out')), ms);
        waiters.push({ match, resolve: (m) => { clearTimeout(timer); resolve(m); } });
      });
    },
    state(predicate, ms = 10000) {
      return this.next((m) => m.type === 'state' && predicate(m.state), ms).then((m) => m.state);
    },
    close: () => ws.close(),
  };
}

(async () => {
  if (!PASSWORD) { console.error('Set ADMIN_PASSWORD.'); process.exit(1); }
  const login = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'mohithedau1@gmail.com', password: PASSWORD }),
  });
  assert(login.ok, 'login failed');
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const questions = await (await fetch(`${BASE}/api/admin/questions`, { headers: { Cookie: cookie } })).json();
  assert.strictEqual(questions.questions.length, 10);

  const admin = client('/ws/admin', cookie);
  const student = client('/ws/student');
  await Promise.all([admin.ready, student.ready]);

  admin.send({ type: 'reset_game' });
  await admin.state((s) => s.phase === 'idle');
  student.send({ type: 'join', name: 'Live Test', rollNumber: 'L1' });
  await student.next((m) => m.type === 'joined');
  admin.send({ type: 'create_game' });
  await student.state((s) => s.phase === 'lobby');
  admin.send({ type: 'start_round' });
  const q1 = await student.state((s) => s.phase === 'question');
  console.log('Live Q1:', q1.question.text);

  student.send({ type: 'answer', optionIndex: 1 });
  await student.state((s) => s.phase === 'question' && s.myAnswer);
  admin.send({ type: 'end_round' });
  const ended = await student.state((s) => s.phase === 'roundEnd');
  assert.strictEqual(ended.leaderboard.length, 1, 'ranking shown');
  assert.strictEqual(ended.myAnswer.points, undefined, 'points hidden mid-game');

  admin.close(); student.close();
  console.log('LIVE WEBSOCKET OK');
  process.exit(0);
})().catch((err) => { console.error('FAIL:', err.message); process.exit(1); });
