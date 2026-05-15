// SRS暗記アプリ — FSRS-5 ベース
// ts-fsrs を esm.sh 経由でロード（ビルド不要）
import { fsrs, generatorParameters, Rating, State, createEmptyCard } from 'https://esm.sh/ts-fsrs@4';

const STORAGE_KEY = 'srs-app-state-v1';
const CARDS_URL = './cards.json';

// FSRS インスタンス（既定パラメータ）
const params = generatorParameters({ enable_fuzz: true });
const f = fsrs(params);

// ─── State ─────────────────────────────
let state = {
  cards: [],          // 全カード
  meta: {
    created_at: null,
    last_updated: null,
    schema_version: 1
  }
};

let currentCardId = null;          // 表示中のカード
let pendingReview = null;          // { rating: null } のような未送信レビューはなし、ボタン押下時即確定
let selectedCardReview = null;     // ボタン選択中のカード評価ラベル
let queue = [];                    // 今日処理すべきカード id 配列

// ─── DOM ───────────────────────────────
const $ = (id) => document.getElementById(id);

const el = {
  main: $('main'),
  cardArea: $('card-area'),
  cardMeta: $('card-meta'),
  cardFront: $('card-front'),
  cardBack: $('card-back'),
  showArea: $('show-area'),
  btnShow: $('btn-show'),
  gradeArea: $('grade-area'),
  reviewGrid: document.querySelector('.review-grid'),
  comment: $('comment'),
  selectionCaption: $('selection-caption'),
  doneArea: $('done-area'),
  upcoming: $('upcoming'),
  statRemaining: $('stat-remaining'),
  statDone: $('stat-done'),
  statTotal: $('stat-total'),
  btnExport: $('btn-export'),
  fileImport: $('file-import'),
  btnReset: $('btn-reset'),
};

// ─── Storage ───────────────────────────
function saveState() {
  state.meta.last_updated = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error('localStorage parse error:', e);
    return null;
  }
}

async function fetchInitialCards() {
  const res = await fetch(CARDS_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`cards.json fetch failed: ${res.status}`);
  return await res.json();
}

async function initState() {
  const saved = loadState();
  if (saved && Array.isArray(saved.cards) && saved.cards.length > 0) {
    state = saved;
  } else {
    const cards = await fetchInitialCards();
    state = {
      cards,
      meta: {
        created_at: new Date().toISOString(),
        last_updated: new Date().toISOString(),
        schema_version: 1
      }
    };
    saveState();
  }
}

// ─── Queue ─────────────────────────────
function buildQueue() {
  const now = new Date();
  queue = state.cards
    .filter(c => new Date(c.fsrs.due) <= now)
    .sort((a, b) => new Date(a.fsrs.due) - new Date(b.fsrs.due))
    .map(c => c.id);
}

function getCard(id) {
  return state.cards.find(c => c.id === id);
}

// ─── FSRS Integration ─────────────────
// state.fsrs.state は数値 (0:New, 1:Learning, 2:Review, 3:Relearning)
// last_review は ISO string
function toFsrsCard(c) {
  const empty = createEmptyCard(new Date(c.fsrs.due || Date.now()));
  // 保存済みフィールドで上書き
  empty.due = new Date(c.fsrs.due);
  empty.stability = c.fsrs.stability || 0;
  empty.difficulty = c.fsrs.difficulty || 0;
  empty.elapsed_days = c.fsrs.elapsed_days || 0;
  empty.scheduled_days = c.fsrs.scheduled_days || 0;
  empty.reps = c.fsrs.reps || 0;
  empty.lapses = c.fsrs.lapses || 0;
  empty.state = c.fsrs.state ?? State.New;
  empty.last_review = c.fsrs.last_review ? new Date(c.fsrs.last_review) : undefined;
  return empty;
}

function fromFsrsCard(fc) {
  return {
    due: (fc.due instanceof Date) ? fc.due.toISOString() : new Date(fc.due).toISOString(),
    stability: fc.stability,
    difficulty: fc.difficulty,
    elapsed_days: fc.elapsed_days,
    scheduled_days: fc.scheduled_days,
    reps: fc.reps,
    lapses: fc.lapses,
    state: fc.state,
    last_review: fc.last_review ? (fc.last_review instanceof Date ? fc.last_review.toISOString() : new Date(fc.last_review).toISOString()) : null,
  };
}

function applyRating(card, ratingValue) {
  const now = new Date();
  const fc = toFsrsCard(card);
  // ts-fsrs v4: f.repeat(card, now) returns { [Rating.Again]: {...}, [Rating.Hard]: ... }
  const schedules = f.repeat(fc, now);
  const result = schedules[ratingValue];
  if (!result) {
    console.error('No schedule for rating', ratingValue, schedules);
    return null;
  }
  return result.card;
}

