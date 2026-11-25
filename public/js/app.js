'use strict';

/* Participant app: join -> lobby -> question -> round results -> final podium. */

const STORAGE_KEY = 'quizArenaJoin';

let saved = null;
try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (_) { saved = null; }

let myId = saved?.id || null;
let myToken = saved?.token || null;
let state = null;
let selectedOption = null;
let lastQuestionKey = '';
let confettiDone = false;
let autoJoinAttempted = false;

const net = new Net(handleMessage, (status) => {
  const online = status === 'open';
  setNetStatus(online);
  $('#netLabel').textContent = online ? 'Live' : 'Offline';
  if (online) {
    // Returning players rejoin automatically using their saved details.
    if (saved?.name && !autoJoinAttempted) {
      autoJoinAttempted = true;
      doJoin(saved.name, saved.className, saved.email, myToken);
    }
  }
});

function doJoin(name, className, email, token) {
  net.send({ type: 'join', name, className, email, token: token || null });
}

function persistJoin() {
  saved = { ...(saved || {}), id: myId, token: myToken };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'joined':
      myId = msg.id;
      myToken = msg.token;
      persistJoin();
      break;

    case 'state':
      state = msg.state;
      render();
      break;

    case 'error':
      showToast(msg.message, 'error');
      break;

    case 'game_reset':
      // A new game started: rejoin with the saved token so the same player
      // is reused instead of creating a duplicate entry.
      state = null;
      lastQuestionKey = '';
      confettiDone = false;
      autoJoinAttempted = false;
      if (saved?.name) {
        doJoin(saved.name, saved.className, saved.email, myToken);
        showToast('A new game is starting — welcome back!', 'success');
      } else {
        showScreen('joinScreen');
      }
      break;
  }
}

function render() {
  if (!state) return;

  const inGame = state.phase !== 'idle' && !!state.me;
  $('#roundPill').hidden = !inGame || state.phase === 'lobby' || state.phase === 'gameEnd';
  $('#scorePill').hidden = !inGame;

  if (inGame) {
    $('#roundPill').textContent = state.phase === 'gameEnd'
      ? 'Game over'
      : `Round ${Math.max(1, state.round)} / ${state.totalRounds}`;
    animateNumber($('#topScore'), state.me.score);
  }

  if (state.phase === 'idle' || !myId) {
    showScreen('joinScreen');
    return;
  }

  switch (state.phase) {
    case 'lobby': renderLobby(); break;
    case 'question': renderQuestion(); break;
    case 'roundEnd': renderRoundEnd(); break;
    case 'gameEnd': renderGameEnd(); break;
  }
}

function renderLobby() {
  showScreen('lobbyScreen');
  const me = state.me;
  $('#lobbyAvatar').textContent = initial(me.name);
  $('#lobbyChipAvatar').textContent = initial(me.name);
  $('#lobbyWelcome').textContent = `Welcome, ${me.name} 👋`;
  $('#lobbyName').textContent = me.name;
  $('#lobbyClass').textContent = me.className || 'No class set';
  $('#lobbyCount').textContent = state.participantCount;
  $('#lobbyRounds').textContent = state.totalRounds;
}

function renderQuestion() {
  showScreen('questionScreen');
  const q = state.question;
  if (!q) return;

  const questionKey = `${state.round}|${q.text}`;
  if (questionKey !== lastQuestionKey) {
    lastQuestionKey = questionKey;
    selectedOption = null;
  }

  $('#qRound').textContent = `Round ${state.round} of ${state.totalRounds}`;
  $('#qText').textContent = q.text;

  const timerBar = $('#qTimerBar');
  timerBar.dataset.duration = String(state.duration);
  updateTimer(state.endsAt, timerBar, $('#qSeconds'), state.duration);

  const answered = state.myAnswer;
  const opts = $('#qOptions');
  opts.innerHTML = q.options.map((opt, i) => {
    const chosen = selectedOption === i || (answered && answered.option === i);
    return `<button class="option ${chosen ? 'selected' : ''}" data-index="${i}" ${answered ? 'disabled' : ''}>
      <span class="letter">${'ABCD'[i]}</span><span>${escapeHTML(opt)}</span>
      ${answered && answered.option === i ? '<span class="tick">✓</span>' : ''}
    </button>`;
  }).join('');

  $$('.option', opts).forEach((btn) => {
    btn.addEventListener('click', () => {
      if (state.myAnswer || state.phase !== 'question') return;
      selectedOption = Number(btn.dataset.index);
      $$('.option', opts).forEach((b) => b.classList.toggle('selected', b === btn));
      $('#submitAnswer').disabled = false;
    });
  });

  $('#submitAnswer').hidden = !!answered;
  $('#submitAnswer').disabled = selectedOption === null || !!answered;
  $('#lockedNote').hidden = !answered;

  $('#answeredLabel').textContent = `${state.answeredCount} / ${state.participantCount} answered`;
  $('#answeredBar').style.width = `${state.participantCount ? (state.answeredCount / state.participantCount) * 100 : 0}%`;
}

