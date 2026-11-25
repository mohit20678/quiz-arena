'use strict';

/* End-to-end test: secure login, 10-question pattern, keyword grading, 80-device-ready updates. */

const WebSocket = require('ws');
const assert = require('assert');
const questions = require('../questions.json');

const PORT = process.env.PORT || 3000;
const HTTP_URL = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}`;
const EMAIL = process.env.ADMIN_EMAIL || 'mohithedau1@gmail.com';
const PASSWORD = process.env.ADMIN_PASSWORD || '';

function client(name, path, cookie) {
  const options = cookie ? { headers: { Cookie: cookie } } : {};
  const ws = new WebSocket(`${WS_URL}${path}`, options);
  const inbox = [];
  const waiters = [];

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (process.env.DEBUG) console.log('MSG', name, msg.type, msg.state?.phase ?? '');
    inbox.push(msg);
    const idx = waiters.findIndex((w) => w.match(msg));
    if (idx !== -1) waiters.splice(idx, 1)[0].resolve(msg);
  });

  const ready = new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  return {
    ws,
    ready,
    send: (obj) => ws.send(JSON.stringify(obj)),
    next(match, ms = 3000) {
      const existing = inbox.findIndex(match);
      if (existing !== -1) return Promise.resolve(inbox.splice(existing, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${name}: timed out waiting for message`)), ms);
        waiters.push({ match, resolve: (m) => { clearTimeout(timer); resolve(m); } });
      });
    },
    stateWhich(predicate, ms = 3000) {
      return this.next((m) => m.type === 'state' && predicate(m.state), ms).then((m) => m.state);
    },
    close: () => ws.close(),
    drain: () => { inbox.length = 0; },
  };
}

function expectedAnswer(question) {
  if (question.type === 'paragraph' && question.method === 'mcq') {
    return { answers: question.subs.map((s) => s.correct) };
  }
  if (question.type === 'mcq') return { optionIndex: question.correct };
  const keywords = question.keywords || [];
  const text = question.requireAll
    ? keywords.map((k) => String(k).split('|')[0]).join(', ')
    : (keywords[0] || 'a sufficiently long answer');
  return { text };
}

function wrongAnswer(question) {
  if (question.type === 'paragraph' && question.method === 'mcq') {
    return { answers: question.subs.map((s) => (s.correct + 1) % 4) };
  }
  return question.type === 'mcq'
    ? { optionIndex: (question.correct + 1) % 4 }
    : { text: 'a completely unrelated guess' };
}

