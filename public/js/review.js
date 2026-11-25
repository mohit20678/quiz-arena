'use strict';

let reviewData = null;

function answerText(answer, question) {
  if (!answer) return '—';
  if (answer.answers && question?.type === 'paragraph' && question.method === 'mcq') {
    return answer.answers.map((a, i) => `${'ABCD'[a]}. ${question.subs[i]?.options[a] || ''}`).join(' | ');
  }
  if (answer.option !== undefined) {
    const opt = question?.options?.[answer.option];
    return `${'ABCD'[answer.option]}${opt ? `. ${opt}` : ''}`;
  }
  return String(answer.text || '');
}

function render() {
  if (!reviewData) return;
  const { history, feedback, players } = reviewData;
  $('#summary').textContent = `${players.length} students · ${history.length} answered rounds · ${feedback.length} feedback responses`;
  $('#feedbackCount').textContent = `${feedback.length} response${feedback.length === 1 ? '' : 's'}`;

  const filter = $('#questionFilter');
  const current = filter.value;
  filter.innerHTML = `<option value="all">All questions (${history.length})</option>` +
    history.map((h) => `<option value="${h.round}">Q${h.round}. ${escapeHTML((h.question?.text || '').slice(0, 70))}</option>`).join('');
  filter.value = current || 'all';

  const selected = filter.value === 'all' ? history : history.filter((h) => String(h.round) === filter.value);
  const rows = [];
  for (const round of selected) {
    for (const item of round.answers) {
      rows.push({
        round: round.round,
        question: round.question?.text || '',
        name: item.name,
        roll: item.rollNumber,
        team: item.team,
        answer: answerText(item.answer, round.question),
        correct: item.answer?.correct ? 'Yes' : 'No',
        points: item.answer?.points ?? 0,
      });
    }
  }

  $('#answersTable').innerHTML = rows.length ? `
    <div style="max-height:520px;overflow:auto">
      <table class="data-table">
        <thead><tr><th>Q</th><th>Student</th><th>Roll</th><th>Team</th><th>Answer</th><th>Correct</th><th>Points</th></tr></thead>
        <tbody>${rows.map((r) => `
          <tr>
            <td>${r.round}</td>
            <td><strong>${escapeHTML(r.name)}</strong></td>
            <td>${escapeHTML(r.roll)}</td>
            <td>${escapeHTML(r.team || '—')}</td>
            <td>${escapeHTML(r.answer)}</td>
            <td style="color:${r.correct === 'Yes' ? 'var(--green)' : 'var(--red)'}">${r.correct}</td>
            <td>${r.points}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>` : '<div class="empty">No answers recorded yet. Finish a round first.</div>';

  $('#feedbackList').innerHTML = feedback.length ? feedback.map((f) => `
    <div class="readonly-q">
      <div class="q-text-line"><span class="q-num">★ ${f.rating}/5</span><strong>${escapeHTML(f.name)}</strong> <small class="muted">${escapeHTML(f.rollNumber)}</small></div>
      <div class="tiny" style="margin-top:6px">${escapeHTML(f.comment || 'No comment')}</div>
    </div>`).join('') : '<div class="empty">No feedback yet.</div>';
}

function downloadAnswers() {
  const rows = [['Round', 'Question', 'Student', 'Roll number', 'Team', 'Answer', 'Correct', 'Points']];
  for (const round of reviewData.history) {
    for (const item of round.answers) {
      rows.push([
        round.round, round.question?.text || '', item.name, item.rollNumber, item.team || '',
        answerText(item.answer, round.question), item.answer?.correct ? 'Yes' : 'No', item.answer?.points ?? 0,
      ]);
    }
  }
  downloadCSV('quiz-arena-answers.csv', rows);
}

function downloadFeedback() {
  const rows = [['Student', 'Roll number', 'Team', 'Rating', 'Comment', 'Time']];
  for (const f of reviewData.feedback) {
    rows.push([f.name, f.rollNumber, f.team || '', f.rating, f.comment || '', new Date(f.at).toLocaleString()]);
  }
  downloadCSV('quiz-arena-feedback.csv', rows);
}

async function load() {
  const response = await fetch('/api/admin/answers', { cache: 'no-store' });
  if (response.status === 401) {
    showScreen('loginScreen');
    return;
  }
  if (!response.ok) return showToast('Could not load answers.');
  reviewData = await response.json();
  showScreen('panelScreen');
  render();
}

async function login(email, password) {
  const button = $('#loginButton');
  button.disabled = true;
  button.textContent = 'Signing in…';
  try {
    const response = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not sign in.');
    await load();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Sign in →';
  }
}

$('#loginForm').addEventListener('submit', (event) => {
  event.preventDefault();
  login($('#adminEmail').value.trim(), $('#adminPassword').value);
});

$('#refreshBtn').addEventListener('click', load);
$('#questionFilter').addEventListener('change', render);
$('#exportCsv').addEventListener('click', downloadAnswers);
$('#exportFeedback').addEventListener('click', downloadFeedback);

(async () => {
  const session = await (await fetch('/api/admin/session', { cache: 'no-store' })).json();
  if (session.authorized) await load();
  else showScreen('loginScreen');
})();
