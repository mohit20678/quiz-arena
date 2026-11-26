'use strict';

/* Admin app: password gate, question editor, and live game control. */

let net = null;
let currentState = null;
let questionDraft = [];
let editingIndex = -1;
let dirty = false;
let secondTabLocked = false;

/* ------------------------------------------------------------------ */
/* Sign in / sign out                                                  */
/* ------------------------------------------------------------------ */

async function checkSession() {
  try {
    const response = await fetch('/api/admin/session', { cache: 'no-store' });
    const data = await response.json();
    if (data.authorized) enterPanel();
    else showScreen('loginScreen');
  } catch (_) {
    showScreen('loginScreen');
  }
}

async function login(email, password) {
  const button = $('#loginButton');
  button.disabled = true;
  button.textContent = 'Signing in…';
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not sign in.');
    enterPanel();
    showToast('Signed in successfully.', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Sign in →';
  }
}

async function logout() {
  try { await fetch('/api/logout', { method: 'POST' }); } catch (_) { /* ignore */ }
  if (net) { net.close(); net = null; }
  currentState = null;
  $('#liveArea').hidden = true;
  showScreen('loginScreen');
}

function enterPanel() {
  if (secondTabLocked) return;
  showScreen('panelScreen');
  loadQuestions();
  if (!net) net = new Net('/ws/admin', handleMessage, (status) => {
    const online = status === 'open';
    setNetStatus(online);
    $('#netLabel').textContent = online ? 'Live' : 'Offline';
  });
}

function handleMessage(msg) {
  if (msg.type === 'state') renderLive(msg.state);
  else if (msg.type === 'error') {
    if (msg.code === 'second_tab') {
      if (net) net.close();
      showScreen('loginScreen');
    }
    showToast(msg.message, 'error');
  }
  else if (msg.type === 'game_reset') {
    currentState = null;
    $('#liveArea').hidden = true;
    showScreen('panelScreen');
  }
}

/* ------------------------------------------------------------------ */
/* Question editor                                                     */
/* ------------------------------------------------------------------ */

function normalizeOptions(options) {
  const list = Array.isArray(options) ? options.slice(0, 4) : [];
  while (list.length < 4) list.push('');
  return list.map((o) => String(o ?? ''));
}

function blankQuestion(type = 'mcq') {
  if (type === 'mcq') return { type, seconds: 30, text: '', options: ['', '', '', ''], correct: 0 };
  if (type === 'paragraph') return { type, seconds: 30, passage: '', method: 'written', text: '', keywords: [], requireAll: false };
  return { type, seconds: 30, text: '', keywords: [], requireAll: false };
}

function blankSub() {
  return { text: '', options: ['', '', '', ''], correct: 0 };
}

function convertQuestion(q, newType) {
  const text = q.text || q.subs?.[0]?.text || '';
  const seconds = Number(q.seconds) || 30;
  if (newType === 'mcq') {
    return { type: 'mcq', seconds, text, options: normalizeOptions(q.options || q.subs?.[0]?.options), correct: Number(q.correct ?? q.subs?.[0]?.correct ?? 0) };
  }
  if (newType === 'paragraph') {
    return { type: 'paragraph', seconds, passage: q.passage || '', method: 'written', text, keywords: q.keywords || [], requireAll: Boolean(q.requireAll) };
  }
  return { type: newType, seconds, text, keywords: q.keywords || [], requireAll: Boolean(q.requireAll) };
}

