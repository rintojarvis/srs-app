// SRS暗記アプリ — FSRS-5 ベース
// ts-fsrs を esm.sh 経由でロード（ビルド不要）
import { fsrs, generatorParameters, Rating, State, createEmptyCard } from 'https://esm.sh/ts-fsrs@4';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase/config.js';

const STORAGE_KEY = 'srs-app-state-v1';
const CARDS_URL = './cards.json';
const IMPORTED_SOURCES_URL = './imported_sources.json';

// ─── Supabase Client ──────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

// FSRS インスタンス（既定パラメータ）
const params = generatorParameters({ enable_fuzz: true });
const f = fsrs(params);

// ─── State ─────────────────────────────
let state = {
  cards: [],          // 全カード
  mistakes: [],       // 演習フィードバック: { id, at, text, tags, source, hit_card_ids, status }
  checkins: [],       // 日次チェックイン: { date, calendar_confirmations, manual_entries, at, ... 旧フィールド互換 }
  imported_sources: [], // ローカルにキャッシュした最近のソース一覧（imported_sources.json と同期）
  today_events: [],   // ローカルにキャッシュした今日の予定（today.json と同期）
  sync: {
    last_pull_at: 0,    // unix ms
    pending_pushes: [], // { table, row, at }
    user_id: null,
    user_email: null,
    online: typeof navigator !== 'undefined' ? navigator.onLine : true
  },
  meta: {
    created_at: null,
    last_updated: null,
    schema_version: 1
  }
};

// ─── 9 科目の確定リスト ─────────────────
const SUBJECTS = ['憲法', '民法', '刑法', '商法', '民事訴訟法', '刑事訴訟法', '行政法', '倒産法', '法学入門'];

// カレンダー summary → subject 推定マップ
function detectSubjectFromSummary(summary) {
  const s = String(summary || '');
  if (!s) return null;
  // 順序重要: より長い・より具体的なものを先に
  if (/民事訴訟法|民訴/.test(s)) return '民事訴訟法';
  if (/刑事訴訟法|刑訴/.test(s)) return '刑事訴訟法';
  if (/憲法入門|憲法/.test(s)) return '憲法';
  if (/民法入門|物権|債権|民法/.test(s)) return '民法';
  if (/刑法入門|刑法/.test(s)) return '刑法';
  if (/行政法/.test(s)) return '行政法';
  if (/商法|会社法/.test(s)) return '商法';
  if (/倒産法|破産|民事再生/.test(s)) return '倒産法';
  if (/法学入門/.test(s)) return '法学入門';
  return null;
}

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
  checkinModal: $('checkin-modal'),
  btnCheckinSubmit: $('btn-checkin-submit'),
  btnCheckinSkip: $('btn-checkin-skip'),
  btnOpenCheckin: $('btn-open-checkin'),
  btnFetchToday: $('btn-fetch-today'),
  checkinFetchFlash: $('checkin-fetch-flash'),
  calendarEventsList: $('calendar-events-list'),
  calendarEventsEmpty: $('calendar-events-empty'),
  manualEntries: $('manual-entries'),
  btnAddManualEntry: $('btn-add-manual-entry'),
  tplManualEntry: $('tpl-manual-entry'),
  // Auth / sync
  authModal: $('auth-modal'),
  authEmail: $('auth-email'),
  authFlash: $('auth-flash'),
  btnAuthSend: $('btn-auth-send'),
  btnAuthSkip: $('btn-auth-skip'),
  authStatus: $('auth-status'),
  authStatusEmail: $('auth-status-email'),
  btnSignOut: $('btn-sign-out'),
  syncPending: $('sync-pending'),
  statPending: $('stat-pending'),
  btnExportUserid: $('btn-export-userid'),
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

async function fetchImportedSources() {
  try {
    const res = await fetch(IMPORTED_SOURCES_URL, { cache: 'no-store' });
    if (!res.ok) return [];
    const j = await res.json();
    return Array.isArray(j) ? j : [];
  } catch (e) {
    return [];
  }
}

async function refreshImportedSources() {
  const list = await fetchImportedSources();
  if (Array.isArray(list)) {
    state.imported_sources = list;
    saveState();
  }
}

