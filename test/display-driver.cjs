'use strict';
const WebSocket = require('ws');
const b = 'https://quiz-arena.quiz-arena-hitam.workers.dev';
(async () => {
  const l = await fetch(`${b}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'mohithedau1@gmail.com', password: process.env.ADMIN_PASSWORD }) });
  const c = l.headers.get('set-cookie').split(';')[0];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await fetch(`${b}/api/admin/clear-data`, { method: 'POST', headers: { Cookie: c } });
  const a = new WebSocket(b.replace('https', 'wss') + '/ws/admin', { headers: { Cookie: c } });
  await new Promise((r) => a.on('open', r));
  const send = (o) => a.send(JSON.stringify(o));
  send({ type: 'reset_game' }); await wait(300);
  const s = new WebSocket(b.replace('https', 'wss') + '/ws/student');
  await new Promise((r) => s.on('open', r));
  s.send(JSON.stringify({ type: 'join', name: 'Display UI', rollNumber: 'DU1' })); await wait(300);
  send({ type: 'create_game' }); await wait(300);
  send({ type: 'start_round' }); await wait(300);
  s.send(JSON.stringify({ type: 'answer', optionIndex: 1 })); await wait(300);
  send({ type: 'end_round' }); await wait(300);
  s.send(JSON.stringify({ type: 'away' }));
  await wait(20000);
  a.close(); s.close();
  process.exit(0);
})();
