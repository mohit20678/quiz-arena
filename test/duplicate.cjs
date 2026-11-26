'use strict';
const WebSocket = require('ws');
const assert = require('assert');
const PORT = Number(process.env.PORT) || 8787;
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
  const first = client('/ws/student');
  const second = client('/ws/student');
  await Promise.all([first.ready, second.ready]);

  first.send({ type: 'join', name: 'Same Roll', rollNumber: 'DUP1' });
  const joined = await first.next((m) => m.type === 'joined');
  assert(joined.token, 'first device joins');

  // Different device / different token, same roll number.
  second.send({ type: 'join', name: 'Same Roll', rollNumber: 'DUP1' });
  const error = await second.next((m) => m.type === 'error' && m.code === 'duplicate');
  assert(error.message.includes('already joined'), 'same roll rejected on second device');

  console.log('PASS: one roll number cannot join from two different devices.');
  first.close(); second.close();
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