(async () => {
  if (!PASSWORD) {
    console.error('Set ADMIN_PASSWORD in your environment before running the test.');
    console.error('PowerShell: $env:ADMIN_PASSWORD="your-password"; npm test');
    process.exit(1);
  }

  assert.strictEqual(questions.length, 10, 'question set must have 10 questions');
  assert(questions.every((q) => ['mcq', 'short', 'essay', 'paragraph'].includes(q.type)),
    'all questions must have a supported type');

  const rogue = new WebSocket(`${WS_URL}/ws/admin`);
  const rejection = await new Promise((resolve) => {
    rogue.on('unexpected-response', (_req, res) => resolve(res.statusCode));
    rogue.on('error', () => resolve('error'));
  });
  assert.strictEqual(rejection, 401, 'admin WebSocket must reject unauthenticated clients');

  const response = await fetch(`${HTTP_URL}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const login = await response.json();
  assert(response.ok && login.ok, 'admin login should succeed');
  const cookie = response.headers.get('set-cookie').split(';')[0];
  await fetch(`${HTTP_URL}/api/admin/questions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ questions: require('../questions.json') }),
  });

  const admin = client('admin', '/ws/admin', cookie);
  const a = client('Aarav', '/ws/student');
  const b = client('Neha', '/ws/student');
  await Promise.all([admin.ready, a.ready, b.ready]);

  admin.send({ type: 'reset_game' });
  await admin.stateWhich((s) => s.phase === 'idle');

  a.send({ type: 'join', name: 'Aarav', rollNumber: '21CS04', team: '10-B' });
  b.send({ type: 'join', name: 'Neha', rollNumber: '21CS05', team: '' });
  const joinedA = await a.next((m) => m.type === 'joined');
  await b.next((m) => m.type === 'joined');

  admin.send({ type: 'create_game', rounds: 10, duration: 30,
    questions: [{ type: 'mcq', text: 'injected', options: ['a', 'b', 'c', 'd'], correct: 0 }] });
  const lobby = await a.stateWhich((s) => s.phase === 'lobby');
  assert.strictEqual(lobby.totalRounds, 10, 'all saved questions are played');
  assert(lobby.playerCount >= 2, 'both students joined');
  assert.strictEqual(lobby.me.rollNumber, '21CS04');

  admin.send({ type: 'start_round' });
  let firstQuestion;

  for (let round = 1; round <= 10; round++) {
    const qState = await a.stateWhich((s) => s.phase === 'question' && s.round === round);
    const source = questions[round - 1];
    assert.strictEqual(qState.question.type, source.type, `question ${round} keeps its type`);
    assert.strictEqual(qState.question.correct, undefined, 'correct answer hidden from students');
    if (round === 1) firstQuestion = qState.question;

    const right = expectedAnswer(source);
    const wrong = wrongAnswer(source);

    a.send({ type: 'answer', ...right });
    b.send({ type: 'answer', ...wrong });
    // Wait until both answers are stored before asking the admin to end the round.
    await a.stateWhich((s) => s.phase === 'question' && s.myAnswer);
    await b.stateWhich((s) => s.phase === 'question' && s.myAnswer);
    admin.send({ type: 'end_round' });

    const result = await a.stateWhich((s) => s.phase === 'roundEnd' && s.round === round && s.myAnswer);
    assert(result.leaderboard && result.leaderboard.length >= 2, `ranking shown after question ${round}`);
    assert.strictEqual(result.leaderboard[0].score !== undefined, true, 'ranking shows points');
    assert.strictEqual(result.leaderboard[0].correct, undefined, 'ranking hides correct counts');
    assert.strictEqual(result.question.correct, undefined, `no answer reveal after question ${round}`);
    assert.strictEqual(result.me.score !== undefined, true, 'student sees own points after round');
    assert.strictEqual(result.me.correct, undefined, 'correct count still hidden until the end');
    assert.strictEqual(result.myAnswer.points, undefined, 'no per-answer correctness sent');

    a.drain(); b.drain(); admin.drain();
    if (round < 10) admin.send({ type: 'next_round' });
  }

  admin.send({ type: 'next_round' });
  const finalA = await a.stateWhich((s) => s.phase === 'gameEnd');
  const finalB = await b.stateWhich((s) => s.phase === 'gameEnd');
  assert.strictEqual(finalA.leaderboard[0].name, 'Aarav', 'all-correct student wins');
  assert.strictEqual(finalA.leaderboard[0].correct, 10, '10/10 shown for all correct');
  assert.strictEqual(finalA.leaderboard[0].total, 10, 'score is correct / total');
  assert.strictEqual(finalB.leaderboard.find((r) => r.name === 'Neha').correct, 0);

  a.close(); // simulate leaving the site, not opening a second tab
  const a2 = client('Aarav reconnect', '/ws/student');
  await a2.ready;
  a2.send({ type: 'join', name: 'Aarav', rollNumber: '21CS04', team: '10-B', token: joinedA.token });
  const rejoin = await a2.next((m) => m.type === 'joined');
  assert.strictEqual(rejoin.token, joinedA.token, 'reconnect reuses the same identity');
  const afterReconnect = await a2.stateWhich((s) => s.phase === 'gameEnd');
  assert.strictEqual(afterReconnect.me.score, finalA.me.score, 'score survives reconnect');

  admin.close(); a.close(); b.close(); a2.close();
  console.log('PASS: 10-question pattern, keyword grading, hidden results, and reconnect all work.');
  console.log(`First question type: ${firstQuestion.type}`);
  process.exit(0);
})().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
