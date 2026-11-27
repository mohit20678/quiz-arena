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
  await admin.ready;
  admin.send({ type: 'reset_game' });
  await admin.state((s) => s.phase === 'idle');

  const tokens = [];
  for (let i = 1; i <= 5; i++) {
    const s = client('/ws/student');
    await s.ready;
    s.send({ type: 'join', name: `Crowd ${i}`, rollNumber: `CW${i}` });
    const j = await s.next((m) => m.type === 'joined');
    tokens.push(j.token);
    s.send({ type: 'away' });
    await s.next((m) => m.type === 'error' && ['away', 'blocked'].includes(m.code));
    await new Promise((r) => setTimeout(r, 150));
    s.close();
  }

  const state = await admin.state((s) => s.pending.length === 0, 6000);
  assert(state, 'pending queue emptied by auto-allow');
  const info = await (await fetch(`${HTTP}/api/admin/answers`, { headers: { Cookie: cookie } })).json();
  assert(info.events.some((e) => e.text.includes('auto-allowed')), 'auto-allow event recorded');

  for (let i = 0; i < tokens.length; i++) {
    const again = client(`/ws/student?token=${encodeURIComponent(tokens[i])}`);
    await again.ready;
    again.send({ type: 'join', name: `Crowd ${i + 1}`, rollNumber: `CW${i + 1}`, token: tokens[i] });
    const j = await again.next((m) => m.type === 'joined', 6000);
    assert.strictEqual(j.token, tokens[i], `student ${i + 1} rejoined automatically`);
    again.close();
  }

  console.log('PASS: 5+ kicked students are auto-allowed and all rejoin successfully.');
  admin.close();
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
