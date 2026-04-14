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

let customExercises = JSON.parse(localStorage.getItem('wt-custom-exercises') || '[]');

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
  const MAX_ATTEMPTS = 4;
  const RETRY_DELAY  = 15000; // 15s between retries (cold start can take ~50s)

  showBackendStatus('connecting');

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${API}/workouts`, { headers: apiHeaders() });
      if (res.status === 401) { logout(); hideBackendStatus(); return; }
      const data = await res.json();
      s.history = data.map(normalizeWorkout);
      hideBackendStatus();
      return;
    } catch {
      if (attempt < MAX_ATTEMPTS) {
        showBackendStatus('waking', attempt, MAX_ATTEMPTS);
        await new Promise(r => setTimeout(r, RETRY_DELAY));
      } else {
        showBackendStatus('failed');
        s.history = [];
      }
    }
  }
}

function showBackendStatus(state, attempt, max) {
  let el = document.getElementById('backend-status');
  if (!el) {
    el = document.createElement('div');
    el.id = 'backend-status';
    document.getElementById('history-list')?.before(el);
  }
  if (state === 'connecting') {
    el.className = 'backend-status connecting';
    el.textContent = 'Connecting to server…';
  } else if (state === 'waking') {
    el.className = 'backend-status waking';
    el.textContent = `Server is waking up (attempt ${attempt}/${max}) — this can take up to 50s…`;
  } else if (state === 'failed') {
    el.className = 'backend-status failed';
    el.innerHTML = 'Could not reach server. <button onclick="retryLoadHistory()" class="btn-retry">Retry</button>';
  }
  el.style.display = '';
}

function hideBackendStatus() {
  const el = document.getElementById('backend-status');
  if (el) el.style.display = 'none';
}

async function retryLoadHistory() {
  await loadHistory();
  renderHistory();
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

async function postWorkout(workout) {
  // Save locally first — protects against browser close during the upload
  savePendingWorkout(workout);

  const body = JSON.stringify({
    id:         workout.id,
    start_time: workout.startTime,
    end_time:   workout.endTime,
    duration:   workout.duration,
    exercises:  workout.exercises,
  });

  const MAX_ATTEMPTS = 5;
  const RETRY_DELAY  = 12000;
  const FETCH_TIMEOUT = 20000;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      if (attempt > 1) showLoading(`Waking up server… (attempt ${attempt}/${MAX_ATTEMPTS})`);
      const res = await fetchWithTimeout(`${API}/workouts`, {
        method: 'POST', headers: apiHeaders(), body,
      }, FETCH_TIMEOUT);
      if (!res.ok) throw new Error(`Save failed (${res.status})`);
      removePendingWorkout(workout.id);
      return;
    } catch {
      if (attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, RETRY_DELAY));
      } else {
        // Workout already in localStorage — will sync on next open
        throw new Error('Could not reach server — workout saved locally');
      }
    }
  }
}

function savePendingWorkout(workout) {
  const pending = JSON.parse(localStorage.getItem('wt-pending') || '[]');
  if (!pending.find(w => w.id === workout.id)) {
    pending.push(workout);
    localStorage.setItem('wt-pending', JSON.stringify(pending));
  }
}

function removePendingWorkout(id) {
  const pending = JSON.parse(localStorage.getItem('wt-pending') || '[]');
  localStorage.setItem('wt-pending', JSON.stringify(pending.filter(w => w.id !== id)));
}

async function syncPendingWorkouts() {
  const pending = JSON.parse(localStorage.getItem('wt-pending') || '[]');
  if (!pending.length) return;
  for (const workout of pending) {
    try {
      const res = await fetchWithTimeout(`${API}/workouts`, {
        method: 'POST', headers: apiHeaders(),
        body: JSON.stringify({
          id: workout.id, start_time: workout.startTime,
          end_time: workout.endTime, duration: workout.duration,
          exercises: workout.exercises,
        }),
      }, 20000);
      // 200 = saved, 409 = already exists in DB — both mean we can clear from pending
      if (res.ok || res.status === 409) removePendingWorkout(workout.id);
    } catch { break; } // network error — server still down, stop for now
  }
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

// ─── 1RM helpers ──────────────────────────────────────────────────────────────
// Epley formula: weight × (1 + reps/30). Reliable for 1-10 reps.
function estimatedOneRM(weight, reps) {
  if (!weight || !reps || reps <= 0) return 0;
  if (reps === 1) return weight;
  if (reps > 10) return 0; // unreliable at high rep ranges
  return Math.round(weight * (1 + reps / 30) * 10) / 10;
}

// Best estimated 1RM across all sets of a single exercise
function bestOneRM(exercise) {
  let best = 0;
  for (const set of exercise.sets) {
    const e = estimatedOneRM(parseFloat(set.weight) || 0, parseInt(set.reps) || 0);
    if (e > best) best = e;
  }
  return best;
}

// Returns { workoutId: { exerciseName: oneRM } } for every exercise that was a PR
// at the time it was performed (compared to all earlier workouts).
function computeHistoryPRs(history) {
  const sorted = [...history].sort((a, b) => a.startTime - b.startTime);
  const runningBest = {}; // exerciseName → best 1RM seen so far
  const result = {};
  for (const w of sorted) {
    result[w.id] = {};
    for (const ex of w.exercises) {
      const rm = bestOneRM(ex);
      if (rm > 0 && rm > (runningBest[ex.name] || 0)) {
        result[w.id][ex.name] = rm;
        runningBest[ex.name] = rm;
      }
    }
  }
  return result;
}

// Returns array of { name, oneRM } for exercises that set a new all-time record
function detectPRs(finishedWorkout, previousHistory) {
  const prs = [];
  for (const ex of finishedWorkout.exercises) {
    const current = bestOneRM(ex);
    if (current <= 0) continue;
    const historicalBest = previousHistory.reduce((best, w) => {
      const match = w.exercises.find(e => e.name === ex.name);
      return match ? Math.max(best, bestOneRM(match)) : best;
    }, 0);
    if (current > historicalBest) {
      prs.push({ name: ex.name, oneRM: current });
    }
  }
  return prs;
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

function showLoading(msg = 'Saving workout…') {
  const el = document.getElementById('loading-overlay');
  el.querySelector('.loading-text').textContent = msg;
  el.classList.add('show');
}

function hideLoading() {
  document.getElementById('loading-overlay').classList.remove('show');
}

function finishWorkout() {
  if (!s.workout) return;
  const proceed = async () => {
    const endTime = Date.now();
    const dur = Math.floor((endTime - s.workout.startTime) / 1000);
    const finished = { ...s.workout, endTime, duration: dur };
    showLoading('Saving workout…');
    let saveError = false;
    try {
      await postWorkout(finished);
    } catch {
      saveError = true;
    }
    hideLoading();
    if (saveError) {
      showImportStatus('No connection — workout saved locally and will sync next time you open the app.', 'error');
    }
    const prs = detectPRs(finished, s.history);
    s.history.unshift(finished);
    cancelRest();
    s.workout = null;
    renderWorkout();
    renderHistory();
    switchTab('history');
    if (prs.length > 0) showPRModal(prs);
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
  const allExercises = [...customExercises, ...EXERCISES.filter(e => !customExercises.includes(e))].sort((a, b) => a.localeCompare(b));
  const filtered = q ? allExercises.filter(e => e.toLowerCase().includes(q)) : allExercises;
  document.getElementById('chips').innerHTML = filtered.slice(0, 50).map(ex =>
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
  if (!EXERCISES.includes(name) && !customExercises.includes(name)) {
    customExercises.unshift(name);
    localStorage.setItem('wt-custom-exercises', JSON.stringify(customExercises));
  }
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

// ─── Progressive Overload ─────────────────────────────────────────────────────
// Returns { last: "8 × 80 kg", suggest: "9 × 80 kg" } or null if no history
function getOverloadSuggestion(exName) {
  const prev = [...s.history]
    .sort((a, b) => b.startTime - a.startTime)
    .find(w => w.exercises.some(e => e.name === exName));
  if (!prev) return null;

  const lastEx = prev.exercises.find(e => e.name === exName);
  const validSets = lastEx.sets.filter(set => parseFloat(set.weight) > 0 && parseInt(set.reps) > 0);
  if (!validSets.length) return null;

  // Pick the heaviest set as the reference
  const best = validSets.reduce((top, set) =>
    parseFloat(set.weight) > parseFloat(top.weight) ? set : top
  );
  const w = parseFloat(best.weight);
  const r = parseInt(best.reps);
  const dispW = toDisplayWeight(w);

  const lastStr = `${r} × ${dispW} ${s.unit}`;
  let suggestStr;
  if (r < 10) {
    suggestStr = `${r + 1} × ${dispW} ${s.unit}`;
  } else {
    const incr = s.unit === 'kg' ? 2.5 : 5;
    suggestStr = `${r} × ${dispW + incr} ${s.unit}`;
  }
  return { last: lastStr, suggest: suggestStr };
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

const FORM_CHECK_EXERCISES = new Set(['Squat','Deadlift','Bench Press','Overhead Press','Bicep Curl','Push-ups']);

function renderExercises() {
  if (!s.workout) return;
  document.getElementById('exercises-list').innerHTML = s.workout.exercises.map(ex => {
    const hint = getOverloadSuggestion(ex.name);
    return `
    <div class="exercise-card fade-up" data-id="${ex.id}">
      <div class="ex-header">
        <div>
          <div class="ex-name">${esc(ex.name)}</div>
          ${hint ? `<div class="ex-suggest">Last: ${hint.last} &rarr; <span class="ex-suggest-target">${hint.suggest}</span></div>` : ''}
        </div>
        <div style="display:flex;align-items:center;gap:2px">
        ${FORM_CHECK_EXERCISES.has(ex.name) ? `
          <button class="btn-icon ex-form-check-btn" onclick="openFormCheck('${esc(ex.name)}')" title="Check form">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
              <circle cx="12" cy="13" r="4"/>
            </svg>
          </button>` : ''}
        <button class="btn-icon" onclick="removeExercise('${ex.id}')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
            <path d="M10 11v6M14 11v6M9 6V4h6v2"/>
          </svg>
        </button>
        </div>
      </div>
      <div class="sets-thead">
        <div>Set</div><div>Reps</div><div>Weight (${s.unit})</div><div>Note</div><div></div>
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
          <input class="set-comment" type="text" placeholder="Note…"
                 value="${esc(set.comment || '')}"
                 oninput="setVal('${ex.id}',${i},'comment',this.value)">
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
  `;
  }).join('');
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

  const prMap = computeHistoryPRs(s.history);

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
          ${w.exercises.map(ex => {
            const isPR = prMap[w.id]?.[ex.name];
            const hasSets = ex.sets.some(set => set.reps || set.weight);
            return `
            <div class="hist-ex">
              <div class="hist-ex-name">${esc(ex.name)}${isPR ? '<span class="pr-badge">PR</span>' : ''}</div>
              <div class="hist-sets">
                ${ex.sets.filter(set => set.reps || set.weight).map(set => {
                  const wVal = toDisplayWeight(set.weight);
                  return `<span class="hist-set-tag">${set.reps || 0} × ${wVal} ${s.unit}</span>`;
                }).join('')}
                ${!hasSets ? '<span style="color:var(--text3);font-size:12px">No data logged</span>' : ''}
              </div>
            </div>`;
          }).join('')}
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
let chartMuscle   = null;

// Ordinary least-squares linear regression on [{x, y}] points.
// Returns { slope, intercept, r2 } or null if degenerate.
function linearRegression(pts) {
  const n = pts.length;
  if (n < 2) return null;
  const sx  = pts.reduce((a, p) => a + p.x, 0);
  const sy  = pts.reduce((a, p) => a + p.y, 0);
  const sxy = pts.reduce((a, p) => a + p.x * p.y, 0);
  const sx2 = pts.reduce((a, p) => a + p.x * p.x, 0);
  const den = n * sx2 - sx * sx;
  if (den === 0) return null;
  const slope     = (n * sxy - sx * sy) / den;
  const intercept = (sy - slope * sx) / n;
  const meanY = sy / n;
  const ssTot = pts.reduce((a, p) => a + (p.y - meanY) ** 2, 0);
  const ssRes = pts.reduce((a, p) => a + (p.y - (slope * p.x + intercept)) ** 2, 0);
  const r2 = ssTot === 0 ? 1 : Math.max(0, 1 - ssRes / ssTot);
  return { slope, intercept, r2 };
}

// Maps every built-in exercise to a muscle group
const MUSCLE_GROUP_MAP = {
  'Bench Press': 'Chest', 'Incline Bench Press': 'Chest', 'Decline Bench Press': 'Chest',
  'Dumbbell Fly': 'Chest', 'Push-ups': 'Chest', 'Cable Fly': 'Chest',
  'Squat': 'Legs', 'Front Squat': 'Legs', 'Leg Press': 'Legs',
  'Romanian Deadlift': 'Legs', 'Leg Curl': 'Legs', 'Leg Extension': 'Legs',
  'Calf Raise': 'Legs', 'Hip Thrust': 'Legs',
  'Deadlift': 'Back', 'Barbell Row': 'Back', 'Pull-ups': 'Back', 'Chin-ups': 'Back',
  'Lat Pulldown': 'Back', 'Cable Row': 'Back', 'Seated Row': 'Back', 'Face Pull': 'Back',
  'Overhead Press': 'Shoulders', 'Lateral Raise': 'Shoulders', 'Front Raise': 'Shoulders',
  'Arnold Press': 'Shoulders', 'Cable Lateral Raise': 'Shoulders',
  'Bicep Curl': 'Biceps', 'Hammer Curl': 'Biceps', 'Preacher Curl': 'Biceps', 'Cable Curl': 'Biceps',
  'Tricep Extension': 'Triceps', 'Skull Crushers': 'Triceps', 'Tricep Pushdown': 'Triceps',
  'Close-Grip Bench': 'Triceps', 'Dips': 'Triceps',
  'Plank': 'Core', 'Sit-ups': 'Core', 'Crunches': 'Core', 'Leg Raises': 'Core', 'Russian Twist': 'Core',
  'Running': 'Cardio', 'Cycling': 'Cardio', 'Jump Rope': 'Cardio', 'Rowing Machine': 'Cardio', 'Stair Climber': 'Cardio',
};
const MUSCLE_ORDER = ['Chest', 'Back', 'Legs', 'Shoulders', 'Biceps', 'Triceps', 'Core', 'Cardio'];

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
  renderMuscleChart(sorted);
  populateExercisePicker(sorted);
  renderStrengthChart();
}

function renderMuscleChart(sorted) {
  // Use last 28 days of workouts
  const cutoff = Date.now() - 28 * 24 * 60 * 60 * 1000;
  const recent = sorted.filter(w => w.startTime >= cutoff);
  const source = recent.length > 0 ? recent : sorted; // fall back to all-time if <28d

  // Count total sets per muscle group
  const counts = {};
  MUSCLE_ORDER.forEach(g => counts[g] = 0);
  for (const w of source) {
    for (const ex of w.exercises) {
      const group = MUSCLE_GROUP_MAP[ex.name];
      if (group) counts[group] += ex.sets.length;
    }
  }

  const emptyEl = document.getElementById('muscle-empty');
  const canvas  = document.getElementById('chart-muscle');
  const total   = Object.values(counts).reduce((a, b) => a + b, 0);

  if (total === 0) {
    emptyEl.style.display = '';
    canvas.style.display  = 'none';
    if (chartMuscle) { chartMuscle.destroy(); chartMuscle = null; }
    return;
  }
  emptyEl.style.display = 'none';
  canvas.style.display  = '';

  const label = recent.length > 0 ? 'Last 28 days · sets per muscle group' : 'All time · sets per muscle group';
  document.getElementById('muscle-period-label').textContent = label;

  const labels = MUSCLE_ORDER.filter(g => counts[g] > 0 || true); // keep all so shape is consistent
  const data   = MUSCLE_ORDER.map(g => counts[g]);

  if (chartMuscle) chartMuscle.destroy();
  chartMuscle = new Chart(canvas, {
    type: 'radar',
    data: {
      labels: MUSCLE_ORDER,
      datasets: [{
        data,
        borderColor: 'rgba(255, 107, 53, 0.9)',
        backgroundColor: 'rgba(255, 107, 53, 0.18)',
        pointBackgroundColor: 'rgba(255, 107, 53, 1)',
        pointRadius: 4,
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: { legend: { display: false } },
      scales: {
        r: {
          beginAtZero: true,
          ticks: { display: false },
          grid:       { color: '#2a2a2a' },
          angleLines: { color: '#2a2a2a' },
          pointLabels: {
            color: '#8e8e93',
            font: { size: 11 },
          },
        },
      },
    },
  });
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
  const name       = document.getElementById('exercise-picker').value;
  const sorted     = [...s.history].sort((a, b) => a.startTime - b.startTime);
  const forecastEl = document.getElementById('strength-forecast');

  const points = [];
  sorted.forEach(w => {
    const ex = w.exercises.find(e => e.name === name);
    if (!ex) return;
    const rm = bestOneRM(ex);
    if (rm > 0) {
      const d = new Date(w.startTime);
      points.push({
        label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        value: s.unit === 'kg' ? Math.round(rm * 0.453592 * 10) / 10 : rm,
        time:  w.startTime,
      });
    }
  });

  const emptyEl = document.getElementById('strength-empty');
  const canvas  = document.getElementById('chart-strength');

  if (points.length < 2) {
    emptyEl.style.display    = '';
    canvas.style.display     = 'none';
    forecastEl.style.display = 'none';
    if (chartStrength) { chartStrength.destroy(); chartStrength = null; }
    return;
  }
  emptyEl.style.display = 'none';
  canvas.style.display  = '';

  // ── Linear regression + 4-week forecast ──────────────────────────────────
  let extraDataset = null;
  let chartLabels  = points.map(p => p.label);

  if (points.length >= 3) {
    const t0   = points[0].time;
    const xys  = points.map(p => ({ x: (p.time - t0) / 86400000, y: p.value }));
    const reg  = linearRegression(xys);

    if (reg) {
      const lastX     = xys[xys.length - 1].x;
      const lastVal   = points[points.length - 1].value;
      const futureX   = lastX + 28;
      const futureVal = Math.round((reg.slope * futureX + reg.intercept) * 10) / 10;
      const gain      = Math.round((futureVal - lastVal) * 10) / 10;

      const futureDate  = new Date(points[points.length - 1].time + 28 * 86400000);
      const futureLabel = futureDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      chartLabels = [...chartLabels, futureLabel];

      // Forecast dataset: null for all but last historical + future point
      const fData = [...new Array(points.length).fill(null), futureVal];
      fData[points.length - 1] = lastVal; // connect from last known point

      extraDataset = {
        data: fData,
        borderColor: 'rgba(255,107,53,0.75)',
        borderDash: [6, 4],
        backgroundColor: 'transparent',
        pointRadius: fData.map((_, i) => i === fData.length - 1 ? 5 : 0),
        pointBackgroundColor: fData.map((_, i) => i === fData.length - 1 ? '#FF6B35' : 'transparent'),
        tension: 0,
        fill: false,
        spanGaps: false,
      };

      if (reg.slope > 0.01) {
        forecastEl.textContent = `📈 +${gain} ${s.unit} predicted in 4 weeks → ${futureVal} ${s.unit}  ·  R² ${reg.r2.toFixed(2)}`;
        forecastEl.className = 'strength-forecast forecast-up';
      } else if (reg.slope < -0.01) {
        forecastEl.textContent = `📉 Downward trend — consider a deload week.`;
        forecastEl.className = 'strength-forecast forecast-down';
      } else {
        forecastEl.textContent = `⚠️ Plateau detected — try changing rep scheme or weight.`;
        forecastEl.className = 'strength-forecast forecast-flat';
      }
      forecastEl.style.display = '';
    }
  } else {
    forecastEl.style.display = 'none';
  }

  const datasets = [{
    data:  points.map(p => p.value),
    borderColor: '#4ecdc4',
    backgroundColor: 'rgba(78,205,196,0.12)',
    pointBackgroundColor: '#4ecdc4',
    pointRadius: 4,
    tension: 0.3,
    fill: true,
  }];
  if (extraDataset) datasets.push(extraDataset);

  if (chartStrength) chartStrength.destroy();
  chartStrength = new Chart(canvas, {
    type: 'line',
    data: { labels: chartLabels, datasets },
    options: {
      ...chartDefaults(),
      plugins: {
        ...chartDefaults().plugins,
        tooltip: {
          callbacks: {
            label: ctx => ctx.parsed.y != null ? `${ctx.parsed.y} ${s.unit}` : '',
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

function showPRModal(prs) {
  const unit = s.unit;
  const mult = unit === 'kg' ? 0.453592 : 1;
  document.getElementById('pr-list').innerHTML = prs.map(pr => {
    const val = Math.round(pr.oneRM * mult * 10) / 10;
    return `<div class="pr-item"><span class="pr-item-name">${esc(pr.name)}</span><span class="pr-item-val">${val} ${unit} est. 1RM</span></div>`;
  }).join('');
  openModal('modal-pr');
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

  // Chip click
  document.getElementById('chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) pickChip(chip.dataset.name);
  });

  if (!authToken) {
    showAuthScreen();
    return;
  }

  await loadHistory();
  await syncPendingWorkouts();
  renderHistory();
  renderWorkout();


  // Unregister all service workers — they interfere with API calls in development
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(regs => {
      regs.forEach(reg => reg.unregister());
    });
  }
}

document.addEventListener('DOMContentLoaded', init);

// ─── Form Check ───────────────────────────────────────────────────────────────
let poseDetector    = null;
let formCamStream   = null;
let formCheckActive = false;
let formExercise    = 'Squat';

function openFormCheck(exName) {
  const select = document.getElementById('form-ex-select');
  if (exName && select) { select.value = exName; formExercise = exName; }
  document.getElementById('modal-form-check').classList.add('open');
  startFormCheck();
}

function closeFormCheck() {
  document.getElementById('modal-form-check').classList.remove('open');
  stopFormCheck();
}

async function startFormCheck() {
  formCheckActive = true;
  formExercise = document.getElementById('form-ex-select').value;
  updateAngleHint(formExercise);
  const videoEl  = document.getElementById('form-video');
  const noPoseEl = document.getElementById('fc-no-pose');

  noPoseEl.textContent = 'Starting camera…';
  noPoseEl.style.display = '';

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    videoEl.srcObject = stream;
    formCamStream = stream;
    await videoEl.play();
  } catch {
    renderFormFeedback([], ['Camera access denied — allow camera in browser settings']);
    noPoseEl.textContent = 'Camera unavailable';
    return;
  }

  noPoseEl.textContent = 'Loading pose model…';

  const pose = new Pose({
    locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`,
  });
  pose.setOptions({
    modelComplexity: 1,
    smoothLandmarks: true,
    enableSegmentation: false,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });

  const canvasEl = document.getElementById('form-canvas');
  let modelReady = false;

  pose.onResults(results => {
    if (!modelReady) {
      modelReady = true;
      noPoseEl.style.display = 'none';
    }
    onPoseResults(results, canvasEl);
  });

  poseDetector = pose;

  async function detect() {
    if (!formCheckActive || !poseDetector) return;
    if (videoEl.readyState >= 2) {
      await poseDetector.send({ image: videoEl });
    }
    requestAnimationFrame(detect);
  }
  detect();
}

