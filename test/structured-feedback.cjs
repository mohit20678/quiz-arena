'use strict';
const WebSocket = require('ws');
const assert = require('assert');
const PORT = Number(process.env.PORT) || 8787;
const HTTP = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}`;

function client(path) {
  const ws = new WebSocket(WS + path);
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
    next(match, ms = 5000) {
      const found = inbox.findIndex(match);
      if (found !== -1) return Promise.resolve(inbox.splice(found, 1)[0]);
      return new Promise((r, j) => {
        const t = setTimeout(() => j(new Error('timed out')), ms);
        waiters.push({ match, resolve: (m) => { clearTimeout(t); r(m); } });
      });
    },
    close: () => ws.close(),
  };
}

(async () => {
  const login = await fetch(`${HTTP}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'mohithedau1@gmail.com', password: process.env.ADMIN_PASSWORD }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const student = client('/ws/student');
  await student.ready;
  student.send({ type: 'join', name: 'Review Test', rollNumber: 'RV1' });
  await student.next((m) => m.type === 'joined');

  student.send({
    type: 'feedback', website: 5, games: 4, questions: 3,
    issue: 'Yes', issueDetails: 'Button did not work once', improve: 'More time please',
  });
  await student.next((m) => m.type === 'feedback_saved');

  const data = await (await fetch(`${HTTP}/api/admin/answers`, { headers: { Cookie: cookie } })).json();
  const f = data.feedback.find((x) => x.name === 'Review Test');
  assert(f, 'feedback saved');
  assert.strictEqual(f.website, 5);
  assert.strictEqual(f.games, 4);
  assert.strictEqual(f.questions, 3);
  assert.strictEqual(f.issue, 'Yes');
  assert.strictEqual(f.issueDetails, 'Button did not work once');
  assert.strictEqual(f.improve, 'More time please');

  console.log('PASS: structured post-quiz review stored and visible in review API.');
  student.close();
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
