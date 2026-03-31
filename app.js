// ─── Constants ────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'wt-data-v1';
const API = 'https://workout-app-backend-zedj.onrender.com';

const EXERCISES = [
  'Bench Press', 'Incline Bench Press', 'Decline Bench Press', 'Dumbbell Fly', 'Push-ups', 'Cable Fly',
  'Squat', 'Front Squat', 'Leg Press', 'Romanian Deadlift', 'Leg Curl', 'Leg Extension', 'Calf Raise', 'Hip Thrust',
  'Deadlift', 'Barbell Row', 'Pull-ups', 'Chin-ups', 'Lat Pulldown', 'Cable Row', 'Seated Row', 'Face Pull',
  'Overhead Press', 'Lateral Raise', 'Front Raise', 'Arnold Press', 'Cable Lateral Raise',
  'Bicep Curl', 'Hammer Curl', 'Preacher Curl', 'Cable Curl',
  'Tricep Extension', 'Skull Crushers', 'Tricep Pushdown', 'Close-Grip Bench', 'Dips',
  'Plank', 'Sit-ups', 'Crunches', 'Leg Raises', 'Russian Twist',
  'Running', 'Cycling', 'Jump Rope', 'Rowing Machine', 'Stair Climber',
];

// ─── State ────────────────────────────────────────────────────────────────────
const s = {
  workout: null,
  history: [],
  unit: 'lbs',
};

let authToken = localStorage.getItem('wt-token') || null;
let authMode  = 'login'; // 'login' | 'register'

let restInterval = null;
let restRemaining = 0;
let restElapsed = 0;
let restMode = null; // 'countdown' | 'stopwatch'
let ringEnabled = localStorage.getItem('wt-ring') !== 'off';
let selectedEx = '';
let chipFilter = '';
let confirmCb = null;

// ─── Persistence ─────────────────────────────────────────────────────────────

// API returns snake_case, frontend uses camelCase — normalize on the way in
function normalizeWorkout(w) {
  return { id: w.id, startTime: w.start_time, endTime: w.end_time, duration: w.duration, exercises: w.exercises };
}

