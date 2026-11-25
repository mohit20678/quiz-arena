'use strict';

/* Tests the admin question editor API and paragraph-with-MCQs flow.
   Restores the original questions.json when finished. */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const WebSocket = require('ws');

const FILE = path.join(__dirname, '..', 'questions.json');
const PORT = Number(process.env.PORT) || 4001;
const HTTP = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}`;
const EMAIL = process.env.ADMIN_EMAIL || 'mohithedau1@gmail.com';
const PASSWORD = process.env.ADMIN_PASSWORD || '';

function client(pathname, cookie) {
  const ws = new WebSocket(`${WS}${pathname}`, cookie ? { headers: { Cookie: cookie } } : {});
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
  const originalText = fs.readFileSync(FILE, 'utf8');
  let cookie;

  try {
    const unauth = await fetch(`${HTTP}/api/admin/questions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questions: [] }),
    });
    assert.strictEqual(unauth.status, 401, 'unauthenticated save must be rejected');

    const login = await fetch(`${HTTP}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    assert(login.ok, 'login failed');
    cookie = login.headers.get('set-cookie').split(';')[0];

    const fetched = await (await fetch(`${HTTP}/api/admin/questions`, { headers: { Cookie: cookie } })).json();
    const questions = fetched.questions;
    assert.strictEqual(questions.length, 10);

    // Turn question 10 into a paragraph with two MCQs, answered in one round.
    questions[9] = {
      type: 'paragraph',
      passage: 'Water hardness is caused by calcium and magnesium salts.',
      method: 'mcq',
      subs: [
        { text: 'Which salts cause hardness?', options: ['Sodium', 'Calcium', 'Iron', 'Zinc'], correct: 1 },
        { text: 'How many MCQs are in this passage?', options: ['One', 'Two', 'Three', 'Four'], correct: 1 },
      ],
    };

    const saved = await fetch(`${HTTP}/api/admin/questions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ questions }),
    });
    const savedData = await saved.json();
    assert(saved.ok, `save failed: ${JSON.stringify(savedData)}`);
    assert.strictEqual(savedData.count, 10);

    const admin = client('/ws/admin', cookie);
    const student = client('/ws/student');
    await Promise.all([admin.ready, student.ready]);

    admin.send({ type: 'reset_game' });
    await admin.state((s) => s.phase === 'idle');
    student.send({ type: 'join', name: 'Editor Test', rollNumber: 'E01' });
    await student.next((m) => m.type === 'joined');

    admin.send({ type: 'create_game', rounds: 10, duration: 300 });
    await student.state((s) => s.phase === 'lobby');

    // End the first nine questions from the admin side.
    for (let i = 1; i <= 9; i++) {
      admin.send({ type: 'start_round' });
      await student.state((s) => s.phase === 'question' && s.round === i);
      admin.send({ type: 'end_round' });
      await student.state((s) => s.phase === 'roundEnd' && s.round === i);
      admin.send({ type: 'next_round' });
    }

    const q10 = await student.state((s) => s.phase === 'question' && s.round === 10);
    assert.strictEqual(q10.question.type, 'paragraph');
    assert.strictEqual(q10.question.method, 'mcq');
    assert.strictEqual(q10.question.subs.length, 2, 'both paragraph MCQs are in one round');
    assert.strictEqual(q10.question.subs[0].correct, undefined, 'correct options hidden from students');

    student.send({ type: 'answer', answers: [1, 1] });
    await student.state((s) => s.phase === 'question' && s.myAnswer);
    admin.send({ type: 'end_round' });
    const ended = await student.state((s) => s.phase === 'roundEnd' && s.round === 10);
    assert(ended.leaderboard.length >= 1, 'ranking shown after the paragraph round');

    admin.send({ type: 'next_round' });
    const final = await student.state((s) => s.phase === 'gameEnd');
    assert.strictEqual(final.leaderboard[0].correct, 1, 'paragraph round counts as one correct question');

    admin.close(); student.close();
    console.log('PASS: admin editor saves questions; paragraph MCQs play together in one round.');
  } finally {
    fs.writeFileSync(FILE, originalText, 'utf8');
    // Reload the saved file into whichever server is running on PORT.
    if (cookie) {
      await fetch(`${HTTP}/api/admin/questions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ questions: JSON.parse(originalText) }),
      });
    }
  }
})().catch((err) => { console.error('FAIL:', err.message); process.exit(1); });
