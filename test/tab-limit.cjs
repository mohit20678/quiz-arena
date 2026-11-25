'use strict';
/* Checks rejoin chances, second-tab logout, permanent block, and admin single tab. */

const WebSocket = require('ws');
const assert = require('assert');
const PORT = Number(process.env.PORT) || 4001;
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
    close: () => ws.close(),
  };
}

(async () => {
  if (!PASSWORD) { console.error('Set ADMIN_PASSWORD first.'); process.exit(1); }
  const login = await fetch(`${HTTP}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'mohithedau1@gmail.com', password: PASSWORD }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const admin = client('/ws/admin', cookie);
  const admin2 = client('/ws/admin', cookie);
  await Promise.all([admin.ready, admin2.ready]);
  const adminSecond = await admin2.next((m) => m.type === 'error' && m.code === 'second_tab');
  assert(adminSecond.message.includes('second tab'), 'admin second tab is signed out');

  const main = client('/ws/student');
  await main.ready;
  main.send({ type: 'join', name: 'Chance Test', rollNumber: 'C1' });
  const joined = await main.next((m) => m.type === 'joined');

  // First tab repeat while the original is still open -> signed out, chance used.
  const second = client(`/ws/student?token=${encodeURIComponent(joined.token)}`);
  await second.ready;
  second.send({ type: 'join', name: 'Chance Test', rollNumber: 'C1', token: joined.token });
  const warning = await second.next((m) => m.type === 'error' && m.code === 'second_tab');
  assert(warning.message.includes('second tab'), 'student sees friendly second-tab message');

  // Accidental leave + first rejoin still works.
  main.close();
  const rejoin = client(`/ws/student?token=${encodeURIComponent(joined.token)}`);
  await rejoin.ready;
  rejoin.send({ type: 'join', name: 'Chance Test', rollNumber: 'C1', token: joined.token });
  const rejoined = await rejoin.next((m) => m.type === 'joined');
  assert.strictEqual(rejoined.token, joined.token, 'one more rejoin is allowed');

  // Doing it again blocks permanently.
  rejoin.close();
  const third = client(`/ws/student?token=${encodeURIComponent(joined.token)}`);
  await third.ready;
  third.send({ type: 'join', name: 'Chance Test', rollNumber: 'C1', token: joined.token });
  const blocked = await third.next((m) => m.type === 'error' && m.code === 'blocked');
  assert(blocked.message.length > 10, 'permanent block message shown');

  console.log('PASS: admin single tab, 2 chances, second-tab logout, permanent block.');
  admin.close(); admin2.close(); second.close(); rejoin.close(); third.close();
  process.exit(0);
})().catch((err) => { console.error('FAIL:', err.message); process.exit(1); });