function apiHeaders() {
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` };
}

async function loadHistory() {
  try {
    const res = await fetch(`${API}/workouts`, { headers: apiHeaders() });
    if (res.status === 401) { logout(); return; }
    const data = await res.json();
    s.history = data.map(normalizeWorkout);
  } catch {
    console.error('Backend unreachable — history unavailable.');
    s.history = [];
  }
}

async function postWorkout(workout) {
  const res = await fetch(`${API}/workouts`, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({
      id:         workout.id,
      start_time: workout.startTime,
      end_time:   workout.endTime,
      duration:   workout.duration,
      exercises:  workout.exercises,
    }),
  });
  if (!res.ok) throw new Error('Save failed');
}

function saveUnit() {
  try { localStorage.setItem('wt-unit', s.unit); } catch {}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDur(sec) {
  const m = Math.floor(sec / 60), s2 = sec % 60;
  return `${m}:${String(s2).padStart(2, '0')}`;
}

function fmtDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const yest = new Date(); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

function totalVol(workout) {
  return workout.exercises.reduce((t, ex) =>
    t + ex.sets.reduce((st, set) =>
      st + (parseFloat(set.weight) || 0) * (parseInt(set.reps) || 0), 0), 0);
}

function toDisplayWeight(lbsVal) {
  const v = parseFloat(lbsVal) || 0;
  return s.unit === 'kg' ? Math.round(v * 0.453592 * 10) / 10 : v;
}

// ─── Workout ──────────────────────────────────────────────────────────────────
function startWorkout() {
  s.workout = { id: uid(), startTime: Date.now(), exercises: [] };
  renderWorkout();
}

function cancelWorkout() {
  showConfirm('Cancel this workout? All progress will be lost.', () => {
    cancelRest();
    s.workout = null;
    renderWorkout();
  });
}

function finishWorkout() {
  if (!s.workout) return;
  const proceed = async () => {
    const endTime = Date.now();
    const dur = Math.floor((endTime - s.workout.startTime) / 1000);
    const finished = { ...s.workout, endTime, duration: dur };
    try {
      await postWorkout(finished);
    } catch {
      console.error('Failed to save workout to backend.');
    }
    s.history.unshift(finished);
    cancelRest();
    s.workout = null;
    renderWorkout();
    renderHistory();
    switchTab('history');
  };
  if (s.workout.exercises.length === 0) {
    showConfirm('Finish workout with no exercises logged?', proceed);
  } else {
    proceed();
  }
}

// ─── Rest Timer / Stopwatch ───────────────────────────────────────────────────
function startCountdown(sec) {
  cancelRest();
  restMode = 'countdown';
  restRemaining = sec;
  updateRestDisplay();
  showCancelBtn(true);
  restInterval = setInterval(() => {
    restRemaining--;
    if (restRemaining <= 0) {
      cancelRest();
      if (ringEnabled) playRing();
    } else {
      updateRestDisplay();
    }
  }, 1000);
}

let ringLoopInterval = null;
let ringAudioCtx     = null;

function beepOnce(ctx) {
  [0, 0.25, 0.5].forEach(offset => {
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.6, ctx.currentTime + offset);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + 0.18);
    osc.start(ctx.currentTime + offset);
    osc.stop(ctx.currentTime + offset + 0.18);
  });
}

function playRing() {
  try {
    ringAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    beepOnce(ringAudioCtx);
    ringLoopInterval = setInterval(() => beepOnce(ringAudioCtx), 1500);
    document.getElementById('ring-stop-btn').style.display = '';
  } catch {}
}

function stopRing() {
  clearInterval(ringLoopInterval);
  ringLoopInterval = null;
  if (ringAudioCtx) { ringAudioCtx.close(); ringAudioCtx = null; }
  document.getElementById('ring-stop-btn').style.display = 'none';
}

function toggleRing() {
  ringEnabled = !ringEnabled;
  localStorage.setItem('wt-ring', ringEnabled ? 'on' : 'off');
  document.getElementById('ring-icon-on').style.display  = ringEnabled ? '' : 'none';
  document.getElementById('ring-icon-off').style.display = ringEnabled ? 'none' : '';
  document.getElementById('ring-toggle-btn').classList.toggle('ring-off', !ringEnabled);
}

function toggleStopwatch() {
  if (restMode === 'stopwatch' && restInterval) {
    clearInterval(restInterval);
    restInterval = null;
    document.getElementById('sw-icon-play').style.display = '';
    document.getElementById('sw-icon-pause').style.display = 'none';
  } else {
    if (restMode !== 'stopwatch') {
      cancelRest();
      restMode = 'stopwatch';
      restElapsed = 0;
    }
    showCancelBtn(true);
    document.getElementById('sw-icon-play').style.display = 'none';
    document.getElementById('sw-icon-pause').style.display = '';
    restInterval = setInterval(() => {
      restElapsed++;
      updateRestDisplay();
    }, 1000);
  }
}

function cancelRest() {
  clearInterval(restInterval);
  restInterval = null;
  restRemaining = 0;
  restElapsed = 0;
  restMode = null;
  showCancelBtn(false);
  stopRing();
  const playIcon = document.getElementById('sw-icon-play');
  const pauseIcon = document.getElementById('sw-icon-pause');
  if (playIcon) playIcon.style.display = '';
  if (pauseIcon) pauseIcon.style.display = 'none';
  updateRestDisplay();
}

function showCancelBtn(show) {
  const btn = document.getElementById('rest-cancel-btn');
  if (btn) btn.style.display = show ? '' : 'none';
}

function updateRestDisplay() {
  const el = document.getElementById('rest-countdown');
  if (!el) return;
  if (restMode === 'stopwatch') {
    el.textContent = fmtDur(restElapsed);
  } else if (restMode === 'countdown') {
    el.textContent = fmtDur(restRemaining);
  } else {
    el.textContent = '0:00';
  }
}

// ─── Exercise Modal ───────────────────────────────────────────────────────────
function openExerciseModal() {
  selectedEx = '';
  chipFilter = '';
  document.getElementById('ex-search').value = '';
  renderChips();
  openModal('modal-exercise');
  setTimeout(() => document.getElementById('ex-search').focus(), 350);
}

function onSearchInput(v) {
  chipFilter = v;
  const match = EXERCISES.find(e => e.toLowerCase() === v.trim().toLowerCase());
  selectedEx = match || v.trim();
  renderChips();
}

function renderChips() {
  const q = chipFilter.toLowerCase();
  const filtered = q ? EXERCISES.filter(e => e.toLowerCase().includes(q)) : EXERCISES;
  document.getElementById('chips').innerHTML = filtered.slice(0, 24).map(ex =>
    `<button class="chip${selectedEx === ex ? ' sel' : ''}" data-name="${esc(ex)}">${esc(ex)}</button>`
  ).join('');
}

function pickChip(name) {
  selectedEx = name;
  chipFilter = '';
  document.getElementById('ex-search').value = name;
  renderChips();
}

function confirmAddExercise() {
  const name = selectedEx.trim();
  if (!name) { document.getElementById('ex-search').focus(); return; }
  s.workout.exercises.push({ id: uid(), name, sets: [{ reps: '', weight: '' }] });
  closeModal('modal-exercise');
  renderExercises();
}

// ─── Sets ─────────────────────────────────────────────────────────────────────
function addSet(exId) {
  const ex = s.workout.exercises.find(e => e.id === exId);
  if (!ex) return;
  const last = ex.sets[ex.sets.length - 1] || {};
  ex.sets.push({ reps: last.reps || '', weight: last.weight || '' });
  renderExercises();
  setTimeout(() => {
    document.querySelector(`[data-id="${exId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, 60);
}

function removeSet(exId, i) {
  const ex = s.workout.exercises.find(e => e.id === exId);
  if (!ex || ex.sets.length <= 1) return;
  ex.sets.splice(i, 1);
  renderExercises();
}

function removeExercise(id) {
  s.workout.exercises = s.workout.exercises.filter(e => e.id !== id);
  renderExercises();
}

function setVal(exId, i, field, val) {
  const ex = s.workout.exercises.find(e => e.id === exId);
  if (ex) ex.sets[i][field] = val;
}

// ─── Render ───────────────────────────────────────────────────────────────────
function renderWorkout() {
  const idle   = document.getElementById('state-idle');
  const active = document.getElementById('state-active');
  if (s.workout) {
    idle.style.display = 'none';
    active.style.display = '';
    renderExercises();
  } else {
    idle.style.display = '';
    active.style.display = 'none';
  }
}

function renderExercises() {
  if (!s.workout) return;
  document.getElementById('exercises-list').innerHTML = s.workout.exercises.map(ex => `
    <div class="exercise-card fade-up" data-id="${ex.id}">
      <div class="ex-header">
        <div class="ex-name">${esc(ex.name)}</div>
        <button class="btn-icon" onclick="removeExercise('${ex.id}')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
            <path d="M10 11v6M14 11v6M9 6V4h6v2"/>
          </svg>
        </button>
      </div>
      <div class="sets-thead">
        <div>Set</div><div>Reps</div><div>Weight (${s.unit})</div><div></div>
      </div>
      ${ex.sets.map((set, i) => `
        <div class="set-row">
          <div class="set-num">${i + 1}</div>
          <input class="set-input" type="number" inputmode="numeric" min="0"
                 value="${esc(set.reps)}" placeholder="—"
                 oninput="setVal('${ex.id}',${i},'reps',this.value)">
          <input class="set-input" type="number" inputmode="decimal" min="0" step="0.5"
                 value="${esc(set.weight)}" placeholder="—"
                 oninput="setVal('${ex.id}',${i},'weight',this.value)">
          <button class="btn-icon" onclick="removeSet('${ex.id}',${i})"
                  ${ex.sets.length <= 1 ? 'disabled style="opacity:.25"' : ''}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      `).join('')}
      <div class="add-set-wrap">
        <button class="btn btn-ghost btn-sm" onclick="addSet('${ex.id}')">+ Add Set</button>
      </div>
    </div>
  `).join('');
}

function renderHistory() {
  const el = document.getElementById('history-list');
  if (!s.history.length) {
    el.innerHTML = `
      <div class="empty-state" style="padding:40px 24px">
        <div class="hero-icon">📋</div>
        <h2>No history yet</h2>
        <p>Finish a workout to see it here.</p>
      </div>`;
    return;
  }

  el.innerHTML = s.history.map(w => {
    const sets    = w.exercises.reduce((n, e) => n + e.sets.length, 0);
    const vol     = totalVol(w);
    const dispVol = s.unit === 'kg'
      ? Math.round(vol * 0.453592).toLocaleString()
      : Math.round(vol).toLocaleString();

    return `
      <div class="history-card" onclick="toggleHist(this)">
        <div class="hist-header">
          <div>
            <div class="hist-date">${fmtDate(w.startTime)}</div>
            <div class="hist-meta">
              <span>${fmtDur(w.duration || 0)}</span>
              <span>${w.exercises.length} exercise${w.exercises.length !== 1 ? 's' : ''}</span>
              <span>${sets} set${sets !== 1 ? 's' : ''}</span>
              ${vol > 0 ? `<span>${dispVol} ${s.unit}</span>` : ''}
            </div>
          </div>
          <svg class="hist-chevron" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </div>
        <div class="hist-details">
          ${w.exercises.map(ex => `
            <div class="hist-ex">
              <div class="hist-ex-name">${esc(ex.name)}</div>
              <div class="hist-sets">
                ${ex.sets.filter(set => set.reps || set.weight).map(set => {
                  const wVal = toDisplayWeight(set.weight);
                  return `<span class="hist-set-tag">${set.reps || 0} × ${wVal} ${s.unit}</span>`;
                }).join('')}
                ${ex.sets.every(set => !set.reps && !set.weight)
                  ? '<span style="color:var(--text3);font-size:12px">No data logged</span>' : ''}
              </div>
            </div>
          `).join('')}
        </div>
      </div>`;
  }).join('');
}

function toggleHist(card) {
  card.classList.toggle('open');
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────
function switchTab(tab) {
  document.getElementById('tab-workout').style.display  = tab === 'workout'  ? '' : 'none';
  document.getElementById('tab-history').style.display  = tab === 'history'  ? '' : 'none';
  document.getElementById('tab-progress').style.display = tab === 'progress' ? '' : 'none';
  document.getElementById('tbtn-workout').classList.toggle('active',  tab === 'workout');
  document.getElementById('tbtn-history').classList.toggle('active',  tab === 'history');
  document.getElementById('tbtn-progress').classList.toggle('active', tab === 'progress');
  if (tab === 'history')  renderHistory();
  if (tab === 'progress') renderProgress();
}

// ─── Progress / Charts ────────────────────────────────────────────────────────
let chartVolume   = null;
let chartStrength = null;

function chartDefaults() {
  return {
    responsive: true,
    maintainAspectRatio: true,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: '#888', font: { size: 11 } }, grid: { color: '#222' } },
      y: { ticks: { color: '#888', font: { size: 11 } }, grid: { color: '#222' }, beginAtZero: false },
    },
  };
}

