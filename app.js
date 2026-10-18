'use strict';

/* ===== 設定値 ===== */
const STORAGE_KEY = 'bingo-state-v1';
const NUM_MIN = 1;                 // 入力できる最小値
const NUM_MAX = 99;                // 入力できる最大値
const DEFAULT_RANGE = { min: 1, max: 75 };
const SPIN_INTERVAL_MS = 60;       // 回転中に数字を切り替える間隔
const DECEL_STEPS = 12;            // 減速しながら止まるまでの切り替え回数
const DECEL_EXTRA_MS = 260;        // 減速の最後の1コマで追加される待ち時間
const CHARA_IMAGES = [             // ゲーム画面の背景に散りばめる画像
  'images/chara-1.png',
  'images/chara-2.png',
  'images/chara-3.png',
  'images/chara-4.png',
  'images/chara-5.png',
  'images/chara-6.png',
  'images/chara-7.png',
  'images/chara-8.png',
];
const CHARA_CELL_RATIO = 0.14;     // 背景の格子1マスの大きさ（画面の短い辺に対する割合）

/* ===== 状態 =====
 * game: 進行中のゲーム { min, max, drawn: 出た順の番号 } または null
 * sound: 効果音のオン・オフ
 */
let state = loadState();
let phase = 'idle';                // 'idle' | 'spinning' | 'stopping'
let spinTimer = null;
let decelTimer = null;

const $ = (id) => document.getElementById(id);
const el = {
  topView: $('top-view'),
  gameView: $('game-view'),
  form: $('range-form'),
  minInput: $('min-input'),
  maxInput: $('max-input'),
  rangeError: $('range-error'),
  resumeBtn: $('resume-btn'),
  resumeInfo: $('resume-info'),
  backBtn: $('back-btn'),
  soundBtn: $('sound-btn'),
  roulette: $('roulette'),
  rouletteNumber: $('roulette-number'),
  remaining: $('remaining'),
  spinBtn: $('spin-btn'),
  history: $('history'),
  historyEmpty: $('history-empty'),
  drawnCount: $('drawn-count'),
  bgCharas: $('bg-charas'),
};

/* ===== 保存・読み込み ===== */
function loadState() {
  const fallback = { game: null, sound: true };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const data = JSON.parse(raw);
    return {
      game: isValidGame(data.game) ? data.game : null,
      sound: data.sound !== false,
    };
  } catch {
    return fallback;
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 保存できない環境（プライベートモード等）でも、ゲーム自体は続けられる
  }
}

function isValidGame(g) {
  return g && Number.isInteger(g.min) && Number.isInteger(g.max) &&
    g.min >= NUM_MIN && g.max <= NUM_MAX && g.min <= g.max &&
    Array.isArray(g.drawn) && g.drawn.every((n) => Number.isInteger(n) && n >= g.min && n <= g.max);
}

/* ===== 抽選 ===== */
// 0 以上 n 未満の整数を偏りなく返す（暗号論的乱数＋棄却法）
function randomInt(n) {
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  do {
    crypto.getRandomValues(buf);
  } while (buf[0] >= limit);
  return buf[0] % n;
}

// まだ出ていない番号の一覧
function remainingNumbers() {
  const { min, max, drawn } = state.game;
  const used = new Set(drawn);
  const list = [];
  for (let n = min; n <= max; n++) {
    if (!used.has(n)) list.push(n);
  }
  return list;
}

/* ===== 効果音（Web Audio API で合成） ===== */
let audioCtx = null;
let noiseBuffer = null;

function getAudio() {
  if (!state.sound) return null;
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtx = new AC();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// ドラムロールの1打（短いノイズ）
function playTick() {
  const ctx = getAudio();
  if (!ctx) return;
  if (!noiseBuffer) {
    noiseBuffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.08), ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 260;
  filter.Q.value = 0.9;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.7, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
  src.connect(filter).connect(gain).connect(ctx.destination);
  src.start(t);
  src.stop(t + 0.08);
}

// 決定音（ド・ミ・ソ・ドの和音を順に鳴らす）
function playChime() {
  const ctx = getAudio();
  if (!ctx) return;
  const t0 = ctx.currentTime;
  [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
    const t = t0 + i * 0.08;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.95);
  });
}