async function initState() {
  const saved = loadState();
  if (saved && Array.isArray(saved.cards) && saved.cards.length > 0) {
    state = saved;
    // migration: 旧 schema に新フィールドが無ければ補完
    if (!Array.isArray(state.mistakes)) state.mistakes = [];
    if (!Array.isArray(state.checkins)) state.checkins = [];
    if (!Array.isArray(state.imported_sources)) state.imported_sources = [];
    if (!Array.isArray(state.today_events)) state.today_events = [];
    if (!state.sync || typeof state.sync !== 'object') {
      state.sync = {
        last_pull_at: 0,
        pending_pushes: [],
        user_id: null,
        user_email: null,
        online: typeof navigator !== 'undefined' ? navigator.onLine : true
      };
    }
    if (!Array.isArray(state.sync.pending_pushes)) state.sync.pending_pushes = [];
    if (typeof state.sync.last_pull_at !== 'number') state.sync.last_pull_at = 0;
  } else {
    const cards = await fetchInitialCards();
    state = {
      cards,
      mistakes: [],
      checkins: [],
      imported_sources: [],
      today_events: [],
      sync: {
        last_pull_at: 0,
        pending_pushes: [],
        user_id: null,
        user_email: null,
        online: typeof navigator !== 'undefined' ? navigator.onLine : true
      },
      meta: {
        created_at: new Date().toISOString(),
        last_updated: new Date().toISOString(),
        schema_version: 1
      }
    };
    saveState();
  }
  // 最新の imported_sources.json を必ず再フェッチして localStorage を更新する
  // （saved 経由でも初回でも、毎回再取得することで「最近のソース」が常に最新になる）
  await refreshImportedSources();
}

// ─── Queue ─────────────────────────────
function todayDateStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getTodayCheckin() {
  const today = todayDateStr();
  if (!Array.isArray(state.checkins)) return null;
  return state.checkins.find(c => c.date === today) || null;
}

// 新スキーマと旧スキーマの両対応で「優先する subjects / topics / sources」を集約
function deriveCheckinSignals(checkin) {
  if (!checkin) return { subjects: [], topics: [], sources: [], itojuku: false };
  const subjects = new Set();
  const topics = [];
  const sources = new Set();
  let itojuku = false;

  // 新スキーマ: calendar_confirmations[]
  if (Array.isArray(checkin.calendar_confirmations)) {
    for (const cc of checkin.calendar_confirmations) {
      if (!cc) continue;
      if (cc.user_status === 'absent') continue; // 欠席はキューに反映しない
      if (cc.detected_subject) subjects.add(cc.detected_subject);
      if (cc.user_status === 'drifted' && cc.actual_topic) topics.push(cc.actual_topic);
    }
  }
  // 新スキーマ: manual_entries[]
  if (Array.isArray(checkin.manual_entries)) {
    for (const me of checkin.manual_entries) {
      if (!me) continue;
      if (Array.isArray(me.subjects)) for (const s of me.subjects) if (s) subjects.add(s);
      if (me.topic) topics.push(me.topic);
      if (me.source === 'itojuku') itojuku = true;
    }
  }
  // 旧スキーマ fallback
  if (subjects.size === 0 && Array.isArray(checkin.subjects)) {
    for (const s of checkin.subjects) if (s) subjects.add(s);
  }
  if (topics.length === 0 && typeof checkin.topic === 'string' && checkin.topic.trim()) {
    topics.push(checkin.topic.trim());
  }
  if (Array.isArray(checkin.sources)) for (const s of checkin.sources) if (s) sources.add(s);

  return { subjects: [...subjects], topics, sources: [...sources], itojuku };
}

function cardMatchesCheckin(card, checkin) {
  if (!checkin) return false;
  const sig = deriveCheckinSignals(checkin);

  // 科目タグ交差
  if (sig.subjects.length > 0 && Array.isArray(card.tags)) {
    for (const s of sig.subjects) {
      if (!s) continue;
      // 「民事訴訟法」⇔「民訴」両対応
      const alts = [s];
      if (s === '民事訴訟法') alts.push('民訴');
      if (s === '刑事訴訟法') alts.push('刑訴');
      for (const alt of alts) {
        if (card.tags.some(t => String(t).includes(alt))) return true;
      }
    }
  }
  // ソース完全一致（旧フィールド）
  if (sig.sources.length > 0 && card.source) {
    if (sig.sources.includes(card.source)) return true;
  }
  // 伊藤塾フラグ: card.source が「伊藤塾」を含むものを優先
  if (sig.itojuku && card.source && String(card.source).includes('伊藤塾')) {
    return true;
  }
  // トピック単語の部分一致（2文字以上のトークン）
  if (sig.topics.length > 0) {
    const haystack = [
      card.front || '',
      card.back || '',
      ...(Array.isArray(card.tags) ? card.tags : [])
    ].join(' ');
    for (const topic of sig.topics) {
      const tokens = String(topic).split(/[\s、,，・/]+/).map(s => s.trim()).filter(s => s.length >= 2);
      for (const tok of tokens) {
        if (haystack.includes(tok)) return true;
      }
    }
  }
  return false;
}