function renderProgress() {
  const sorted = [...s.history].sort((a, b) => a.startTime - b.startTime);

  if (sorted.length === 0) {
    document.getElementById('progress-empty').style.display  = '';
    document.getElementById('progress-charts').style.display = 'none';
    return;
  }
  document.getElementById('progress-empty').style.display  = 'none';
  document.getElementById('progress-charts').style.display = '';

  renderVolumeChart(sorted);
  populateExercisePicker(sorted);
  renderStrengthChart();
}

function renderVolumeChart(sorted) {
  const labels = sorted.map(w => {
    const d = new Date(w.startTime);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  });

  const mult = s.unit === 'kg' ? 0.453592 : 1;
  const data  = sorted.map(w => Math.round(totalVol(w) * mult));

  document.getElementById('vol-unit-label').textContent = s.unit;

  if (chartVolume) chartVolume.destroy();
  chartVolume = new Chart(document.getElementById('chart-volume'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data,
        borderColor: '#6c8eff',
        backgroundColor: 'rgba(108,142,255,0.12)',
        pointBackgroundColor: '#6c8eff',
        pointRadius: 4,
        tension: 0.3,
        fill: true,
      }],
    },
    options: chartDefaults(),
  });
}

function populateExercisePicker(sorted) {
  const names = new Set();
  sorted.forEach(w => w.exercises.forEach(ex => names.add(ex.name)));
  const picker = document.getElementById('exercise-picker');
  const prev   = picker.value;
  picker.innerHTML = [...names].sort().map(n =>
    `<option value="${esc(n)}"${n === prev ? ' selected' : ''}>${esc(n)}</option>`
  ).join('');
}

