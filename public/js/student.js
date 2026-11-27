'use strict';

/* Student app: individual sign-in, mixed question types, live waiting screen. */

const STORAGE_KEY = 'quizArenaStudent';

let saved = null;
try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (_) { saved = null; }

let myId = saved?.id || null;
let myToken = saved?.token || null;
let state = null;
let selectedOption = null;
let selectedSubs = [];
let lastQuestionKey = '';
let confettiDone = false;
let autoJoinAttempted = false;
let lockedScreen = false;
let awaitingApproval = false;
let reviewDone = false;
let reviewRatings = { website: 0, games: 0, questions: 0 };
let reviewIssue = '';

const socketPath = myToken
  ? `/ws/student?token=${encodeURIComponent(myToken)}`
  : '/ws/student';

const net = new Net(socketPath, handleMessage, (status) => {
  const online = status === 'open';
  setNetStatus(online);
  $('#netLabel').textContent = online ? 'Live' : 'Offline';
  if (online && saved?.name && saved?.rollNumber && !awaitingApproval) doJoin();
});

function persist() {
  saved = { ...(saved || {}), id: myId, token: myToken };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
}

function doJoin() {
  if (!saved?.name || !saved?.rollNumber) return;
  net.send({
    type: 'join',
    name: saved.name,
    rollNumber: saved.rollNumber,
    team: saved.team || '',
    token: myToken || null,
  });
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'joined':
      myId = msg.id;
      myToken = msg.token;
      persist();
      break;

    case 'state':
      if (lockedScreen) break;
      state = msg.state;
      render();
      break;

    case 'feedback_saved':
      showToast('Thank you for your review!', 'success');
      showScreen('gameEndScreen');
      break;

    case 'approved':
      awaitingApproval = false;
      lockedScreen = false;
      showToast('The admin allowed you back. Rejoining…', 'success');
      location.reload();
      break;

    case 'rejoin_requested':
      $('#rejoinTitle').textContent = 'Request sent';
      $('#rejoinMessage').textContent = 'Waiting for the admin to allow you back. This page will continue automatically.';
      break;

    case 'error':
      if (['away', 'removed', 'second_tab', 'blocked', 'denied'].includes(msg.code)) {
        awaitingApproval = true;
        lockedScreen = true;
        net.stopped = true;
        net.close(); // stop auto-reconnect loops that flood the room
        showRejoin(msg.message);
        pollRejoin();
      } else if (msg.code === 'duplicate') {
        net.stopped = true;
        showScreen('joinScreen');
        showToast(msg.message, 'error');
      } else {
        showToast(msg.message, 'error');
      }
      break;

    case 'game_reset':
      state = null;
      lastQuestionKey = '';
      confettiDone = false;
      reviewDone = false;
      autoJoinAttempted = false;
      if (saved?.name) {
        doJoin(); // same token reuses the same player
        showToast('A new quiz is starting — welcome back!', 'success');
      } else {
        showScreen('joinScreen');
      }
      break;
  }
}

/* ------------------------------------------------------------------ */
/* Screens                                                             */
/* ------------------------------------------------------------------ */