function stopFormCheck() {
  formCheckActive = false;
  if (formCamStream) {
    formCamStream.getTracks().forEach(t => t.stop());
    formCamStream = null;
  }
  if (poseDetector) {
    poseDetector.close();
    poseDetector = null;
  }
  const videoEl = document.getElementById('form-video');
  if (videoEl) videoEl.srcObject = null;
}

const FORM_ANGLE_HINTS = {
  'Squat':           { icon: '↔', view: 'Side view', tip: 'Place phone at hip height, 6–8 ft away. Your full body (head to feet) must be visible.' },
  'Deadlift':        { icon: '↔', view: 'Side view', tip: 'Place phone at hip height, 6–8 ft away. Face to the side — full body visible.' },
  'Bench Press':     { icon: '↔', view: 'Side view', tip: 'Place phone at bench height, perpendicular to your body. Ask someone to hold it, or use a tripod.' },
  'Overhead Press':  { icon: '↕', view: 'Front or side view', tip: 'Place phone at chest height, 5–6 ft away. Full body visible from head to feet.' },
  'Bicep Curl':      { icon: '⬆', view: 'Front view', tip: 'Place phone at chest height facing you. Upper body (shoulder to wrist) must be visible.' },
  'Push-ups':        { icon: '↔', view: 'Side view', tip: 'Place phone on the floor or low surface, 4–6 ft to your side. Full body visible.' },
};

