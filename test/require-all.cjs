'use strict';
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
    state(predicate, ms = 4000) {
      return this.next((m) => m.type === 'state' && predicate(m.state), ms).then((m) => m.state);
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
  await fetch(`${HTTP}/api/admin/clear-data`, { method: 'POST', headers: { Cookie: cookie } });
  const cur = await (await fetch(`${HTTP}/api/admin/questions`, { headers: { Cookie: cookie } })).json();
  const q = cur.questions;
  q[7] = {
    type: 'paragraph',
    passage: 'Q8. Addition and condensation polymerization\na) Other name for addition polymerization?\nb) First stage of free radical addition polymerization?\nc) Stage in which the polymer chain grows?\nd) Stage in which chain growth stops?\ne) Other name for condensation polymerization in the notes?',
    method: 'written',
    text: 'Write the answers to all five parts (a–e) above.',
    keywords: ['Chain growth polymerization|chain growth', 'Initiation|first stage', 'Propagation|growth stage|chain grows', 'Termination|chain stops', 'Step growth polymerization|step growth'],
    requireAll: true,
  };
  q[8] = {
    type: 'paragraph',
    passage: 'Q9. Electrical conduction in polyacetylene\na) Double-bond arrangement responsible for electron delocalization?\nb) Doping that creates positive sites?\nc) Doping that creates negative sites?\nd) Process involving removal of electrons?\ne) Process involving addition of electrons?',
    method: 'written',
    text: 'Write the answers to all five parts (a–e) above.',
    keywords: ['Conjugation|conjugated double bonds', 'P-doping|p doping|positive doping', 'N-doping|n doping|negative doping', 'Oxidation|removal of electrons', 'Reduction|addition of electrons'],
    requireAll: true,
  };
  const saved = await fetch(`${HTTP}/api/admin/questions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ questions: q }),
  });
  assert(saved.ok, 'save failed: ' + await saved.text());

  const admin = client('/ws/admin', cookie);
  const student = client('/ws/student');
  await Promise.all([admin.ready, student.ready]);
  admin.send({ type: 'reset_game' });
  await admin.state((s) => s.phase === 'idle');
  student.send({ type: 'join', name: 'Rule Test', rollNumber: 'R1' });
  await student.next((m) => m.type === 'joined');
  admin.send({ type: 'create_game', rounds: 10, duration: 300 });
  await student.state((s) => s.phase === 'lobby');

  for (let round = 1; round <= 10; round++) {
    admin.send({ type: 'start_round' });
    await student.state((s) => s.phase === 'question' && s.round === round);
    if (round === 8) student.send({ type: 'answer', text: 'Initiation' }); // only 1 of 5
    else if (round === 9) student.send({ type: 'answer', text: 'conjugated double bonds, positive doping called P-doping, N-doping creates negative sites, removal of electrons is oxidation, addition of electrons is reduction' });
    else if (round === 10) {
      const savedQ = require('../questions.json')[9];
      student.send({ type: 'answer', answers: savedQ.subs.map((s) => s.correct) });
    }
    if (round >= 8) { await new Promise((resolve) => setTimeout(resolve, 150)); await student.state((s) => s.phase === 'question' && s.myAnswer); }
    admin.send({ type: 'end_round' });
    await student.state((s) => s.phase === 'roundEnd' && s.round === round);
    admin.send({ type: 'next_round' });
  }
  const final = await student.state((s) => s.phase === 'gameEnd');
  console.log('final correct:', final.leaderboard[0].correct, '/10 | score:', final.leaderboard[0].score);
  assert.strictEqual(final.leaderboard[0].correct, 2, 'only Q9 and Q10 count as correct');
  console.log('PASS: partial answer rejected, full answer with alternative wording accepted.');
  admin.close(); student.close();
  process.exit(0);
})().catch((err) => { console.error('FAIL:', err.message); process.exit(1); });
