'use strict';

/* Verifies a round ends by itself once every connected student has answered. */

const WebSocket = require('ws');
const assert = require('assert');

const PORT = Number(process.env.PORT) || 4001;
const HTTP = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}`;
const EMAIL = process.env.ADMIN_EMAIL || 'mohithedau1@gmail.com';
const PASSWORD = process.env.ADMIN_PASSWORD || '';

function client(path, cookie) {
  const ws = new WebSocket(`${WS}${path}`, cookie ? { headers: { Cookie: cookie } } : {});
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
    next(match, ms = 4000) {
      const found = inbox.findIndex(match);
      if (found !== -1) return Promise.resolve(inbox.splice(found, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out')), ms);
        waiters.push({ match, resolve: (m) => { clearTimeout(timer); resolve(m); } });
      });
    },
    state(predicate, ms = 4000) {
      return this.next((m) => m.type === 'state' && predicate(m.state), ms).then((m) => m.state);
    },
    close: () => ws.close(),
  };
}

(async () => {
  if (!PASSWORD) { console.error('Set ADMIN_PASSWORD first.'); process.exit(1); }
  const res = await fetch(`${HTTP}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  assert(res.ok, 'login failed');
  const cookie = res.headers.get('set-cookie').split(';')[0];
  await fetch(`${HTTP}/api/admin/questions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ questions: require('../questions.json') }),
  });

  const admin = client('/ws/admin', cookie);
  const a = client('/ws/student');
  const b = client('/ws/student');
  await Promise.all([admin.ready, a.ready, b.ready]);

  admin.send({ type: 'reset_game' });
  await admin.state((s) => s.phase === 'idle');
  a.send({ type: 'join', name: 'One', rollNumber: '1' });
  b.send({ type: 'join', name: 'Two', rollNumber: '2' });
  await a.next((m) => m.type === 'joined');
  await b.next((m) => m.type === 'joined');

  admin.send({ type: 'create_game' });
  await a.state((s) => s.phase === 'lobby');
  admin.send({ type: 'start_round' });
  const question = await a.state((s) => s.phase === 'question');

  a.send({ type: 'answer', optionIndex: 0 });
  b.send({ type: 'answer', optionIndex: 1 });

  // When everyone answers, the round ends by itself.
  const adminView = await admin.state((s) => s.phase === 'roundEnd' && s.answeredCount === 2, 4000);
  assert(adminView, 'round auto-ended when both students answered');
  assert.strictEqual(adminView.players.find((p) => p.name === 'One').answered, true);
  assert.strictEqual(adminView.players.find((p) => p.name === 'Two').answered, true);
  assert.strictEqual(adminView.players.every((p) => p.answer === undefined), true,
    'admin does not receive the chosen option');

  const ended = await a.state((s) => s.phase === 'roundEnd', 4000);
  assert.strictEqual(ended.round, 1, 'round 1 ended');
  assert(ended.leaderboard && ended.leaderboard.length === 2, 'ranking is shown to students');
  assert.strictEqual(ended.leaderboard[0].correct, undefined, 'ranking hides correctness');
  assert(ended.leaderboard[0].score !== undefined, 'ranking shows points');

  // Admin can see each student's chosen option.
  const adminEnded = await admin.state((s) => s.phase === 'roundEnd');
  assert(adminEnded.players.every((p) => p.answered === true),
    'admin sees answered status without the chosen option');
  assert.strictEqual(adminEnded.canUndo, true, 'undo is available right after ending a round');
  assert.strictEqual(adminEnded.question.correct, undefined, 'projected admin view hides correct answer');

  // Undo an accidental round end.
  admin.send({ type: 'undo_round' });
  const restored = await admin.state((s) => s.phase === 'question' && s.round === 1);
  assert.strictEqual(restored.answeredCount, 0, 'undo restores unanswered state');
  assert.strictEqual(restored.players.every((p) => p.score === 0), true, 'undo restores scores');
  assert.strictEqual(restored.canUndo, false, 'undo no longer offered after restoring');

  console.log('PASS: auto-end on all answered, ranking, hidden answer, and undo.');
  console.log(`First question type: ${question.question.type}`);
  admin.close(); a.close(); b.close();
  process.exit(0);
})().catch((err) => { console.error('FAIL:', err.message); process.exit(1); });