function onFormExChange(val) {
  formExercise = val;
  updateAngleHint(val);
}

function updateAngleHint(ex) {
  const el   = document.getElementById('fc-angle-hint');
  const hint = FORM_ANGLE_HINTS[ex];
  if (!el || !hint) return;
  el.innerHTML = `
    <span class="fc-hint-view">${hint.icon} ${hint.view}</span>
    <span class="fc-hint-tip">${hint.tip}</span>
  `;
}

// ── Angle between three landmarks (degrees at vertex b) ──
function calcAngle(a, b, c) {
  const ab = { x: a.x - b.x, y: a.y - b.y };
  const cb = { x: c.x - b.x, y: c.y - b.y };
  const dot = ab.x * cb.x + ab.y * cb.y;
  const mag = Math.sqrt(ab.x ** 2 + ab.y ** 2) * Math.sqrt(cb.x ** 2 + cb.y ** 2);
  if (mag < 0.0001) return 0;
  return Math.acos(Math.min(1, Math.max(-1, dot / mag))) * (180 / Math.PI);
}

// Pick left or right side based on which has better landmark visibility
function betterSide(lm, leftIdx, rightIdx) {
  return (lm[leftIdx]?.visibility || 0) >= (lm[rightIdx]?.visibility || 0) ? 'left' : 'right';
}