function renderStrengthChart() {
  const name   = document.getElementById('exercise-picker').value;
  const sorted = [...s.history].sort((a, b) => a.startTime - b.startTime);

  const points = [];
  sorted.forEach(w => {
    const ex = w.exercises.find(e => e.name === name);
    if (!ex) return;
    const maxW = Math.max(...ex.sets.map(s2 => parseFloat(s2.weight) || 0));
    if (maxW > 0) {
      const d = new Date(w.startTime);
      points.push({
        label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        value: s.unit === 'kg' ? Math.round(maxW * 0.453592 * 10) / 10 : maxW,
      });
    }
  });

  const emptyEl = document.getElementById('strength-empty');
  const canvas  = document.getElementById('chart-strength');

  if (points.length < 2) {
    emptyEl.style.display = '';
    canvas.style.display  = 'none';
    if (chartStrength) { chartStrength.destroy(); chartStrength = null; }
    return;
  }
  emptyEl.style.display = 'none';
  canvas.style.display  = '';

  if (chartStrength) chartStrength.destroy();
  chartStrength = new Chart(canvas, {
    type: 'line',
    data: {
      labels: points.map(p => p.label),
      datasets: [{
        data:  points.map(p => p.value),
        borderColor: '#4ecdc4',
        backgroundColor: 'rgba(78,205,196,0.12)',
        pointBackgroundColor: '#4ecdc4',
        pointRadius: 4,
        tension: 0.3,
        fill: true,
      }],
    },
    options: {
      ...chartDefaults(),
      plugins: {
        ...chartDefaults().plugins,
        tooltip: {
          callbacks: {
            label: ctx => `${ctx.parsed.y} ${s.unit}`,
          },
        },
      },
    },
  });
}