/* ===== トップ画面 ===== */
// 全角数字も受け付け、整数に変換する。不正なら null
function parseNumber(value) {
  const half = value.trim().replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  if (!/^\d+$/.test(half)) return null;
  return Number(half);
}

function validateRange() {
  const minRaw = el.minInput.value;
  const maxRaw = el.maxInput.value;
  const min = parseNumber(minRaw);
  const max = parseNumber(maxRaw);
  let error = '';
  let bad = [];

  if (!minRaw.trim() || !maxRaw.trim()) {
    error = '最小と最大の両方を入力してください';
    bad = [!minRaw.trim() && el.minInput, !maxRaw.trim() && el.maxInput];
  } else if (min === null || max === null) {
    error = '整数で入力してください';
    bad = [min === null && el.minInput, max === null && el.maxInput];
  } else if (min < NUM_MIN || min > NUM_MAX || max < NUM_MIN || max > NUM_MAX) {
    error = `${NUM_MIN}〜${NUM_MAX} の範囲で入力してください`;
    bad = [(min < NUM_MIN || min > NUM_MAX) && el.minInput, (max < NUM_MIN || max > NUM_MAX) && el.maxInput];
  } else if (min > max) {
    error = '最小は最大以下の数にしてください';
    bad = [el.minInput, el.maxInput];
  }

  el.rangeError.textContent = error;
  [el.minInput, el.maxInput].forEach((input) => {
    input.setAttribute('aria-invalid', bad.includes(input) ? 'true' : 'false');
  });
  return error ? null : { min, max };
}

function renderTop() {
  const range = state.game || DEFAULT_RANGE;
  el.minInput.value = range.min;
  el.maxInput.value = range.max;
  el.rangeError.textContent = '';
  el.minInput.setAttribute('aria-invalid', 'false');
  el.maxInput.setAttribute('aria-invalid', 'false');

  const g = state.game;
  el.resumeBtn.hidden = !g;
  el.resumeInfo.hidden = !g;
  if (g) {
    el.resumeInfo.textContent = `前回のゲーム：${g.min}〜${g.max}（${g.drawn.length}個 出ています）`;
  }
}

el.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const range = validateRange();
  if (!range) return;
  if (state.game && state.game.drawn.length > 0 &&
      !confirm('前回のゲームの記録は消えます。新しく始めますか？')) {
    return;
  }
  state.game = { min: range.min, max: range.max, drawn: [] };
  saveState();
  goTo('game');
});

el.resumeBtn.addEventListener('click', () => goTo('game'));

/* ===== ゲーム画面 ===== */
function renderSoundBtn() {
  el.soundBtn.textContent = state.sound ? '🔊 音あり' : '🔇 音なし';
  el.soundBtn.setAttribute('aria-pressed', String(state.sound));
}

function renderStatus() {
  const left = remainingNumbers().length;
  const finished = left === 0;
  el.remaining.textContent = finished ? '全部の番号が出ました！' : `残り ${left} 個`;

  el.spinBtn.classList.toggle('is-stop', phase === 'spinning');
  el.spinBtn.textContent = finished ? 'おしまい' : phase === 'spinning' ? 'ストップ' : 'スタート';
  el.spinBtn.disabled = finished || phase === 'stopping';
  el.backBtn.disabled = phase !== 'idle';
}

function addHistoryItem(n, isNew) {
  const li = document.createElement('li');
  li.textContent = n;
  if (isNew) li.classList.add('is-new');
  el.history.appendChild(li);
}

function renderHistory() {
  el.history.replaceChildren();
  state.game.drawn.forEach((n) => addHistoryItem(n, false));
  updateHistoryMeta();
}

function updateHistoryMeta() {
  const count = state.game.drawn.length;
  const total = state.game.max - state.game.min + 1;
  el.drawnCount.textContent = `（${count} / ${total}）`;
  el.historyEmpty.hidden = count > 0;
}

