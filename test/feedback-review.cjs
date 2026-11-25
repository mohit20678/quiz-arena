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
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    inbox.push(msg);
    const i = waiters.findIndex((w) => w.match(msg));
    if (i !== -1) waiters.splice(i, 1)[0].resolve(msg);
  });
  return {
    ready: new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); }),
    send: (o) => ws.send(JSON.stringify(o)),
    next(match, ms = 5000) {
      const found = inbox.findIndex(match);
      if (found !== -1) return Promise.resolve(inbox.splice(found, 1)[0]);
      return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('timed out')), ms);
        waiters.push({ match, resolve: (m) => { clearTimeout(t); res(m); } });
      });
    },
    state(predicate, ms = 5000) {
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
  await fetch(`${HTTP}/api/admin/questions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ questions: require('../questions.json') }),
  });

  const admin = client('/ws/admin', cookie);
  const student = client('/ws/student');
  await Promise.all([admin.ready, student.ready]);
  admin.send({ type: 'reset_game' });
  await admin.state((s) => s.phase === 'idle');
  student.send({ type: 'join', name: 'Feedback Test', rollNumber: 'FB1' });
  await student.next((m) => m.type === 'joined');
  admin.send({ type: 'create_game' });
  await student.state((s) => s.phase === 'lobby');
  admin.send({ type: 'start_round' });
  const q = await student.state((s) => s.phase === 'question');
  student.send({ type: 'answer', optionIndex: q.question.options.findIndex((o) => o === 'Cellulose acetate') });
  await student.state((s) => s.phase === 'question' && s.myAnswer);
  admin.send({ type: 'end_round' });
  await student.state((s) => s.phase === 'roundEnd');

  student.send({ type: 'feedback', rating: 5, comment: 'Very smooth, easy to join on mobile.' });
  await student.next((m) => m.type === 'feedback_saved');

  const data = await (await fetch(`${HTTP}/api/admin/answers`, { headers: { Cookie: cookie } })).json();
  assert(data.history.length >= 1, 'answers history recorded');
  assert(data.history.some((h) => h.answers.some((a) => a.name === 'Feedback Test')), 'new answer appears in history');
  assert(data.feedback.length >= 1, 'feedback recorded');
  assert.strictEqual(data.feedback[data.feedback.length - 1].rating, 5);
  assert.strictEqual((await fetch(`${HTTP}/review`)).status, 200);

  console.log('PASS: feedback saved; review API shows answers and feedback; review page loads.');
  admin.close(); student.close();
  process.exit(0);
})().catch((err) => { console.error('FAIL:', err.message); process.exit(1); });