// ─── Unit ─────────────────────────────────────────────────────────────────────
function setUnit(u) {
  s.unit = u;
  ['btn-lbs', 'btn-lbs2'].forEach(id => document.getElementById(id)?.classList.toggle('active', u === 'lbs'));
  ['btn-kg',  'btn-kg2' ].forEach(id => document.getElementById(id)?.classList.toggle('active', u === 'kg'));
  saveUnit();
  renderHistory();
  if (s.workout) renderExercises();
}

// ─── Modals ───────────────────────────────────────────────────────────────────
function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
function onOverlayClick(e, id) { if (e.target === e.currentTarget) closeModal(id); }

function showConfirm(msg, cb) {
  confirmCb = cb;
  document.getElementById('confirm-msg').textContent = msg;
  document.getElementById('confirm-yes').onclick = () => {
    closeModal('modal-confirm');
    confirmCb?.();
  };
  openModal('modal-confirm');
}

// ─── Timer Tabs ───────────────────────────────────────────────────────────────
function switchTimerTab(tab) {
  document.getElementById('ttab-timer').classList.toggle('active', tab === 'timer');
  document.getElementById('ttab-stopwatch').classList.toggle('active', tab === 'stopwatch');
  document.getElementById('ttab-content-timer').style.display = tab === 'timer' ? 'flex' : 'none';
  document.getElementById('ttab-content-stopwatch').style.display = tab === 'stopwatch' ? 'flex' : 'none';
  if (tab === 'timer') cancelRest();
  if (tab === 'stopwatch') cancelRest();
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
function showAuthScreen() {
  document.getElementById('auth-screen').style.display = '';
  document.getElementById('app').style.display = 'none';
}

function hideAuthScreen() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app').style.display = '';
}

function toggleAuthMode() {
  authMode = authMode === 'login' ? 'register' : 'login';
  document.getElementById('auth-title').textContent      = authMode === 'login' ? 'Login' : 'Sign Up';
  document.getElementById('auth-toggle-btn').textContent = authMode === 'login' ? "Don't have an account? Sign up" : 'Already have an account? Login';
}