// 背景にキャラクターをランダムに散りばめる。
// 画面を格子に分けて各マスに1体ずつ置くことで、偏らずに全体へ散らばるようにする
function scatterCharas() {
  const { innerWidth: w, innerHeight: h } = window;
  const cell = Math.min(w, h) * CHARA_CELL_RATIO;
  const cols = Math.max(1, Math.round(w / cell));
  const rows = Math.max(1, Math.round(h / cell));
  const order = [...CHARA_IMAGES].sort(() => Math.random() - 0.5);
  const rand = (min, max) => min + Math.random() * (max - min);

  const imgs = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const img = document.createElement('img');
      img.className = 'bg-chara';
      img.src = order[imgs.length % order.length];
      img.alt = '';
      img.style.left = `${((c + rand(0.2, 0.8)) / cols) * 100}%`;
      img.style.top = `${((r + rand(0.2, 0.8)) / rows) * 100}%`;
      img.style.width = `${rand(8, 11)}vmin`;
      img.style.rotate = `${rand(-20, 20)}deg`;
      imgs.push(img);
    }
  }
  el.bgCharas.replaceChildren(...imgs);
}

function renderGame() {
  scatterCharas();
  const last = state.game.drawn[state.game.drawn.length - 1];
  el.rouletteNumber.textContent = last ?? '?';
  el.roulette.classList.remove('spinning', 'decided');
  renderSoundBtn();
  renderHistory();
  renderStatus();
}

// 回転中の表示用に、残りの番号からランダムに1つ選ぶ（直前と同じ数字はなるべく避ける）
function showRandomNumber(pool) {
  const current = el.rouletteNumber.textContent;
  let n = pool[randomInt(pool.length)];
  if (pool.length > 1 && String(n) === current) {
    n = pool[(pool.indexOf(n) + 1) % pool.length];
  }
  el.rouletteNumber.textContent = n;
}

function startSpin() {
  const pool = remainingNumbers();
  if (pool.length === 0) return;
  phase = 'spinning';
  el.roulette.classList.remove('decided');
  el.roulette.classList.add('spinning');
  spinTimer = setInterval(() => {
    showRandomNumber(pool);
    playTick();
  }, SPIN_INTERVAL_MS);
  renderStatus();
}

function stopSpin() {
  clearInterval(spinTimer);
  spinTimer = null;
  phase = 'stopping';
  renderStatus();

  const pool = remainingNumbers();
  const result = pool[randomInt(pool.length)];   // 当選番号はここで確定

  // 少しずつ間隔を広げて減速し、最後のコマで当選番号を表示する
  let step = 0;
  const next = () => {
    step++;
    if (step >= DECEL_STEPS) {
      el.rouletteNumber.textContent = result;
      finishDraw(result);
      return;
    }
    showRandomNumber(pool);
    playTick();
    const progress = step / DECEL_STEPS;
    decelTimer = setTimeout(next, SPIN_INTERVAL_MS + DECEL_EXTRA_MS * progress * progress);
  };
  decelTimer = setTimeout(next, SPIN_INTERVAL_MS);
}

function finishDraw(result) {
  decelTimer = null;
  phase = 'idle';
  state.game.drawn.push(result);
  saveState();

  el.roulette.classList.remove('spinning');
  void el.roulette.offsetWidth;               // アニメーションを毎回再生させる
  el.roulette.classList.add('decided');
  addHistoryItem(result, true);
  updateHistoryMeta();
  renderStatus();
  playChime();
}

// 画面を離れるときに回転を中断する（結果は記録しない）
function cancelSpin() {
  clearInterval(spinTimer);
  clearTimeout(decelTimer);
  spinTimer = null;
  decelTimer = null;
  phase = 'idle';
}

el.spinBtn.addEventListener('click', () => {
  if (phase === 'idle') startSpin();
  else if (phase === 'spinning') stopSpin();
});

el.soundBtn.addEventListener('click', () => {
  state.sound = !state.sound;
  saveState();
  renderSoundBtn();
});

el.backBtn.addEventListener('click', () => goTo('top'));

/* ===== 画面切り替え（ハッシュで管理し、再読み込みしても同じ画面に戻る） ===== */
function goTo(view) {
  const hash = view === 'game' ? '#/game' : '#/';
  if (location.hash === hash) route();
  else location.hash = hash;
}

function route() {
  cancelSpin();
  const wantsGame = location.hash === '#/game' && state.game;
  el.topView.hidden = !!wantsGame;
  el.gameView.hidden = !wantsGame;
  if (wantsGame) renderGame();
  else renderTop();
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);
route();