function buildQueue() {
  const now = new Date();
  const checkin = getTodayCheckin();

  // 全カードを「優先」「通常 due」の 2 グループに分ける
  const priorityIds = [];
  const dueIds = [];
  const seen = new Set();

  // 優先: チェックインにマッチするカード（New でも今日のキューに含める）
  if (checkin) {
    const matched = state.cards.filter(c => cardMatchesCheckin(c, checkin));
    // due ≤ 今日 を先頭、新規/未来 due はその後
    matched.sort((a, b) => new Date(a.fsrs.due) - new Date(b.fsrs.due));
    for (const c of matched) {
      if (!seen.has(c.id)) {
        seen.add(c.id);
        priorityIds.push(c.id);
      }
    }
  }

  // 通常 due
  const dueCards = state.cards
    .filter(c => new Date(c.fsrs.due) <= now && !seen.has(c.id))
    .sort((a, b) => new Date(a.fsrs.due) - new Date(b.fsrs.due));
  for (const c of dueCards) {
    seen.add(c.id);
    dueIds.push(c.id);
  }

  queue = [...priorityIds, ...dueIds];
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
  // pending push count
  const pending = (state.sync && Array.isArray(state.sync.pending_pushes)) ? state.sync.pending_pushes.length : 0;
  if (el.statPending) el.statPending.textContent = pending;
  if (el.syncPending) {
    el.syncPending.classList.toggle('hidden', pending === 0);
  }
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
  card.updated_at = new Date().toISOString();
  const reviewEntry = {
    at: new Date().toISOString(),
    rating: ratingLabel(ratingValue),
    card_review: selectedCardReview,
    comment: el.comment.value.trim() || null
  };
  card.review_history = card.review_history || [];
  card.review_history.push(reviewEntry);

  saveState();

  // Supabase へ push
  enqueuePush('cards', {
    id: card.id,
    front: card.front,
    back: card.back,
    tags: card.tags || [],
    source: card.source || null,
    linked_cards: card.linked_cards || [],
    fsrs: card.fsrs,
    updated_at: card.updated_at
  });
  enqueuePush('review_history', {
    card_id: card.id,
    at: reviewEntry.at,
    rating: String(reviewEntry.rating || '').toLowerCase(),
    card_review: reviewEntry.card_review,
    comment: reviewEntry.comment,
    device: detectDeviceLabel()
  });

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

// ─── Daily Check-in ────────────────────
// カレンダーから取得した「今日の授業イベント」のキャッシュ
let todayClassEvents = []; // [{ summary, start, detected_subject }]

async function loadTodayCalendarEvents() {
  try {
    const res = await fetch('./today.json', { cache: 'no-store' });
    if (!res.ok) return [];
    const data = await res.json();
    const events = Array.isArray(data && data.events) ? data.events : [];
    // 授業っぽいものだけフィルタ
    const classes = [];
    for (const ev of events) {
      const summary = String((ev && ev.summary) || '').trim();
      if (!summary) continue;
      const subj = detectSubjectFromSummary(summary);
      if (!subj) continue;
      classes.push({
        summary,
        start: (ev && ev.start) || '',
        detected_subject: subj
      });
    }
    return classes;
  } catch (e) {
    return [];
  }
}

function renderCalendarEventsList() {
  if (!el.calendarEventsList) return;
  el.calendarEventsList.innerHTML = '';
  if (todayClassEvents.length === 0) {
    if (el.calendarEventsEmpty) el.calendarEventsEmpty.classList.remove('hidden');
    return;
  }
  if (el.calendarEventsEmpty) el.calendarEventsEmpty.classList.add('hidden');

  for (let i = 0; i < todayClassEvents.length; i++) {
    const ev = todayClassEvents[i];
    const li = document.createElement('li');
    li.className = 'calendar-event';
    li.dataset.idx = String(i);

    const head = document.createElement('div');
    head.className = 'calendar-event-head';
    head.innerHTML = `<strong>${escapeHtml(ev.summary)}</strong>` +
      `<span class="src-meta">${escapeHtml(ev.detected_subject)}</span>` +
      (ev.start ? `<span class="src-meta">${escapeHtml(ev.start)}</span>` : '');
    li.appendChild(head);

    const btnRow = document.createElement('div');
    btnRow.className = 'calendar-event-btns';
    btnRow.innerHTML = `
      <button type="button" class="calendar-event-btn" data-status="confirmed">✓ 合ってる</button>
      <button type="button" class="calendar-event-btn" data-status="drifted">⚠️ ずれてる</button>
      <button type="button" class="calendar-event-btn" data-status="absent">✗ 欠席</button>
    `;
    li.appendChild(btnRow);

    const drift = document.createElement('div');
    drift.className = 'calendar-event-drift hidden';
    drift.innerHTML = `<input type="text" class="calendar-event-actual" placeholder="実際の範囲・トピック（例: 表現の自由②各論まで）">`;
    li.appendChild(drift);

    // ボタンハンドラ
    btnRow.querySelectorAll('.calendar-event-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const status = btn.dataset.status;
        btnRow.querySelectorAll('.calendar-event-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        li.dataset.status = status;
        drift.classList.toggle('hidden', status !== 'drifted');
      });
    });

    el.calendarEventsList.appendChild(li);
  }
}