function renderRoundEnd() {
  showScreen('roundEndScreen');
  const me = state.me;
  const answer = state.myAnswer;
  const q = state.question;
  if (!q) return;

  const good = !!(answer && answer.correct);
  $('#reRound').textContent = `Round ${state.round} of ${state.totalRounds} complete`;
  $('#reBanner').className = `result-banner ${good ? 'good' : 'bad'}`;
  $('#reIcon').textContent = good ? '🎉' : (answer ? '💡' : '⏰');
  $('#reTitle').textContent = good ? 'Correct!' : (answer ? 'Not quite' : 'Time is up');
  $('#reSubtitle').textContent = good
    ? `You are on a ${me.streak}-answer streak!`
    : 'No points this round — go again!';
  $('#rePointsWrap').hidden = !good;
  if (good) $('#rePoints').textContent = `+${answer.points}`;

  $('#reQuestion').textContent = q.text;
  $('#reOptions').innerHTML = q.options.map((opt, i) => {
    const revealClass = i === q.correct ? 'correct-reveal' : (answer && answer.option === i ? 'wrong-reveal' : '');
    return `<div class="option ${revealClass}">
      <span class="letter">${'ABCD'[i]}</span><span>${escapeHTML(opt)}</span>
      ${i === q.correct ? '<span class="tick">✓</span>' : ''}
    </div>`;
  }).join('');

  $('#reStanding').textContent = `You are #${me.rank}`;
  $('#reLeaderboard').innerHTML = leaderboardHTML(state.leaderboard, myId, { compact: true, limit: 8 });
}

function renderGameEnd() {
  showScreen('gameEndScreen');
  const me = state.me;
  const board = state.leaderboard || [];
  const top = board[0];

  $('#winnerName').textContent = top ? `${top.name} wins!` : 'Game over';
  $('#winnerSub').textContent = top
    ? `👑 ${top.correct} correct answer${top.correct === 1 ? '' : 's'} — the most in the class!`
    : '';

  $('#finalPodium').innerHTML = podiumHTML(board);
  animateNumber($('#myFinalScore'), me.score);
  $('#myFinalRank').textContent = `#${me.rank}`;
  $('#myFinalCorrect').textContent = me.correct;
  $('#myFinalAccuracy').textContent = state.totalRounds
    ? `${Math.round((me.correct / state.totalRounds) * 100)}%`
    : '0%';
  $('#myFinalStreak').textContent = me.bestStreak;
  $('#finalLeaderboard').innerHTML = leaderboardHTML(board, myId);

  if (!confettiDone) {
    launchConfetti($('#confettiHost'));
    confettiDone = true;
  }
}

/* ---------------- One-time event wiring ---------------- */

$('#joinForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = $('#joinName').value.trim();
  const className = $('#joinClass').value.trim();
  const email = $('#joinEmail').value.trim();

  $('#joinName').classList.remove('invalid');
  $('#joinEmail').classList.remove('invalid');
  let valid = true;
  if (!name) { $('#joinName').classList.add('invalid'); valid = false; }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    $('#joinEmail').classList.add('invalid');
    valid = false;
  }
  if (!valid) return showToast('Please check the highlighted fields.');

  saved = { name, className, email, id: myId, token: myToken };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  autoJoinAttempted = true;
  doJoin(name, className, email, myToken);
});

$('#submitAnswer').addEventListener('click', () => {
  if (selectedOption === null || !state || state.phase !== 'question' || state.myAnswer) return;
  net.send({ type: 'answer', optionIndex: selectedOption });
});

$('#leaveBtn').addEventListener('click', () => {
  net.send({ type: 'leave' });
  localStorage.removeItem(STORAGE_KEY);
  net.stopped = true;
  location.reload();
});

setInterval(() => {
  if (state?.phase === 'question') {
    updateTimer(state.endsAt, $('#qTimerBar'), $('#qSeconds'), state.duration);
  }
}, 100);