function render() {
  if (!state || lockedScreen) return;
  const inGame = state.phase !== 'idle' && !!state.me;
  const hiddenResults = state.phase === 'question';

  $('#roundPill').hidden = !inGame || state.phase === 'lobby' || state.phase === 'gameEnd';
  $('#scorePill').hidden = !inGame || hiddenResults;
  if (inGame) {
    $('#roundPill').textContent = state.phase === 'gameEnd'
      ? 'Game over' : `Q ${Math.max(1, state.round)} / ${state.totalRounds}`;
    if (state.me.score !== undefined && !hiddenResults) animateNumber($('#topScore'), state.me.score);
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
  $('#lobbyWelcome').textContent = `${me.name} 👋`;
  $('#lobbyCount').textContent = state.playerCount;
  $('#lobbyRounds').textContent = state.totalRounds;
  $('#lobbyRoll').textContent = me.rollNumber;
  $('#lobbyMembers').innerHTML = `
    <span class="member-chip">
      <span class="avatar sm">${escapeHTML(initial(me.name))}</span>
      <span>${escapeHTML(me.name)} <small>Roll ${escapeHTML(me.rollNumber)}</small></span>
    </span>
    ${me.team ? `<span class="member-chip">🏷 ${escapeHTML(me.team)}</span>` : ''}`;
}

function renderQuestion() {
  showScreen('questionScreen');
  const q = state.question;
  if (!q) return;

  const questionKey = `${state.round}|${q.text}`;
  if (questionKey !== lastQuestionKey) {
    lastQuestionKey = questionKey;
    selectedOption = null;
    selectedSubs = [];
    $('#qAnswerText').value = '';
  }

  $('#qRound').textContent = `Question ${state.round} of ${state.totalRounds}`;
  const typeLabel = { mcq: 'Multiple choice', short: 'Short answer', essay: 'Essay answer', paragraph: 'Passage based' }[q.type] || 'Question';
  $('#qType').textContent = typeLabel;
  $('#qType').classList.add('type-badge');
  $('#qText').textContent = q.text;

  const timerBar = $('#qTimerBar');
  timerBar.dataset.duration = String(state.duration);
  updateTimer(state.endsAt, timerBar, $('#qSeconds'), state.duration);

  const isMcq = q.type === 'mcq';
  const isParagraphMcq = q.type === 'paragraph' && q.method === 'mcq';
  $('#qOptions').hidden = !isMcq;
  $('#qWrittenWrap').hidden = isMcq || isParagraphMcq;
  $('#qSubsWrap').hidden = !isParagraphMcq;

  const answered = state.myAnswer;

  if (isMcq) {
    $('#qOptions').innerHTML = q.options.map((opt, i) => {
      const chosen = selectedOption === i || (answered && answered.option === i);
      return `<button class="option ${chosen ? 'selected' : ''}" data-index="${i}" ${answered ? 'disabled' : ''}>
        <span class="letter">${'ABCD'[i]}</span><span>${escapeHTML(opt)}</span>
        ${answered && answered.option === i ? '<span class="tick">✓</span>' : ''}
      </button>`;
    }).join('');
    $$('.option', $('#qOptions')).forEach((btn) => {
      btn.addEventListener('click', () => {
        if (state.myAnswer || state.phase !== 'question') return;
        selectedOption = Number(btn.dataset.index);
        $$('.option', $('#qOptions')).forEach((b) => b.classList.toggle('selected', b === btn));
        $('#submitAnswer').disabled = false;
      });
    });
  } else if (isParagraphMcq) {
    $('#qSubsPassage').textContent = q.passage || '';
    const chosenAnswers = answered?.answers || [];
    $('#qSubs').innerHTML = (q.subs || []).map((sub, si) => `
      <div class="sub-question">
        <div class="sub-title">${si + 1}. ${escapeHTML(sub.text)}</div>
        <div class="options">${sub.options.map((opt, oi) => {
          const chosen = selectedSubs[si] === oi || chosenAnswers[si] === oi;
          return `<button class="option ${chosen ? 'selected' : ''}" data-sub="${si}" data-index="${oi}" ${answered ? 'disabled' : ''}>
            <span class="letter">${'ABCD'[oi]}</span><span>${escapeHTML(opt)}</span>
          </button>`;
        }).join('')}</div>
      </div>`).join('');
    $$('.option', $('#qSubs')).forEach((btn) => {
      btn.addEventListener('click', () => {
        if (state.myAnswer || state.phase !== 'question') return;
        const si = Number(btn.dataset.sub);
        selectedSubs[si] = Number(btn.dataset.index);
        $$('.option[data-sub="' + si + '"]', $('#qSubs')).forEach((b) => {
          b.classList.toggle('selected', b === btn);
        });
        refreshSubmit();
      });
    });
  } else {
    const passage = $('#qPassage');
    passage.textContent = q.passage || '';
    const box = $('#qAnswerText');
    box.disabled = !!state.myAnswer;
    if (state.myAnswer?.text) box.value = state.myAnswer.text;
    box.oninput = () => {
      $('#qCharCount').textContent = `${box.value.length} characters`;
      refreshSubmit();
    };
    $('#qCharCount').textContent = `${box.value.length} characters`;
  }

  function refreshSubmit() {
    if (isMcq) $('#submitAnswer').disabled = selectedOption === null || !!state.myAnswer;
    else if (isParagraphMcq) $('#submitAnswer').disabled =
      selectedSubs.length < (q.subs || []).length || selectedSubs.some((v) => v === undefined);
    else $('#submitAnswer').disabled = boxValue().trim().length < 3 || !!state.myAnswer;
  }

  $('#submitAnswer').hidden = !!answered;
  refreshSubmit();
  $('#lockedNote').hidden = !answered;
}

function boxValue() {
  return $('#qAnswerText')?.value || '';
}

function renderRoundEnd() {
  showScreen('roundEndScreen');
  const last = state.round >= state.totalRounds;
  $('#reRound').textContent = `Question ${state.round} of ${state.totalRounds} complete`;
  $('#reTitle').textContent = last ? 'All questions answered' : 'Answer submitted';
  $('#reMessage').innerHTML = last
    ? 'Please wait for the final results<span class="wait-dots"><i></i><i></i><i></i></span>'
    : 'Please wait for the next question to begin<span class="wait-dots"><i></i><i></i><i></i></span>';
  $('#reStanding').textContent = state.me.rank ? `You are #${state.me.rank}` : '';
  $('#reLeaderboard').innerHTML = leaderboardHTML(state.leaderboard, myId, { compact: true, limit: 10 });
}

function renderGameEnd() {
  showScreen('gameEndScreen');
  const me = state.me;
  const board = state.leaderboard || [];
  const top = board[0];

  $('#winnerName').textContent = top ? `${top.name} wins!` : 'Game over';
  $('#winnerSub').textContent = top
    ? `👑 ${top.correct}/${top.total} correct — the most in the class!`
    : '';

  $('#finalPodium').innerHTML = podiumHTML(board, state.totalRounds);
  $('#myFinalScoreFrac').textContent = `${me.correct}/${state.totalRounds}`;
  $('#myFinalRank').textContent = `#${me.rank}`;
  $('#myFinalPoints').textContent = `${me.score} pts`;
  $('#myFinalAccuracy').textContent = state.totalRounds
    ? `${Math.round((me.correct / state.totalRounds) * 100)}%` : '0%';
  $('#myFinalStreak').textContent = me.bestStreak;
  $('#myFinalRoll').textContent = me.rollNumber;
  $('#finalLeaderboard').innerHTML = leaderboardHTML(board, myId, { total: state.totalRounds });

  if (!confettiDone) {
    launchConfetti($('#confettiHost'));
    confettiDone = true;
  }
  if (!reviewDone) {
    reviewDone = true;
    showScreen('studentReviewScreen');
  }
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

$('#joinForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = $('#studentName').value.trim();
  const rollNumber = $('#studentRoll').value.trim();
  const team = $('#studentTeam').value.trim();

  ['#studentName', '#studentRoll'].forEach((sel) => $(sel).classList.remove('invalid'));
  let valid = true;
  if (!name) { $('#studentName').classList.add('invalid'); valid = false; }
  if (!rollNumber) { $('#studentRoll').classList.add('invalid'); valid = false; }
  if (!valid) return showToast('Please enter your name and roll number.');

  saved = { name, rollNumber, team, id: myId, token: myToken };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  autoJoinAttempted = true;
  doJoin();
});

$('#submitAnswer').addEventListener('click', () => {
  if (!state || state.phase !== 'question' || state.myAnswer) return;
  const q = state.question;
  if (!q) return;
  if (q.type === 'mcq') {
    if (selectedOption === null) return;
    net.send({ type: 'answer', optionIndex: selectedOption });
  } else if (q.type === 'paragraph' && q.method === 'mcq') {
    if (selectedSubs.length < (q.subs || []).length || selectedSubs.some((v) => v === undefined)) {
      return showToast('Please answer every question in the passage.');
    }
    net.send({ type: 'answer', answers: selectedSubs });
  } else {
    const text = boxValue().trim();
    if (text.length < 3) return showToast('Please write your answer first.');
    net.send({ type: 'answer', text });
  }
});

watchSecondTabs('quiz-arena-student-tabs', () => {
  if (lockedScreen) return;
  lockedScreen = true;
  if (net) net.stopped = true;
  showScreen('secondTabScreen');
});

$$('.review-rating').forEach((group) => {
  const key = group.dataset.key;
  $$('button', group).forEach((btn) => btn.addEventListener('click', () => {
    reviewRatings[key] = Number(btn.dataset.rate);
    $$('button', group).forEach((b) => b.classList.toggle('selected', b === btn));
  }));
});

$$('.choice-btn').forEach((btn) => btn.addEventListener('click', () => {
  reviewIssue = btn.dataset.issue;
  $$('.choice-btn').forEach((b) => b.classList.toggle('selected', b === btn));
}));

$('#submitReview').addEventListener('click', () => {
  if (!reviewRatings.website || !reviewRatings.games || !reviewRatings.questions) {
    return showToast('Please rate the website, games and questions.');
  }
  if (!reviewIssue) return showToast('Please tell us whether you had a technical issue.');
  net.send({
    type: 'feedback',
    website: reviewRatings.website,
    games: reviewRatings.games,
    questions: reviewRatings.questions,
    issue: reviewIssue,
    issueDetails: $('#reviewIssueDetails').value,
    improve: $('#reviewImprove').value,
  });
});

$('#backToResults').addEventListener('click', () => showScreen('gameEndScreen'));

function showRejoin(message) {
  $('#rejoinTitle').textContent = 'Request to rejoin';
  $('#rejoinMessage').textContent = message || 'Your details are saved. Send a request and wait for the admin.';
  $('#rejoinDetails').innerHTML = saved?.name
    ? `<span class="member-chip">${escapeHTML(saved.name)} · Roll ${escapeHTML(saved.rollNumber || '')}</span>`
    : '<span class="tiny muted">No saved details</span>';
  showScreen('rejoinScreen');
}

let rejoinPoll = null;

async function pollRejoin() {
  if (rejoinPoll) return;
  rejoinPoll = setInterval(async () => {
    if (!awaitingApproval || !myToken) return;
    try {
      const r = await fetch(`/api/rejoin-status?token=${encodeURIComponent(myToken)}`);
      const data = await r.json();
      if (data.status === 'approved') {
        clearInterval(rejoinPoll);
        rejoinPoll = null;
        showToast('The admin allowed you back. Rejoining…', 'success');
        location.reload();
      } else if (data.status === 'blocked') {
        clearInterval(rejoinPoll);
        rejoinPoll = null;
        $('#rejoinTitle').textContent = 'Request denied';
        $('#rejoinMessage').textContent = 'The admin did not allow re-entry. Please ask your teacher.';
      }
    } catch (_) { /* keep polling */ }
  }, 2000);
}

$('#requestRejoin').addEventListener('click', async () => {
  try {
    const r = await fetch('/api/rejoin-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: saved?.name || '', rollNumber: saved?.rollNumber || '', token: myToken || '' }),
    });
    const data = await r.json();
    if (!r.ok) return showToast(data.error || 'Could not send the request.', 'error');
    $('#rejoinTitle').textContent = 'Request sent';
    $('#rejoinMessage').textContent = 'Waiting for the admin to allow you back. This page will update automatically.';
    pollRejoin();
  } catch (_) { showToast('Could not reach the server. Please try again.'); }
});