async function submitAuth() {
  const email    = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const errorEl  = document.getElementById('auth-error');

  if (!email || !password) {
    errorEl.textContent = 'Please fill in all fields.';
    errorEl.style.display = '';
    return;
  }

  try {
    const res  = await fetch(`${API}/${authMode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      errorEl.textContent = data.detail || 'Something went wrong.';
      errorEl.style.display = '';
      return;
    }
    authToken = data.token;
    localStorage.setItem('wt-token', authToken);
    errorEl.style.display = 'none';
    hideAuthScreen();
    await loadHistory();
    renderHistory();
    renderWorkout();
  } catch {
    errorEl.textContent = 'Cannot connect to server.';
    errorEl.style.display = '';
  }
}

function logout() {
  authToken = null;
  localStorage.removeItem('wt-token');
  s.history = [];
  s.workout = null;
  cancelRest();
  showAuthScreen();
}

// ─── CSV Import ───────────────────────────────────────────────────────────────
function parseCSVLine(line) {
  // Handle quoted fields
  const fields = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuote = !inQuote; }
    else if (ch === ',' && !inQuote) { fields.push(cur.trim()); cur = ''; }
    else { cur += ch; }
  }
  fields.push(cur.trim());
  return fields;
}

async function importCSV(input) {
  const file = input.files[0];
  input.value = '';
  if (!file) return;

  const text = await file.text();
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return showImportStatus('CSV is empty or has no data rows.', 'error');

  const header = parseCSVLine(lines[0]).map(h => h.toLowerCase().replace(/\s+/g, ''));

  const col = name => header.indexOf(name);
  const dateIdx     = col('date');
  const exerciseIdx = col('exercise');
  const repsIdx     = col('reps');
  const weightIdx   = col('weight');

  if ([dateIdx, exerciseIdx, repsIdx, weightIdx].includes(-1)) {
    return showImportStatus('CSV must have columns: date, exercise, reps, weight', 'error');
  }

  // Group rows by date → { date: { exerciseName: [sets] } }
  const byDate = {};
  for (let i = 1; i < lines.length; i++) {
    const f = parseCSVLine(lines[i]);
    if (f.length < 4) continue;
    const date     = f[dateIdx]?.trim();
    const exercise = f[exerciseIdx]?.trim();
    const reps     = f[repsIdx]?.trim();
    const weight   = f[weightIdx]?.trim();
    if (!date || !exercise) continue;

    if (!byDate[date]) byDate[date] = {};
    if (!byDate[date][exercise]) byDate[date][exercise] = [];
    byDate[date][exercise].push({ reps: reps || '', weight: weight || '' });
  }

  const dates = Object.keys(byDate).sort();
  if (!dates.length) return showImportStatus('No valid rows found in CSV.', 'error');

  // Build workout objects and POST each one
  let saved = 0, skipped = 0;
  for (const date of dates) {
    const startMs  = new Date(date + 'T09:00:00').getTime();
    const endMs    = startMs + 3600 * 1000; // assume 1 hr duration
    const exercises = Object.entries(byDate[date]).map(([name, sets]) => ({
      id: uid(), name, sets,
    }));
    const workout = {
      id:         uid(),
      startTime:  startMs,
      endTime:    endMs,
      duration:   3600,
      exercises,
    };
    try {
      await postWorkout(workout);
      s.history.unshift(workout);
      saved++;
    } catch {
      skipped++;
    }
  }

  renderHistory();
  const msg = skipped
    ? `Imported ${saved} workout${saved !== 1 ? 's' : ''}. ${skipped} failed.`
    : `Imported ${saved} workout${saved !== 1 ? 's' : ''} successfully.`;
  showImportStatus(msg, skipped ? 'error' : 'ok');
}

function showImportStatus(msg, type) {
  const el = document.getElementById('import-status');
  el.textContent = msg;
  el.className = `import-status ${type}`;
  el.style.display = '';
  setTimeout(() => { el.style.display = 'none'; }, 5000);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  s.unit = localStorage.getItem('wt-unit') || 'lbs';
  document.getElementById('header-date').textContent = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });
  ['btn-lbs', 'btn-lbs2'].forEach(id => document.getElementById(id)?.classList.toggle('active', s.unit === 'lbs'));
  ['btn-kg',  'btn-kg2' ].forEach(id => document.getElementById(id)?.classList.toggle('active', s.unit === 'kg'));

  // Sync bell icon with persisted preference
  document.getElementById('ring-icon-on').style.display  = ringEnabled ? '' : 'none';
  document.getElementById('ring-icon-off').style.display = ringEnabled ? 'none' : '';
  document.getElementById('ring-toggle-btn').classList.toggle('ring-off', !ringEnabled);

  if (!authToken) {
    showAuthScreen();
    return;
  }

  await loadHistory();
  renderHistory();
  renderWorkout();

  // Chip click — same pattern as button.html's addEventListener
  document.getElementById('chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) pickChip(chip.dataset.name);
  });

  // Unregister all service workers — they interfere with API calls in development
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(regs => {
      regs.forEach(reg => reg.unregister());
    });
  }
}

document.addEventListener('DOMContentLoaded', init);