function clearManualEntries() {
  if (el.manualEntries) el.manualEntries.innerHTML = '';
}

function addManualEntry() {
  if (!el.manualEntries || !el.tplManualEntry) return;
  const frag = el.tplManualEntry.content.cloneNode(true);
  const entry = frag.querySelector('.manual-entry');

  // ソース切替で「コース」表示制御
  const courseRow = entry.querySelector('.manual-entry-course-row');
  const updateCourseVisibility = () => {
    const checked = entry.querySelector('input[type="radio"][name="src"]:checked');
    const val = checked ? checked.value : 'itojuku';
    courseRow.classList.toggle('hidden', val !== 'itojuku');
  };
  entry.querySelectorAll('input[type="radio"][name="src"]').forEach(r => {
    r.addEventListener('change', updateCourseVisibility);
  });
  updateCourseVisibility();

  // 削除ボタン
  const removeBtn = entry.querySelector('.manual-entry-remove');
  removeBtn.addEventListener('click', () => entry.remove());

  el.manualEntries.appendChild(frag);
}

function openCheckinModal() {
  if (!el.checkinModal || typeof el.checkinModal.showModal !== 'function') return;
  // カレンダー読込 → 描画
  loadTodayCalendarEvents().then(events => {
    todayClassEvents = events;
    renderCalendarEventsList();
  });
  // manual entries クリア
  clearManualEntries();
  el.checkinModal.showModal();
}

function closeCheckinModal() {
  if (el.checkinModal && el.checkinModal.open) el.checkinModal.close();
}

function gatherCalendarConfirmations() {
  const out = [];
  if (!el.calendarEventsList) return out;
  const items = el.calendarEventsList.querySelectorAll('.calendar-event');
  items.forEach(li => {
    const idx = parseInt(li.dataset.idx, 10);
    const ev = todayClassEvents[idx];
    if (!ev) return;
    const status = li.dataset.status;
    if (!status) return; // 未選択は記録しない
    const entry = {
      calendar_summary: ev.summary,
      start: ev.start || '',
      detected_subject: ev.detected_subject,
      user_status: status
    };
    if (status === 'drifted') {
      const input = li.querySelector('.calendar-event-actual');
      if (input && input.value.trim()) entry.actual_topic = input.value.trim();
    }
    out.push(entry);
  });
  return out;
}

function gatherManualEntries() {
  const out = [];
  if (!el.manualEntries) return out;
  el.manualEntries.querySelectorAll('.manual-entry').forEach(entry => {
    const subjects = [...entry.querySelectorAll('.manual-entry-subjects input[type="checkbox"]:checked')].map(cb => cb.value);
    const srcRadio = entry.querySelector('input[type="radio"][name="src"]:checked');
    const source = srcRadio ? srcRadio.value : 'itojuku';
    const topicInput = entry.querySelector('.manual-entry-topic-input');
    const topic = topicInput ? topicInput.value.trim() : '';
    const courseSel = entry.querySelector('.manual-entry-course');
    const course = (source === 'itojuku' && courseSel) ? courseSel.value : null;

    // 完全空エントリは捨てる
    if (subjects.length === 0 && !topic) return;
    const obj = { subjects, source, topic };
    if (course) obj.course = course;
    out.push(obj);
  });
  return out;
}