function analyzeForm(lm) {
  const issues = [];
  const tips   = [];
  const ex     = formExercise;

  // Reject if key landmarks aren't visible enough
  const keyIdxs = { Squat: [23,25,27], Deadlift: [11,23,25], 'Bench Press': [11,13,15],
    'Overhead Press': [11,13,15], 'Bicep Curl': [11,13,15], 'Push-ups': [11,23,27] }[ex] || [11,23];
  const avgVis = keyIdxs.reduce((s, i) => s + (lm[i]?.visibility || 0), 0) / keyIdxs.length;
  if (avgVis < 0.4) {
    return { issues: [], tips: ['Step back so your full body is visible'] };
  }

  if (ex === 'Squat') {
    const s        = betterSide(lm, 25, 26);
    const hip      = lm[s === 'left' ? 23 : 24];
    const knee     = lm[s === 'left' ? 25 : 26];
    const ankle    = lm[s === 'left' ? 27 : 28];
    const shoulder = lm[s === 'left' ? 11 : 12];

    const kneeAngle = calcAngle(hip, knee, ankle);
    if (kneeAngle > 130) {
      tips.push('Standing — squat down for analysis');
    } else if (kneeAngle > 100) {
      issues.push(`Squat deeper — knee at ${Math.round(kneeAngle)}° (target ≤ 90°)`);
    } else {
      tips.push(`Good depth — knee at ${Math.round(kneeAngle)}°`);
    }

    // Forward lean: angle of torso from vertical
    const lean = Math.abs(Math.atan2(shoulder.x - hip.x, hip.y - shoulder.y) * 180 / Math.PI);
    if (lean > 50) issues.push('Torso leaning too far forward — chest up');

    // Knee cave: knee drifting inward past ankle
    const cave = s === 'left' ? ankle.x - knee.x : knee.x - ankle.x;
    if (cave > 0.04) issues.push(`${s === 'left' ? 'Left' : 'Right'} knee caving in — push knees out`);
  }

  else if (ex === 'Deadlift') {
    const s        = betterSide(lm, 25, 26);
    const shoulder = lm[s === 'left' ? 11 : 12];
    const hip      = lm[s === 'left' ? 23 : 24];
    const knee     = lm[s === 'left' ? 25 : 26];

    const backAngle = calcAngle(shoulder, hip, knee);
    if (backAngle < 130) {
      issues.push(`Back rounding — keep spine neutral (${Math.round(backAngle)}°)`);
    } else {
      tips.push('Back position looks neutral');
    }

    const neckAngle = calcAngle(lm[0], shoulder, hip);
    if (neckAngle < 130) issues.push('Head dropping — keep neck in neutral position');
  }

  else if (ex === 'Bench Press') {
    const s        = betterSide(lm, 13, 14);
    const shoulder = lm[s === 'left' ? 11 : 12];
    const elbow    = lm[s === 'left' ? 13 : 14];
    const wrist    = lm[s === 'left' ? 15 : 16];

    const elbowAngle = calcAngle(shoulder, elbow, wrist);
    if (elbowAngle > 100) {
      issues.push('Elbows too flared — tuck them to 45–75°');
    } else if (elbowAngle < 70) {
      tips.push(`Good bar position — elbow at ${Math.round(elbowAngle)}°`);
    } else {
      tips.push('Lowering — keep elbows at 45–75°');
    }

    if (wrist.y > elbow.y + 0.05) issues.push('Wrists bending back — keep them straight over the bar');
    tips.push('Tip: side-view camera gives best bench analysis');
  }

  else if (ex === 'Overhead Press') {
    const s        = betterSide(lm, 13, 14);
    const shoulder = lm[s === 'left' ? 11 : 12];
    const elbow    = lm[s === 'left' ? 13 : 14];
    const wrist    = lm[s === 'left' ? 15 : 16];
    const hip      = lm[s === 'left' ? 23 : 24];
    const knee     = lm[s === 'left' ? 25 : 26];

    const elbowAngle = calcAngle(shoulder, elbow, wrist);
    if (elbowAngle > 160) {
      tips.push('Arms fully extended — great lockout!');
    } else if (elbowAngle < 100) {
      tips.push(`Pressing — extend fully at top (${Math.round(elbowAngle)}°)`);
    } else {
      issues.push(`Arms not locked out — ${Math.round(elbowAngle)}° (target: 160°+)`);
    }

    const backAngle = calcAngle(shoulder, hip, knee);
    if (backAngle < 150) issues.push('Lower back arching — brace your core');
  }

  else if (ex === 'Bicep Curl') {
    const s        = betterSide(lm, 13, 14);
    const shoulder = lm[s === 'left' ? 11 : 12];
    const elbow    = lm[s === 'left' ? 13 : 14];
    const wrist    = lm[s === 'left' ? 15 : 16];

    const curlAngle = calcAngle(shoulder, elbow, wrist);
    if (curlAngle < 50)       tips.push('Fully curled — good top position!');
    else if (curlAngle > 160) tips.push('Fully extended — good starting position');
    else                      tips.push(`Curling — ${Math.round(curlAngle)}°`);

    const drift = Math.abs(elbow.x - shoulder.x);
    if (drift > 0.12) issues.push('Elbow drifting — keep it tucked to your side');
    else              tips.push('Good elbow position');
  }

  else if (ex === 'Push-ups') {
    const s        = betterSide(lm, 25, 26);
    const shoulder = lm[s === 'left' ? 11 : 12];
    const elbow    = lm[s === 'left' ? 13 : 14];
    const wrist    = lm[s === 'left' ? 15 : 16];
    const hip      = lm[s === 'left' ? 23 : 24];
    const ankle    = lm[s === 'left' ? 27 : 28];

    const midY   = (shoulder.y + ankle.y) / 2;
    const hipDev = hip.y - midY;
    if (hipDev > 0.05)       issues.push('Hips sagging — keep body in a straight line');
    else if (hipDev < -0.05) issues.push('Hips too high (piked) — lower them');
    else                     tips.push('Body alignment looks straight');

    const elbowAngle = calcAngle(shoulder, elbow, wrist);
    if (elbowAngle > 140)     issues.push('Go lower — chest should nearly touch ground');
    else if (elbowAngle < 70) tips.push('Good depth!');
  }

  if (issues.length === 0 && tips.length === 0) tips.push('Looking good — keep it up!');

  // 'good' only when actively in a correct position (not just standing/waiting)
  const GOOD_PREFIXES = ['Good ', 'Arms fully', 'Fully curled', 'Back position', 'Body alignment', 'Great lockout'];
  let status = 'neutral';
  if (issues.length > 0) {
    status = 'bad';
  } else if (tips.length > 0 && tips.every(t => GOOD_PREFIXES.some(p => t.startsWith(p)))) {
    status = 'good';
  }

  return { issues, tips, status };
}

