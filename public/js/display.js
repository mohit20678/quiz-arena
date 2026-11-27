'use strict';

let displayState = null;

const net = new Net('/ws/display', (msg) => {
  if (msg.type === 'state') {
    displayState = msg.state;
    render();
  }
}, (status) => {
  $('#liveLabel').textContent = status === 'open' ? 'Live' : 'Offline';
});

function questionHTML(q) {
  if (!q) return '<div class="muted">The host will start the first question shortly.</div>';
  let html = `<div class="admin-question">${escapeHTML(q.text || (q.subs?.[0]?.text || 'Passage questions'))}</div>`;
  if (q.passage) html += `<div class="readonly-passage">${escapeHTML(q.passage)}</div>`;
  if (q.type === 'mcq') {
    html += `<div class="admin-options">${q.options.map((o, i) => `
      <div class="admin-opt"><span class="letter">${'ABCD'[i]}</span><span>${escapeHTML(o)}</span></div>`).join('')}</div>`;
  } else if (q.method === 'mcq' && q.subs) {
    html += q.subs.map((s, i) => `
      <div class="sub-question"><div class="sub-title">${i + 1}. ${escapeHTML(s.text)}</div>
        <div class="admin-options">${s.options.map((o, j) => `
          <div class="admin-opt"><span class="letter">${'ABCD'[j]}</span><span>${escapeHTML(o)}</span></div>`).join('')}</div>
      </div>`).join('');
  } else {
    html += '<div class="admin-opt"><span class="letter">✎</span><span>Written answer</span></div>';
  }
  return html;
}

function render() {
  const s = displayState;
  if (!s) return;
  const names = { lobby: 'Waiting room', question: 'Question in progress', roundEnd: 'Round complete', gameEnd: 'Final results', idle: 'Not started' };
  $('#displayRound').textContent = `${names[s.phase] || s.phase} · Question ${Math.max(1, s.round)} / ${s.totalRounds}`;
  $('#displayJoined').textContent = `${s.joined} joined`;
  $('#displayQuestion').innerHTML = questionHTML(s.question);

  const timerVisible = s.phase === 'question' && s.endsAt;
  $('#displayTimer').hidden = !timerVisible;
  if (timerVisible) {
    const bar = $('#displayBar');
    const remaining = Math.max(0, s.endsAt - Date.now());
    bar.style.width = `${s.duration ? Math.min(100, (remaining / (s.duration * 1000)) * 100) : 0}%`;
    $('#displaySeconds').textContent = Math.ceil(remaining / 1000);
  } else {
    $('#displayBar').style.width = '0%';
  }

  $('#displayBoard').innerHTML = s.leaderboard && s.leaderboard.length
    ? `<div style="max-height:420px;overflow:auto">${leaderboardHTML(s.leaderboard, null)}</div>`
    : '<div class="empty">Rankings appear after each question.</div>';

  $('#displayEvents').innerHTML = s.events && s.events.length ? s.events.map((e) => `
    <div class="readonly-q">
      <div class="q-text-line"><span class="q-num">${e.kind === 'good' ? '✅' : '⚠️'}</span><span>${escapeHTML(e.text)}</span></div>
      <div class="tiny muted">${new Date(e.at).toLocaleTimeString()}</div>
    </div>`).join('') : '<div class="empty">Nothing yet.</div>';
}

setInterval(() => {
  if (displayState?.phase === 'question' && displayState.endsAt) {
    const remaining = Math.max(0, displayState.endsAt - Date.now());
    $('#displayBar').style.width = `${displayState.duration ? Math.min(100, (remaining / (displayState.duration * 1000)) * 100) : 0}%`;
    $('#displaySeconds').textContent = Math.ceil(remaining / 1000);
  }
}, 100);
