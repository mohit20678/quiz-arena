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
  const student = client('/ws/student');
  await Promise.all([admin.ready, student.ready]);

  admin.send({ type: 'reset_game' });
  await admin.state((s) => s.phase === 'idle');
  student.send({ type: 'join', name: 'Back Test', rollNumber: 'BK1' });
  const joined = await student.next((m) => m.type === 'joined');

  // Simulate pressing Back / leaving the tab.
  student.send({ type: 'away' });
  await student.next((m) => m.type === 'error' && m.code === 'away');
  await admin.state((s) => s.pending.length >= 1);

  // Browser reconnects after being kicked, then asks to come back.
  const backToPage = client(`/ws/student?token=${encodeURIComponent(joined.token)}`);
  await backToPage.ready;
  backToPage.send({ type: 'request_rejoin', name: 'Back Test', rollNumber: 'BK1', token: joined.token });
  await backToPage.next((m) => m.type === 'rejoin_requested');

  // Admin denies first.
  admin.send({ type: 'deny_all' });
  await backToPage.next((m) => m.type === 'error' && m.code === 'denied');
  const blocked = client(`/ws/student?token=${encodeURIComponent(joined.token)}`);
  await blocked.ready;
  blocked.send({ type: 'join', name: 'Back Test', rollNumber: 'BK1', token: joined.token });
  await blocked.next((m) => m.type === 'error' && m.code === 'denied');

  // Student asks again, admin approves, now rejoin works.
  blocked.send({ type: 'request_rejoin', name: 'Back Test', rollNumber: 'BK1', token: joined.token });
  await blocked.next((m) => m.type === 'rejoin_requested');
  admin.send({ type: 'approve_all' });
  await blocked.next((m) => m.type === 'approved');
  blocked.send({ type: 'join', name: 'Back Test', rollNumber: 'BK1', token: joined.token });
  const back = await blocked.next((m) => m.type === 'joined');
  assert.strictEqual(back.token, joined.token, 'approved student rejoins with same details');

  console.log('PASS: back -> rejoin request -> admin deny/approve -> rejoin works.');
  admin.close(); student.close(); blocked.close();
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