async function loadQuestions() {
  try {
    const response = await fetch('/api/admin/questions', { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json();
    questionDraft = (data.questions || []).map((q) => ({
      ...q,
      options: q.options ? normalizeOptions(q.options) : undefined,
    }));
    editingIndex = -1;
    renderQuestions();
    syncRoundLimit();
  } catch (_) {
    showToast('Could not load the question set.');
  }
}

function markDirty() {
  if (dirty) return;
  dirty = true;
  syncRoundLimit();
}

function syncRoundLimit() {
  const count = questionDraft.length;
  $('#questionCount').textContent = `${count} question${count === 1 ? '' : 's'}${dirty ? ' · unsaved' : ''}`;
}

function optionsEditorHTML(q, prefix, index) {
  return q.options.map((opt, j) => `
    <div class="opt-row">
      <label class="radio-wrap ${q.correct === j ? 'checked' : ''}">
        <input type="radio" name="${prefix}-correct-${index}" data-sub="${index}" data-option="${j}" ${q.correct === j ? 'checked' : ''}>
      </label>
      <span class="radio-label">${'ABCD'[j]}</span>
      <input class="input ${prefix}-opt" data-sub="${index}" data-option="${j}" maxlength="200" value="${escapeHTML(opt)}" placeholder="Option ${'ABCD'[j]}">
    </div>`).join('');
}

function subEditorHTML(sub, si) {
  return `<div class="q-card sub-card" data-sub="${si}">
    <div class="q-card-head">
      <span class="q-num">MCQ ${si + 1}</span>
      <button class="btn btn-danger btn-sm" data-act="remove-sub" data-sub="${si}">Remove</button>
    </div>
    <div class="field"><label>Question</label><textarea class="input sub-text" data-sub="${si}" rows="2" placeholder="Question about the passage">${escapeHTML(sub.text)}</textarea></div>
    ${optionsEditorHTML(sub, 'sub', si)}
  </div>`;
}

function editorHTML(q, i) {
  const typeLabel = { mcq: 'Multiple choice', short: 'Short answer', essay: 'Essay answer', paragraph: 'Paragraph based' }[q.type] || q.type;
  const isParagraph = q.type === 'paragraph';
  const paragraphMcq = isParagraph && q.method === 'mcq';
  return `
    <div class="q-card editor-card" data-index="${i}">
      <div class="q-card-head">
        <span class="q-num">EDITING QUESTION ${i + 1} · ${escapeHTML(typeLabel)}</span>
        <button class="btn btn-ghost btn-sm" data-act="close-editor">Done</button>
      </div>
      <div class="field">
        <label>Question type</label>
        <select class="input q-type">
          ${['mcq', 'short', 'essay', 'paragraph'].map((t) => `<option value="${t}" ${q.type === t ? 'selected' : ''}>${typeLabelFor(t)}</option>`).join('')}
        </select>
      </div>
      ${q.type === 'mcq'
        ? `<div class="field">
            <label>Time for this question <span class="hint">· seconds, 5–300 (default 20)</span></label>
            <input class="input q-seconds" type="number" min="5" max="300" step="1" value="${Number(q.seconds) || 20}">
          </div>`
        : `<div class="field">
            <label>Time for this question <span class="hint">· minutes, 1–30 (default 2)</span></label>
            <input class="input q-seconds" type="number" min="1" max="30" step="1" value="${Math.round((Number(q.seconds) || 120) / 60)}">
          </div>`}
      ${isParagraph ? `
        <div class="field"><label>Passage</label><textarea class="input q-passage" rows="4" placeholder="Paste the passage here">${escapeHTML(q.passage || '')}</textarea></div>
        <div class="field">
          <label>Questioning method</label>
          <select class="input q-method">
            <option value="written" ${q.method !== 'mcq' ? 'selected' : ''}>Written answer (checked with keywords)</option>
            <option value="mcq" ${q.method === 'mcq' ? 'selected' : ''}>MCQs on the passage</option>
          </select>
        </div>` : ''}
      ${paragraphMcq ? `
        <p class="tiny muted">All of these MCQs are shown together in one round. Students answer every one before submitting.</p>
        ${(q.subs || []).map((sub, si) => subEditorHTML(sub, si)).join('')}
        <button class="btn btn-ghost btn-sm" data-act="add-sub">+ Add MCQ to passage</button>`
        : `
        <div class="field">
          <label>${isParagraph ? 'Question about the passage' : 'Question'}</label>
          <textarea class="input q-text" rows="3" placeholder="Type your question">${escapeHTML(q.text || '')}</textarea>
        </div>
        ${q.type === 'mcq' ? optionsEditorHTML(q, 'mcq', i) : `
          <div class="field">
            <label>Accepted keywords <span class="hint">· one answer per line; use | for alternative wordings, e.g. Propagation|growth stage</span></label>
            <textarea class="input q-keywords" rows="4" placeholder="Chain growth polymerization&#10;Initiation&#10;Propagation|growth stage">${escapeHTML((q.keywords || []).join('\n'))}</textarea>
          </div>
          <label class="check-row">
            <input type="checkbox" class="q-require-all" ${q.requireAll ? 'checked' : ''}>
            Require all keywords (student must include every answer)
          </label>`}`}
    </div>`;
}

function typeLabelFor(type) {
  return { mcq: 'Multiple choice (MCQ)', short: 'Short answer', essay: 'Essay answer', paragraph: 'Paragraph based' }[type] || type;
}

function renderQuestions() {
  const host = $('#questionList');
  host.innerHTML = questionDraft.map((q, i) => {
    if (i === editingIndex) return editorHTML(q, i);
    const typeLabel = { mcq: 'MCQ', short: 'Short', essay: 'Essay', paragraph: 'Paragraph' }[q.type] || q.type;
    const detail = `${Number(q.seconds) || 30}s · ` + (q.type === 'mcq'
      ? `${q.options[0]} · ${q.options[1]} · ${q.options[2]} · ${q.options[3]} (correct: ${'ABCD'[q.correct]})`
      : q.type === 'paragraph' && q.method === 'mcq'
        ? `${(q.subs || []).length} MCQ${(q.subs || []).length === 1 ? '' : 's'} on the passage`
        : `${(q.keywords || []).join(' · ')}${q.requireAll ? ' · ALL REQUIRED' : ''}`);
    return `<div class="q-card">
      <div class="q-card-head">
        <span class="q-num">Q${i + 1} · ${escapeHTML(typeLabel)}</span>
        <span>
          <button class="btn btn-ghost btn-sm" data-act="edit" data-index="${i}">✏ Edit</button>
          ${questionDraft.length > 1 ? `<button class="btn btn-danger btn-sm" data-act="delete" data-index="${i}">Delete</button>` : ''}
        </span>
      </div>
      <div class="q-text-line">${escapeHTML(q.text || (q.subs?.[0]?.text || 'Paragraph question'))}</div>
      ${q.passage ? `<div class="readonly-passage">${escapeHTML(q.passage)}</div>` : ''}
      <div class="tiny muted" style="margin-top:6px">${escapeHTML(detail || 'No options or keywords set yet')}</div>
    </div>`;
  }).join('');
  if (editingIndex >= 0) wireEditor(editingIndex);

  $$('[data-act="edit"]', host).forEach((btn) => btn.addEventListener('click', () => {
    editingIndex = Number(btn.dataset.index);
    renderQuestions();
  }));
  $$('[data-act="delete"]', host).forEach((btn) => btn.addEventListener('click', () => {
    questionDraft.splice(Number(btn.dataset.index), 1);
    if (editingIndex >= questionDraft.length) editingIndex = -1;
    markDirty();
    renderQuestions();
  }));
}

function wireEditor(i) {
  const card = $('.editor-card', $('#questionList'));
  if (!card) return;
  const q = questionDraft[i];
  card.addEventListener('input', markDirty);
  card.addEventListener('change', markDirty);

  $('.q-type', card).addEventListener('change', (e) => {
    questionDraft[i] = convertQuestion(q, e.target.value);
    renderQuestions();
  });

  const text = $('.q-text', card);
  if (text) text.addEventListener('input', () => { q.text = text.value; });
  const passage = $('.q-passage', card);
  if (passage) passage.addEventListener('input', () => { q.passage = passage.value; });
  const keywords = $('.q-keywords', card);
  if (keywords) keywords.addEventListener('input', () => {
    q.keywords = keywords.value.split(/[\n,]+/).map((k) => k.trim()).filter(Boolean);
  });
  const requireAll = $('.q-require-all', card);
  if (requireAll) requireAll.addEventListener('change', () => { q.requireAll = requireAll.checked; });
  const seconds = $('.q-seconds', card);
  if (seconds) seconds.addEventListener('input', () => {
    if (q.type === 'mcq') q.seconds = Math.min(300, Math.max(5, Number(seconds.value) || 20));
    else q.seconds = Math.min(30, Math.max(1, Number(seconds.value) || 2)) * 60;
  });

  const method = $('.q-method', card);
  if (method) method.addEventListener('change', (e) => {
    if (e.target.value === 'mcq') {
      questionDraft[i] = { type: 'paragraph', seconds: Number(q.seconds) || 30, passage: q.passage || '', method: 'mcq', subs: [blankSub()] };
    } else {
      questionDraft[i] = { type: 'paragraph', seconds: Number(q.seconds) || 30, passage: q.passage || '', method: 'written', text: q.text || '', keywords: q.keywords || [], requireAll: Boolean(q.requireAll) };
    }
    renderQuestions();
  });

  $$('.mcq-opt', card).forEach((input) => input.addEventListener('input', () => {
    q.options[Number(input.dataset.option)] = input.value;
  }));
  $$(`input[name="mcq-correct-${i}"]`, card).forEach((radio) => radio.addEventListener('change', () => {
    q.correct = Number(radio.dataset.option);
    $$(`input[name="mcq-correct-${i}"]`, card).forEach((r) => {
      r.closest('.radio-wrap').classList.toggle('checked', r === radio);
    });
  }));

  $$('.sub-text', card).forEach((input) => input.addEventListener('input', () => {
    q.subs[Number(input.dataset.sub)].text = input.value;
  }));
  $$('.sub-opt', card).forEach((input) => input.addEventListener('input', () => {
    q.subs[Number(input.dataset.sub)].options[Number(input.dataset.option)] = input.value;
  }));
  $$('input[name^="sub-correct-"]', card).forEach((radio) => radio.addEventListener('change', () => {
    q.subs[Number(radio.dataset.sub)].correct = Number(radio.dataset.option);
    $$(`input[name="sub-correct-${radio.dataset.sub}"]`, card).forEach((r) => {
      r.closest('.radio-wrap').classList.toggle('checked', r === radio);
    });
  }));

  $$('[data-act="add-sub"]', card).forEach((btn) => btn.addEventListener('click', () => {
    q.subs.push(blankSub());
    renderQuestions();
  }));
  $$('[data-act="remove-sub"]', card).forEach((btn) => btn.addEventListener('click', () => {
    q.subs.splice(Number(btn.dataset.sub), 1);
    renderQuestions();
  }));
  $$('[data-act="close-editor"]', card).forEach((btn) => btn.addEventListener('click', async () => {
    // Leaving the editor saves automatically, so entered questions are never lost.
    editingIndex = -1;
    renderQuestions();
    const ok = await saveQuestions();
    if (!ok) {
      editingIndex = i;
      renderQuestions();
    }
  }));
}

async function saveQuestions() {
  const button = $('#saveQuestions');
  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    const response = await fetch('/api/admin/questions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questions: questionDraft }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not save questions.');
    dirty = false;
    await loadQuestions();
    showToast(`Saved ${data.count} questions.`, 'success');
    return true;
  } catch (err) {
    showToast(err.message, 'error');
    return false;
  } finally {
    button.disabled = false;
    button.textContent = 'Save questions';
  }
}

/* ------------------------------------------------------------------ */
/* Live views                                                          */
/* ------------------------------------------------------------------ */

function renderPending(pending) {
  const panel = $('#pendingPanel');
  if (!panel) return;
  if (!pending.length) { panel.hidden = true; panel.innerHTML = ''; return; }
  panel.hidden = false;
  panel.innerHTML = `
    <div class="pending-head">
      <span class="pending-icon">⚠️</span>
      <div><strong>${pending.length} student${pending.length === 1 ? '' : 's'} kicked out</strong>
      <div class="tiny muted">Allow them back into the quiz?</div></div>
    </div>
    ${pending.map((p) => `
      <div class="pending-row">
        <span class="p-meta"><strong>${escapeHTML(p.name)}</strong><small>Roll ${escapeHTML(p.rollNumber)} · ${escapeHTML(p.reason)}</small></span>
        <button class="btn btn-sm btn-primary approve-one" data-id="${p.id}">Allow</button>
      </div>`).join('')}
    <button class="btn btn-sm btn-block btn-cyan" id="approveAll">Allow all (${pending.length})</button>`;
  $$('.approve-one', panel).forEach((btn) => btn.addEventListener('click', () => {
    net.send({ type: 'approve_player', id: btn.dataset.id });
  }));
  $('#approveAll', panel).addEventListener('click', () => net.send({ type: 'approve_all' }));
}

function renderLive(state) {
  currentState = state;
  if (state.phase === 'idle') {
    $('#liveArea').hidden = true;
    showScreen('panelScreen');
    return;
  }
  $('#liveArea').hidden = false;

  const titles = { lobby: 'Waiting room', question: 'Question in progress', roundEnd: 'Round complete', gameEnd: 'Final results' };
  const joined = $('#joinedCount');
  if (joined) joined.textContent = `${state.players.length} students joined · ${state.onlineCount} online`;
  $('#statusStrip').innerHTML = `
    <span class="status-chip"><span class="phase-badge phase-${state.phase}">${state.phase === 'roundEnd' ? 'round end' : state.phase === 'gameEnd' ? 'game over' : state.phase}</span></span>
    <span class="status-chip">Question <b>${Math.max(1, state.round)} / ${state.totalRounds}</b></span>
    <span class="status-chip">Students <b>${state.onlineCount}</b></span>
    ${state.phase === 'question' ? `<span class="status-chip">Answered <b>${state.answeredCount} / ${state.onlineCount}</b></span>` : ''}
  `;

  renderPending(state.pending || []);

  switch (state.phase) {
    case 'lobby': renderLobbyPanel(state); break;
    case 'question': renderQuestionPanel(state); break;
    case 'roundEnd': renderRoundEndPanel(state); break;
    case 'gameEnd': renderGameEndPanel(state); break;
  }
}

function wireRemoveButtons() {
  $$('.remove-student', $('#phaseBody')).forEach((btn) => btn.addEventListener('click', () => {
    if (confirm('Remove this student from the quiz? They will be signed out immediately.')) {
      net.send({ type: 'remove_player', id: btn.dataset.id });
    }
  }));
}

function renderLobbyPanel(state) {
  const players = state.players;
  $('#phaseBody').innerHTML = `
    <div class="admin-split">
      <div class="card">
        <div class="lb-head"><h3>Students in the room</h3><span class="pill">${state.onlineCount} online · ${players.length} joined</span></div>
        ${players.length ? `<div class="participant-grid">${players.map((t) => `
          <div class="pchip">
            <span class="avatar sm">${escapeHTML(initial(t.name))}</span>
            <span class="p-meta"><strong>${escapeHTML(t.name)}</strong><small>Roll ${escapeHTML(t.rollNumber)}${t.team ? ` · ${escapeHTML(t.team)}` : ''}</small></span>
            <span class="dot ${t.connected ? 'on' : ''}" title="${t.connected ? 'Online' : 'Offline'}"></span>
            <button class="btn btn-danger btn-sm remove-student" data-id="${t.id}" title="Remove this student">Remove</button>
          </div>`).join('')}</div>`
          : '<div class="empty">No students yet — share the student link and wait for them to join.</div>'}
        <div style="margin-top:22px">
          <button class="btn btn-primary btn-lg btn-block" id="adminStartRound">Start question 1 →</button>
        </div>
      </div>
      <div class="card">
        <h3>How a round works</h3>
        <p>Each round shows one question. As soon as every student answers, the round ends and all students see the ranking. The host can also end a round early or let the timer run out.</p>
        <p class="tiny">Student link: <code>${location.origin}/student</code></p>
      </div>
    </div>`;
  $('#adminStartRound').addEventListener('click', () => net.send({ type: 'start_round' }));
  wireRemoveButtons();
}

/* Projected screen: show the question only, never the correct answer. */
function plainOptionsHTML(question) {
  if (question.type === 'paragraph' && question.method === 'mcq') {
    return (question.subs || []).map((sub, i) => `
      <div class="sub-question">
        <div class="sub-title">${i + 1}. ${escapeHTML(sub.text)}</div>
        <div class="admin-options">${sub.options.map((opt, j) => `
          <div class="admin-opt"><span class="letter">${'ABCD'[j]}</span><span>${escapeHTML(opt)}</span></div>`).join('')}</div>
      </div>`).join('');
  }
  if (question.type !== 'mcq') {
    return `<div class="admin-opt"><span class="letter">✎</span><span>Written answer</span></div>`;
  }
  return question.options.map((opt, i) => `
    <div class="admin-opt"><span class="letter">${'ABCD'[i]}</span><span>${escapeHTML(opt)}</span></div>`).join('');
}

function passageHTML(question) {
  return question.passage ? `<div class="readonly-passage" style="margin:10px 0 14px">${escapeHTML(question.passage)}</div>` : '';
}

function optionsHTML(question) {
  if (question.type !== 'mcq') {
    return `<div class="admin-opt right">
        <span class="letter">✎</span><span>${question.type === 'paragraph' && question.method === 'mcq'
          ? `${(question.subs || []).length} MCQs on the passage — answered together`
          : 'Written answer — auto-checked with keywords'}</span>
        <span class="tag">${escapeHTML(question.type || 'written')}</span>
      </div>
      ${question.keywords && question.keywords.length
        ? `<p class="tiny muted" style="margin-top:10px">Accepted keywords: ${question.keywords.map((k) => escapeHTML(k)).join(' · ')}</p>` : ''}`;
  }
  return question.options.map((option, i) => `
    <div class="admin-opt ${i === question.correct ? 'right' : ''}">
      <span class="letter">${'ABCD'[i]}</span><span>${escapeHTML(option)}</span>
      ${i === question.correct ? '<span class="tag">CORRECT</span>' : ''}
    </div>`).join('');
}

function renderQuestionPanel(state) {
  const q = state.question;
  if (!q) return;
  $('#phaseBody').innerHTML = `
    <div class="admin-split">
      <div class="card">
        <div class="q-head">
          <span class="eyebrow">Question ${state.round} of ${state.totalRounds}</span>
          <span class="timer-pill">⏱ <span id="adminSeconds">0</span>s</span>
        </div>
        <div class="timer-track"><div class="timer-bar" id="adminTimerBar" data-duration="${state.duration}"></div></div>
        <div class="admin-question">${escapeHTML(q.text || (q.subs?.[0]?.text || 'Passage questions'))}</div>
        ${passageHTML(q)}
        <div class="admin-options">${plainOptionsHTML(q)}</div>
        <p class="tiny muted">The round ends automatically when everyone answers or when the timer expires. The ranking shows for 5 seconds, then the next question starts by itself.</p>
        <div class="admin-actions"><button class="btn btn-ghost" id="adminEndRound">End round now</button></div>
      </div>
      <div class="card">
        <div class="lb-head"><h3>Answer progress</h3><span class="pill" id="adminAnsweredPill">0 / 0</span></div>
        <div class="timer-track" style="margin-bottom:16px"><div class="timer-bar" id="adminAnsweredBar" style="width:0%"></div></div>
        <div class="participant-grid">${state.players.map((t) => `
          <div class="pchip">
            <span class="dot ${t.answered ? 'answered' : (t.connected ? 'on' : '')}"></span>
            <span class="p-meta">
              <strong>${escapeHTML(t.name)}</strong>
              <small class="status-line">${t.answered ? 'Answered' : (t.connected ? 'Thinking' : 'Offline')}</small>
            </span>
            <button class="btn btn-danger btn-sm remove-student" data-id="${t.id}" title="Remove this student">Remove</button>
          </div>`).join('')}</div>
      </div>
    </div>`;
  $('#adminEndRound').addEventListener('click', () => net.send({ type: 'end_round' }));
  wireRemoveButtons();
  updateAdminTimer();
}

function renderRoundEndPanel(state) {
  const q = state.question;
  if (!q) return;
  // Projected view: question only — no correct answer, keywords or leaderboard.
  $('#phaseBody').innerHTML = `
    <div class="card projected-card">
      <div class="eyebrow">Question ${state.round} complete</div>
      <div class="admin-question">${escapeHTML(q.text || (q.subs?.[0]?.text || 'Passage questions'))}</div>
      ${passageHTML(q)}
      <div class="admin-options">${plainOptionsHTML(q)}</div>
      <div class="admin-actions" style="justify-content:center;margin-top:28px">
        ${state.canUndo ? '<button class="btn btn-danger btn-sm" id="adminUndoRound">↩ Undo this round</button>' : ''}
        <button class="btn btn-primary" id="adminNextRound">${state.round >= state.totalRounds ? 'Show final results →' : 'Next question →'}</button>
      </div>
    </div>`;
  $('#adminNextRound').addEventListener('click', () => net.send({ type: 'next_round' }));
  $('#adminUndoRound')?.addEventListener('click', () => net.send({ type: 'undo_round' }));
}

function exportResults(board, total) {
  const rows = [
    ['Rank', 'Name', 'Roll number', 'Class / team', 'Score', 'Correct', 'Total', 'Best streak'],
    ...board.map((t) => [t.rank, t.name, t.rollNumber, t.team || '', t.score, t.correct, total, t.bestStreak]),
  ];
  downloadCSV('quiz-arena-results.csv', rows);
}

function renderGameEndPanel(state) {
  const board = state.leaderboard;
  const top = board[0];
  const knower = [...board].sort((a, b) => b.correct - a.correct)[0];
  $('#phaseBody').innerHTML = `
    <div class="winner-banner">
      <span class="crown">👑</span>
      <h2>${escapeHTML(top?.name || 'Nobody')} wins!</h2>
      <p class="muted">${top ? `${top.score} points · ${top.correct}/${top.total} correct` : 'No students joined.'}</p>
    </div>
    <div class="admin-split">
      <div class="card">
        <div class="lb-head">
          <h3>Final leaderboard</h3>
          ${knower ? `<span class="tiny muted">🧠 Most correct: ${escapeHTML(knower.name)} (${knower.correct}/${knower.total})</span>` : ''}
        </div>
        ${leaderboardHTML(board, null, { total: state.totalRounds })}
        <div class="admin-actions" style="justify-content:flex-start">
          <button class="btn btn-sm" id="exportCsv">⬇ Download results (CSV)</button>
        </div>
      </div>
      <div class="card">
        <div class="podium">${podiumHTML(board, state.totalRounds)}</div>
        <div class="admin-actions" style="justify-content:center">
          <button class="btn btn-primary" id="adminNewGame">Host a new game</button>
        </div>
      </div>
    </div>`;
  $('#exportCsv').addEventListener('click', () => exportResults(board, state.totalRounds));
  $('#adminNewGame').addEventListener('click', () => {
    if (confirm('Reset the game and return to setup?')) net.send({ type: 'reset_game' });
  });
}

function updateAdminTimer() {
  if (!currentState || currentState.phase !== 'question') return;
  const bar = $('#adminTimerBar');
  if (!bar) return;
  updateTimer(currentState.endsAt, bar, $('#adminSeconds'), currentState.duration);
  const pill = $('#adminAnsweredPill');
  if (pill) pill.textContent = `${currentState.answeredCount} / ${currentState.onlineCount}`;
  const answerBar = $('#adminAnsweredBar');
  if (answerBar) answerBar.style.width = `${currentState.onlineCount ? (currentState.answeredCount / currentState.onlineCount) * 100 : 0}%`;
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

$('#loginForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const email = $('#adminEmail').value.trim();
  const password = $('#adminPassword').value;
  $('#adminEmail').classList.remove('invalid');
  $('#adminPassword').classList.remove('invalid');
  if (!email) { $('#adminEmail').classList.add('invalid'); return showToast('Please enter your email.'); }
  if (!password) { $('#adminPassword').classList.add('invalid'); return showToast('Please enter your password.'); }
  login(email, password);
});

$('#logoutButton').addEventListener('click', logout);

$('#addQuestion').addEventListener('click', () => {
  questionDraft.push(blankQuestion());
  editingIndex = questionDraft.length - 1;
  syncRoundLimit();
  renderQuestions();
});

$('#saveQuestions').addEventListener('click', saveQuestions);

$('#startGame').addEventListener('click', () => {
  if (!questionDraft.length) return showToast('Add at least one question first.');
  if (net) net.send({ type: 'create_game' });
});

watchSecondTabs('quiz-arena-admin-tabs', () => {
  secondTabLocked = true;
  if (net) net.close();
  showScreen('loginScreen');
  showToast('You opened the admin panel in a second tab. This tab has been signed out.', 'error');
});

setInterval(updateAdminTimer, 100);
checkSession();