function onPoseResults(results, canvas) {
  const ctx = canvas.getContext('2d');
  canvas.width  = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!results.poseLandmarks) {
    renderFormFeedback([], ['No pose detected — position your full body in frame'], 'neutral');
    return;
  }

  drawConnectors(ctx, results.poseLandmarks, POSE_CONNECTIONS,
    { color: 'rgba(0,255,200,0.75)', lineWidth: 3 });
  drawLandmarks(ctx, results.poseLandmarks,
    { color: '#ff4444', lineWidth: 2, radius: 4 });

  const { issues, tips, status } = analyzeForm(results.poseLandmarks);
  renderFormFeedback(issues, tips, status);
}

function renderFormFeedback(issues, tips, status = 'neutral') {
  const el = document.getElementById('form-feedback');
  if (el) {
    let html = issues.map(m => `<div class="form-issue">⚠ ${esc(m)}</div>`).join('');
    html    += tips.map(m   => `<div class="form-tip">✓ ${esc(m)}</div>`).join('');
    el.innerHTML = html || '<div class="form-tip">Analyzing…</div>';
  }

  const badge = document.getElementById('fc-status');
  if (!badge) return;
  if (status === 'good') {
    badge.className = 'fc-status fc-status-good';
    badge.innerHTML = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  } else if (status === 'bad') {
    badge.className = 'fc-status fc-status-bad';
    badge.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  } else {
    badge.className = 'fc-status';
    badge.innerHTML = '';
  }
}
