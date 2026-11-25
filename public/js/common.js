'use strict';

/* ------------------------------------------------------------------
   WebSocket helper: auto-connect, queue early messages, auto-reconnect.
   Admin uses /ws/admin (cookie required); students use /ws/student.
   ------------------------------------------------------------------ */
class Net {
  constructor(path, onMessage, onStatus) {
    this.path = path;
    this.onMessage = onMessage;
    this.onStatus = onStatus || (() => {});
    this.queue = [];
    this.retry = 0;
    this.stopped = false;
    this.ws = null;
    this.connect();
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws;
    try {
      ws = new WebSocket(`${proto}://${location.host}${this.path}`);
    } catch (_) {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.onStatus('open');
      const queued = this.queue.splice(0);
      queued.forEach((m) => this.send(m));
    };

    ws.onmessage = (event) => {
      try {
        this.onMessage(JSON.parse(event.data));
      } catch (err) {
        console.error('Could not read server message:', err);
      }
    };

    ws.onclose = () => {
      this.onStatus('closed');
      if (!this.stopped) this.scheduleRetry();
    };

    ws.onerror = () => {}; // onclose handles reconnecting
  }

  scheduleRetry() {
    this.retry += 1;
    const delay = Math.min(500 * this.retry, 4000);
    setTimeout(() => { if (!this.stopped) this.connect(); }, delay);
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    } else {
      this.queue.push(obj);
    }
  }

  close() {
    this.stopped = true;
    if (this.ws) this.ws.close();
  }
}

/* Detects another tab of the same page in the same browser. Works even if
   the server has not been restarted, so it catches a quickly opened tab. */
function watchSecondTabs(channelName, onConflict) {
  let channel;
  try { channel = new BroadcastChannel(channelName); } catch (_) { return; }
  const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;
  let fired = false;

  const fire = () => {
    if (fired) return;
    fired = true;
    try { channel.postMessage({ type: 'conflict', id }); } catch (_) { /* ignore */ }
    onConflict();
  };

  channel.onmessage = (event) => {
    const data = event.data || {};
    if (data.id === id) return;
    if (data.type === 'hello' || data.type === 'conflict') fire();
  };

  channel.postMessage({ type: 'hello', id });
  window.addEventListener('pagehide', () => {
    try { channel.postMessage({ type: 'bye', id }); } catch (_) { /* ignore */ }
  });
}

/* ------------------------------------------------------------------
   Shared display helpers.
   ------------------------------------------------------------------ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const initial = (name) => (String(name || '?').trim().charAt(0) || '?').toUpperCase();
const rankIcon = (rank) => (rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `#${rank}`);
const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function showScreen(id) {
  $$('.screen').forEach((screen) => screen.classList.toggle('active', screen.id === id));
}

function setNetStatus(ok) {
  const dot = $('#netDot');
  if (dot) dot.classList.toggle('on', ok);
}

function showToast(message, kind = 'error') {
  let host = $('#toastHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toastHost';
    host.className = 'toast-host';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateX(16px)';
    el.style.transition = 'opacity .25s ease, transform .25s ease';
    setTimeout(() => el.remove(), 260);
  }, 3200);
}

function animateNumber(el, to, duration = 700) {
  if (!el) return;
  const from = Number(el.dataset.value || 0);
  el.dataset.value = String(to);
  if (prefersReducedMotion() || from === to) {
    el.textContent = String(to);
    return;
  }
  const start = performance.now();
  function tick(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = String(Math.round(from + (to - from) * eased));
    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function updateTimer(endsAt, bar, text, durationSeconds) {
  if (!bar || !endsAt) return;
  const remaining = Math.max(0, endsAt - Date.now());
  const total = Number(durationSeconds || bar.dataset.duration || 30) * 1000;
  bar.style.width = `${total > 0 ? Math.min(100, (remaining / total) * 100) : 0}%`;
  bar.classList.toggle('urgent', remaining <= 5000);
  if (text) text.textContent = String(Math.ceil(remaining / 1000));
}

/* Leaderboard rows show "correct / total", e.g. 8/10, plus points. */
function leaderboardHTML(board, highlightId, options = {}) {
  const list = (board || []).slice(0, options.limit || (board || []).length);
  if (!list.length) return '<div class="empty">No groups yet.</div>';
  return `<ol class="lb-list ${options.compact ? 'compact' : ''}">${list.map((p) => {
    const showFraction = p.correct !== undefined && (options.total !== undefined || p.total !== undefined);
    const total = Number(options.total ?? p.total ?? 0);
    return `
    <li class="lb-row ${p.id === highlightId ? 'is-me' : ''} ${p.rank <= 3 ? 'podium-row' : ''}">
      <span class="lb-rank">${rankIcon(p.rank)}</span>
      <span class="avatar sm">${escapeHTML(initial(p.name))}</span>
      <span class="lb-name">
        <strong>${escapeHTML(p.name)}</strong>
        <small>${escapeHTML(p.rollNumber || '')}${p.team ? ` · ${escapeHTML(p.team)}` : ''}</small>
      </span>
      ${showFraction ? `<span class="score-frac"><b>${p.correct}/${total}</b><small>correct</small></span>` : ''}
      <span class="lb-points">${p.score} pts</span>
    </li>`;
  }).join('')}</ol>`;
}

function podiumHTML(board, total = 0) {
  const top = (board || []).slice(0, 3);
  const slots = [0, 1, 2].map((i) => top[i] || { name: '—', score: 0, correct: 0 });
  // Visual order: 2nd, 1st (centre, taller), 3rd.
  return [1, 0, 2].map((idx) => {
    const p = slots[idx];
    const cls = ['first', 'second', 'third'][idx];
    const medal = ['🥇', '🥈', '🥉'][idx];
    return `<div class="pod ${cls}">
      <div class="medal">${medal}</div>
      <div class="pname">${escapeHTML(p.name)}</div>
      <div class="pscore">${p.correct}/${total || p.total || 0}</div>
      <div class="pcorrect">${p.score} pts</div>
    </div>`;
  }).join('');
}

function launchConfetti(host, count = 70) {
  if (!host || prefersReducedMotion()) return;
  host.innerHTML = '';
  const colors = ['#7c5cff', '#22d3ee', '#ffd166', '#ff6b9d', '#34d399'];
  for (let i = 0; i < count; i++) {
    const piece = document.createElement('i');
    piece.className = 'confetti-piece';
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = colors[i % colors.length];
    piece.style.animationDelay = `${Math.random() * 0.9}s`;
    piece.style.animationDuration = `${2 + Math.random() * 2}s`;
    piece.style.opacity = String(0.6 + Math.random() * 0.4);
    host.appendChild(piece);
  }
  setTimeout(() => { host.innerHTML = ''; }, 5200);
}

function downloadCSV(filename, rows) {
  const escapeCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const csv = rows.map((row) => row.map(escapeCell).join(',')).join('\r\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
