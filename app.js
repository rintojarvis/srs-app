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
  mistakes: [],       // 演習フィードバック: { id, at, text, tags, source, hit_card_ids, status }
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
let activeTab = 'review';          // 'review' | 'mistake' | 'proposal'

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
  statMistakes: $('stat-mistakes'),
  btnExport: $('btn-export'),
  fileImport: $('file-import'),
  btnReset: $('btn-reset'),
  tabbar: $('tabbar'),
  mistakeArea: $('mistake-area'),
  proposalArea: $('proposal-area'),
  mistakeText: $('mistake-text'),
  mistakeTags: $('mistake-tags'),
  mistakeSource: $('mistake-source'),
  btnMistakeSubmit: $('btn-mistake-submit'),
  mistakeFlash: $('mistake-flash'),
  mistakeList: $('mistake-list'),
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
    // migration: 旧 schema に mistakes が無い場合は付与
    if (!Array.isArray(state.mistakes)) state.mistakes = [];
  } else {
    const cards = await fetchInitialCards();
    state = {
      cards,
      mistakes: [],
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
  const openMistakes = (state.mistakes || []).filter(m => m.status === 'open').length;
  if (el.statMistakes) el.statMistakes.textContent = openMistakes;
}

// ─── Tabs ──────────────────────────────
function renderTab(tabName) {
  activeTab = tabName;
  // ボタン状態
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  // 各セクションの可視性
  const showReview = tabName === 'review';
  const showMistake = tabName === 'mistake';
  const showProposal = tabName === 'proposal';

  // review タブのときだけカード/done を出す。それ以外は両方とも隠す
  if (showReview) {
    if (queue.length === 0) {
      el.cardArea.classList.add('hidden');
      el.doneArea.classList.remove('hidden');
    } else {
      el.cardArea.classList.remove('hidden');
      el.doneArea.classList.add('hidden');
    }
  } else {
    el.cardArea.classList.add('hidden');
    el.doneArea.classList.add('hidden');
  }
  el.mistakeArea.classList.toggle('hidden', !showMistake);
  el.proposalArea.classList.toggle('hidden', !showProposal);

  if (showMistake) {
    refreshMistakeSourceOptions();
    renderMistakeList();
  }
}

// ─── Mistake feedback ─────────────────
function getUniqueSources() {
  const set = new Set();
  for (const c of state.cards) {
    if (c.source) set.add(c.source);
  }
  return [...set].sort();
}

function refreshMistakeSourceOptions() {
  if (!el.mistakeSource) return;
  const current = el.mistakeSource.value;
  const sources = getUniqueSources();
  const opts = ['<option value="">関連 source（任意・全カードから選択）</option>']
    .concat(sources.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`));
  el.mistakeSource.innerHTML = opts.join('');
  if (current) el.mistakeSource.value = current;
}

function findRelatedCardIds(text, tags, source) {
  const tagSet = new Set(tags.map(t => t.toLowerCase()).filter(Boolean));
  const hits = [];
  for (const c of state.cards) {
    let match = false;
    if (source && c.source === source) match = true;
    if (!match && tagSet.size > 0 && Array.isArray(c.tags)) {
      if (c.tags.some(t => tagSet.has(String(t).toLowerCase()))) match = true;
    }
    if (match) hits.push(c.id);
  }
  return hits;
}

function showMistakeFlash(message, kind) {
  if (!el.mistakeFlash) return;
  el.mistakeFlash.textContent = message;
  el.mistakeFlash.classList.remove('hidden', 'ok', 'warn');
  el.mistakeFlash.classList.add(kind === 'warn' ? 'warn' : 'ok');
  setTimeout(() => {
    el.mistakeFlash.classList.add('hidden');
  }, 5000);
}

function renderMistakeList() {
  if (!el.mistakeList) return;
  const items = (state.mistakes || []).slice().sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10);
  if (items.length === 0) {
    el.mistakeList.innerHTML = '<li><span class="caption">まだ登録はありません。</span></li>';
    return;
  }
  el.mistakeList.innerHTML = items.map(m => {
    const head = escapeHtml(String(m.text).slice(0, 60));
    const tail = String(m.text).length > 60 ? '…' : '';
    const d = new Date(m.at).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const hits = (m.hit_card_ids || []).length;
    return `<li>
      <div><strong>${escapeHtml(m.id)}</strong> — ${head}${tail}</div>
      <div class="mistake-meta">
        <span>${d}</span>
        <span>関連カード ${hits} 件</span>
        <span>${escapeHtml(m.status || 'open')}</span>
      </div>
    </li>`;
  }).join('');
}

function pushToFrontOfQueue(cardIds) {
  // 重複排除しつつ、cardIds を先頭に、その後に既存 queue（cardIds に含まれないもの）を続ける
  const seen = new Set();
  const next = [];
  for (const id of cardIds) {
    if (!seen.has(id) && state.cards.some(c => c.id === id)) {
      seen.add(id);
      next.push(id);
    }
  }
  for (const id of queue) {
    if (!seen.has(id)) {
      seen.add(id);
      next.push(id);
    }
  }
  queue = next;
}

function handleMistakeSubmit() {
  const text = (el.mistakeText.value || '').trim();
  const tagsRaw = (el.mistakeTags.value || '').trim();
  const source = (el.mistakeSource.value || '').trim() || null;
  if (!text) {
    showMistakeFlash('テキストを入力してください', 'warn');
    return;
  }
  const tags = tagsRaw ? tagsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  const hitIds = findRelatedCardIds(text, tags, source);
  const entry = {
    id: 'mistake_' + Date.now(),
    at: new Date().toISOString(),
    text,
    tags,
    source,
    hit_card_ids: hitIds,
    status: 'open'
  };
  state.mistakes.push(entry);
  saveState();

  if (hitIds.length > 0) {
    pushToFrontOfQueue(hitIds);
    showMistakeFlash(`登録しました。${hitIds.length} 件のカードを優先キュー先頭に追加しました。`, 'ok');
    if (activeTab === 'review') {
      // 現在表示中のカードを優先カードに切替（先頭が変わっているなら）
      if (queue.length > 0 && queue[0] !== currentCardId) {
        showCard(queue[0]);
      }
    }
  } else {
    showMistakeFlash('関連カードなし。次回 evolve.ps1 で AI が新規カード生成を試みます。', 'warn');
  }

  // フォームクリア
  el.mistakeText.value = '';
  el.mistakeTags.value = '';
  el.mistakeSource.value = '';
  renderMistakeList();
  updateStats();
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
  if (activeTab === 'review') {
    el.cardArea.classList.remove('hidden');
  }
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
  if (activeTab === 'review') {
    el.doneArea.classList.remove('hidden');
  }
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

  // タブ切替
  if (el.tabbar) {
    el.tabbar.addEventListener('click', (e) => {
      const btn = e.target.closest('.tab-btn');
      if (!btn) return;
      renderTab(btn.dataset.tab);
    });
  }
  // 演習入力フォーム
  if (el.btnMistakeSubmit) {
    el.btnMistakeSubmit.addEventListener('click', handleMistakeSubmit);
  }

  // キーボードショートカット（PC向け）
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if (activeTab !== 'review') return;
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
    renderTab('review');
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
