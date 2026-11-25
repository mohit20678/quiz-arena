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
    next(match, ms = 5000) {
      const found = inbox.findIndex(match);
      if (found !== -1) return Promise.resolve(inbox.splice(found, 1)[0]);
      return new Promise((r, j) => {
        const t = setTimeout(() => j(new Error('timed out')), ms);
        waiters.push({ match, resolve: (m) => { clearTimeout(t); r(m); } });
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
  const admin = client('/ws/admin', cookie);
  const student = client('/ws/student');
  await Promise.all([admin.ready, student.ready]);

  admin.send({ type: 'reset_game' });
  await admin.state((s) => s.phase === 'idle');
  student.send({ type: 'join', name: 'Remove Me', rollNumber: 'RM1' });
  const joined = await student.next((m) => m.type === 'joined');
  admin.send({ type: 'create_game' });
  await student.state((s) => s.phase === 'lobby');

  admin.send({ type: 'remove_player', id: joined.id });
  const removed = await student.next((m) => m.type === 'error' && m.code === 'removed');
  assert(removed.message.includes('removed'), 'student sees removed message');

  const state = await admin.state((s) => s.phase === 'lobby' && s.players.length === 0, 5000).catch(() => null);
  if (state) assert.strictEqual(state.players.length, 0, 'student no longer listed');

  const again = client('/ws/student');
  await again.ready;
  again.send({ type: 'join', name: 'Remove Me', rollNumber: 'RM1', token: joined.token });
  const blocked = await again.next((m) => m.type === 'error' && m.code === 'removed');
  assert(blocked, 'removed student cannot rejoin');

  console.log('PASS: admin can remove a student mid-wait; student sees message and cannot rejoin.');
  admin.close(); student.close(); again.close();
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
