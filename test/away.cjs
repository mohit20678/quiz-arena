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
  await admin.ready;
  admin.send({ type: 'reset_game' });

  const s1 = client('/ws/student');
  await s1.ready;
  s1.send({ type: 'join', name: 'Away Test', rollNumber: 'AW1' });
  const joined = await s1.next((m) => m.type === 'joined');

  // First tab switch: signed out, but one chance remains.
  s1.send({ type: 'away' });
  const away = await s1.next((m) => m.type === 'error' && m.code === 'away');
  assert(away.message.includes('switched away'), 'friendly away message');

  const s2 = client('/ws/student');
  await s2.ready;
  s2.send({ type: 'join', name: 'Away Test', rollNumber: 'AW1', token: joined.token });
  const rejoined = await s2.next((m) => m.type === 'joined');
  assert.strictEqual(rejoined.token, joined.token, 'rejoin still allowed once');

  // Second tab switch: permanently blocked.
  s2.send({ type: 'away' });
  const blocked = await s2.next((m) => m.type === 'error' && m.code === 'blocked');
  assert(blocked, 'second away blocks permanently');

  const s3 = client('/ws/student');
  await s3.ready;
  s3.send({ type: 'join', name: 'Away Test', rollNumber: 'AW1', token: joined.token });
  const finalBlock = await s3.next((m) => m.type === 'error' && m.code === 'blocked');
  assert(finalBlock, 'blocked student cannot rejoin');

  console.log('PASS: tab switch signs out; first = 1 chance left, second = permanent block.');
  admin.close(); s1.close(); s2.close(); s3.close();
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