// ─── Render ────────────────────────────
function ratingLabel(r) {
  return { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' }[r] || 'Unknown';
}

function updateStats() {
  const total = state.cards.length;
  const remaining = queue.length;
  const done = total - remaining;
  el.statTotal.textContent = total;
  el.statRemaining.textContent = remaining;
  el.statDone.textContent = done;
}

function resetSelections() {
  selectedCardReview = null;
  el.comment.value = '';
  document.querySelectorAll('.btn-review.selected').forEach(b => b.classList.remove('selected'));
}

function showCard(id) {
  const card = getCard(id);
  if (!card) {
    showDone();
    return;
  }
  currentCardId = id;
  el.cardMeta.innerHTML = (card.tags || []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('');
  el.cardFront.textContent = card.front;
  el.cardBack.textContent = card.back;
  el.cardBack.classList.add('hidden');
  el.showArea.classList.remove('hidden');
  el.gradeArea.classList.add('hidden');
  el.doneArea.classList.add('hidden');
  el.cardArea.classList.remove('hidden');
  resetSelections();
  updateStats();
}

function showAnswer() {
  el.cardBack.classList.remove('hidden');
  el.showArea.classList.add('hidden');
  el.gradeArea.classList.remove('hidden');
}

function showDone() {
  el.cardArea.classList.add('hidden');
  el.doneArea.classList.remove('hidden');
  // 直近5枚の次回出題予定
  const upcoming = [...state.cards]
    .sort((a, b) => new Date(a.fsrs.due) - new Date(b.fsrs.due))
    .slice(0, 5);
  el.upcoming.innerHTML = upcoming.map(c => {
    const d = new Date(c.fsrs.due);
    const dstr = d.toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    return `<li>${dstr} — ${escapeHtml(c.front.slice(0, 40))}${c.front.length > 40 ? '…' : ''}</li>`;
  }).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

// ─── Handlers ──────────────────────────
function handleShow() {
  showAnswer();
}

function handleGrade(ratingValue) {
  if (!currentCardId) return;
  const card = getCard(currentCardId);
  if (!card) return;

  const updatedFc = applyRating(card, ratingValue);
  if (!updatedFc) return;

  card.fsrs = fromFsrsCard(updatedFc);
  card.review_history = card.review_history || [];
  card.review_history.push({
    at: new Date().toISOString(),
    rating: ratingLabel(ratingValue),
    card_review: selectedCardReview,
    comment: el.comment.value.trim() || null
  });

  saveState();
  // キューから取り除き次へ
  queue.shift();
  if (queue.length === 0) {
    updateStats();
    showDone();
  } else {
    showCard(queue[0]);
  }
}

function handleCardReview(label, btn) {
  // トグル選択
  if (selectedCardReview === label) {
    selectedCardReview = null;
    btn.classList.remove('selected');
  } else {
    selectedCardReview = label;
    document.querySelectorAll('.btn-review.selected').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
  }
}

function handleExport() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = url;
  a.download = `srs-export-${ts}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function handleImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const imported = JSON.parse(ev.target.result);
      if (!imported || !Array.isArray(imported.cards)) {
        alert('不正なファイル形式です（cards 配列がありません）。');
        return;
      }
      if (!confirm('現在のデータを上書きします。よろしいですか？')) return;
      state = imported;
      saveState();
      buildQueue();
      if (queue.length === 0) showDone();
      else showCard(queue[0]);
    } catch (err) {
      alert('インポートに失敗しました: ' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

async function handleReset() {
  if (!confirm('全データを削除して初期化します。よろしいですか？')) return;
  localStorage.removeItem(STORAGE_KEY);
  await initState();
  buildQueue();
  if (queue.length === 0) showDone();
  else showCard(queue[0]);
}

// ─── Wire up ───────────────────────────
function attachEvents() {
  el.btnShow.addEventListener('click', handleShow);

  document.querySelectorAll('.btn-grade').forEach(btn => {
    btn.addEventListener('click', () => {
      const r = parseInt(btn.dataset.rating, 10);
      handleGrade(r);
    });
  });

  document.querySelectorAll('.btn-review').forEach(btn => {
    btn.addEventListener('click', () => handleCardReview(btn.dataset.review, btn));
  });

  el.btnExport.addEventListener('click', handleExport);
  el.fileImport.addEventListener('change', handleImport);
  el.btnReset.addEventListener('click', handleReset);

  // キーボードショートカット（PC向け）
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (el.gradeArea.classList.contains('hidden')) {
      if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        handleShow();
      }
    } else {
      if (e.key === '1') handleGrade(1);
      else if (e.key === '2') handleGrade(2);
      else if (e.key === '3') handleGrade(3);
      else if (e.key === '4') handleGrade(4);
    }
  });
}

// ─── Boot ──────────────────────────────
(async function main() {
  try {
    await initState();
    buildQueue();
    attachEvents();
    if (queue.length === 0) {
      updateStats();
      showDone();
    } else {
      showCard(queue[0]);
    }
  } catch (err) {
    console.error(err);
    el.cardFront.textContent = '初期化に失敗しました: ' + err.message;
  }
})();