let awayReported = false;

function reportAway() {
  if (awayReported || lockedScreen || !state || state.phase === 'gameEnd') return;
  const active = [...document.querySelectorAll('.screen')].find((s) => s.classList.contains('active'))?.id;
  if (['awayScreen', 'removedScreen', 'blockedScreen', 'secondTabScreen', 'feedbackScreen', 'rejoinScreen'].includes(active)) return;
  awayReported = true;
  net.send({ type: 'away' });
}

document.addEventListener('visibilitychange', () => { if (document.hidden) reportAway(); });
window.addEventListener('blur', reportAway);

$('#rejoinHome').addEventListener('click', () => { location.href = '/'; });
$('#awayBack').addEventListener('click', () => { location.href = '/'; });
$('#removedBack').addEventListener('click', () => { location.href = '/'; });
$('#secondTabBack').addEventListener('click', () => { location.href = '/'; });
$('#blockedBack').addEventListener('click', () => { location.href = '/'; });

let feedbackRating = 0;

function finishLeaving() {
  net.send({ type: 'leave' });
  localStorage.removeItem(STORAGE_KEY);
  net.close();
  location.href = '/';
}

$('#leaveBtn').addEventListener('click', () => {
  $('#feedbackText').value = '';
  feedbackRating = 0;
  $$('.rating-btn').forEach((b) => b.classList.remove('selected'));
  $('#ratingHint').textContent = '1 = poor · 5 = excellent';
  showScreen('feedbackScreen');
});

$$('.rating-btn').forEach((btn) => btn.addEventListener('click', () => {
  feedbackRating = Number(btn.dataset.rate);
  $$('.rating-btn').forEach((b) => b.classList.toggle('selected', b === btn));
  $('#ratingHint').textContent = `You chose ${feedbackRating} / 5`;
}));

$('#submitFeedback').addEventListener('click', () => {
  if (!feedbackRating) return showToast('Please choose a rating first.');
  net.send({ type: 'feedback', rating: feedbackRating, comment: $('#feedbackText').value });
  finishLeaving();
});

$('#skipFeedback').addEventListener('click', finishLeaving);

setInterval(() => {
  if (state?.phase === 'question') {
    updateTimer(state.endsAt, $('#qTimerBar'), $('#qSeconds'), state.duration);
  }
}, 100);

// Prefill from a previous visit.
if (saved?.name) {
  $('#studentName').value = saved.name;
  $('#studentRoll').value = saved.rollNumber || '';
  $('#studentTeam').value = saved.team || '';
}