function gatherCheckinForm() {
  const calendar_confirmations = gatherCalendarConfirmations();
  const manual_entries = gatherManualEntries();

  // 旧フィールドも互換のため一緒に詰める
  const legacySubjects = new Set();
  const legacyTopics = [];
  for (const cc of calendar_confirmations) {
    if (cc.user_status !== 'absent' && cc.detected_subject) legacySubjects.add(cc.detected_subject);
    if (cc.actual_topic) legacyTopics.push(cc.actual_topic);
  }
  for (const me of manual_entries) {
    if (Array.isArray(me.subjects)) me.subjects.forEach(s => legacySubjects.add(s));
    if (me.topic) legacyTopics.push(me.topic);
  }

  return {
    date: todayDateStr(),
    at: new Date().toISOString(),
    calendar_confirmations,
    manual_entries,
    // 後方互換
    subjects: [...legacySubjects],
    topic: legacyTopics.join('; '),
    progress: '',
    sources: []
  };
}

function recordCheckin(entry) {
  if (!Array.isArray(state.checkins)) state.checkins = [];
  // 当日の既存エントリを置き換え
  const idx = state.checkins.findIndex(c => c.date === entry.date);
  if (idx >= 0) state.checkins[idx] = entry;
  else state.checkins.push(entry);
  saveState();
}

function rebuildAndShow() {
  buildQueue();
  if (queue.length === 0) {
    updateStats();
    showDone();
  } else {
    showCard(queue[0]);
  }
}

function handleCheckinSubmit() {
  const entry = gatherCheckinForm();
  recordCheckin(entry);
  closeCheckinModal();
  rebuildAndShow();
}

function handleOpenCheckin() {
  // トップバーの「📝 今日の学習を入力」ボタン。当日エントリの有無に関わらず必ず開く
  openCheckinModal();
}

// ─── Calendar Integration (today.json) ────

function showCheckinFetchFlash(message, kind) {
  if (!el.checkinFetchFlash) return;
  el.checkinFetchFlash.textContent = message;
  el.checkinFetchFlash.classList.remove('hidden', 'ok', 'warn');
  el.checkinFetchFlash.classList.add(kind === 'warn' ? 'warn' : 'ok');
  setTimeout(() => {
    if (el.checkinFetchFlash) el.checkinFetchFlash.classList.add('hidden');
  }, 5000);
}

async function handleFetchToday() {
  try {
    const events = await loadTodayCalendarEvents();
    todayClassEvents = events;
    renderCalendarEventsList();
    if (events.length === 0) {
      showCheckinFetchFlash('今日カレンダーに授業の予定はありません。', 'warn');
    } else {
      showCheckinFetchFlash(`${events.length} 件の授業を取得しました`, 'ok');
    }
  } catch (err) {
    showCheckinFetchFlash('カレンダー情報の取得に失敗しました。', 'warn');
  }
}

function handleCheckinSkip() {
  // 空エントリ（calendar_confirmations: [], manual_entries: []）を記録 → 当日もう聞かない
  const entry = {
    date: todayDateStr(),
    at: new Date().toISOString(),
    calendar_confirmations: [],
    manual_entries: [],
    subjects: [],
    topic: '',
    progress: '',
    sources: []
  };
  recordCheckin(entry);
  closeCheckinModal();
  rebuildAndShow();
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

  // チェックインモーダル
  if (el.btnCheckinSubmit) el.btnCheckinSubmit.addEventListener('click', handleCheckinSubmit);
  if (el.btnCheckinSkip) el.btnCheckinSkip.addEventListener('click', handleCheckinSkip);
  if (el.btnOpenCheckin) el.btnOpenCheckin.addEventListener('click', handleOpenCheckin);
  if (el.btnFetchToday) el.btnFetchToday.addEventListener('click', handleFetchToday);
  if (el.btnAddManualEntry) el.btnAddManualEntry.addEventListener('click', addManualEntry);

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
    attachEvents();
    renderTab('review');

    // 当日のチェックインが未記録ならモーダル → 完了時に rebuildAndShow
    const todayEntry = getTodayCheckin();
    if (!todayEntry) {
      openCheckinModal();
      // モーダルが開いていてもキューは空で初期表示しておく
      buildQueue();
      updateStats();
      if (queue.length === 0) showDone();
      else showCard(queue[0]);
    } else {
      buildQueue();
      if (queue.length === 0) {
        updateStats();
        showDone();
      } else {
        showCard(queue[0]);
      }
    }
  } catch (err) {
    console.error(err);
    el.cardFront.textContent = '初期化に失敗しました: ' + err.message;
  }
})();
