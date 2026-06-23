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
  btnAuthVerify: $('btn-auth-verify'),
  authCode: $('auth-code'),
  authCodeField: $('auth-code-field'),
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

  // Supabase へ push
  enqueuePush('mistakes', {
    id: entry.id,
    at: entry.at,
    text: entry.text,
    tags: entry.tags || [],
    source: entry.source,
    hit_card_ids: entry.hit_card_ids || [],
    status: entry.status || 'open'
  });

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

  // Supabase へ push
  enqueuePush('checkins', {
    date: entry.date,
    subjects: entry.subjects || [],
    topic: entry.topic || null,
    progress: entry.progress || null,
    sources: entry.sources || [],
    calendar_confirmations: entry.calendar_confirmations || [],
    manual_entries: entry.manual_entries || [],
    at: entry.at
  });
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

// ─── Supabase Sync Engine ──────────────

function detectDeviceLabel() {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) ? navigator.userAgent : '';
  if (/iPhone/i.test(ua)) return 'iphone';
  if (/iPad/i.test(ua)) return 'ipad';
  if (/Android/i.test(ua)) return 'android';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'mac';
  if (/Windows/i.test(ua)) return 'pc';
  return 'web';
}

function isSignedIn() {
  return !!(state.sync && state.sync.user_id);
}

function enqueuePush(table, row) {
  if (!state.sync) return;
  if (!Array.isArray(state.sync.pending_pushes)) state.sync.pending_pushes = [];
  state.sync.pending_pushes.push({ table, row, at: Date.now() });
  saveState();
  updateStats();
  // 非同期 flush（失敗時はキューに残す）
  flushPushes().catch(e => console.warn('flushPushes error:', e));
}

let flushingPushes = false;
async function flushPushes() {
  if (flushingPushes) return;
  if (!isSignedIn()) return;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;

  flushingPushes = true;
  try {
    const queue = (state.sync.pending_pushes || []).slice();
    const succeeded = new Set();
    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      try {
        const row = { ...item.row, user_id: state.sync.user_id };
        let res;
        if (item.table === 'review_history') {
          // append-only: insert
          res = await supabase.from(item.table).insert(row);
        } else {
          res = await supabase.from(item.table).upsert(row);
        }
        if (res && res.error) {
          console.warn('push failed:', item.table, res.error);
          break; // 先頭のエラーで停止、残りは次回再試行
        }
        succeeded.add(i);
      } catch (e) {
        console.warn('push exception:', e);
        break;
      }
    }
    // 成功分だけキューから取り除く
    state.sync.pending_pushes = (state.sync.pending_pushes || []).filter((_, idx) => !succeeded.has(idx));
    saveState();
    updateStats();
  } finally {
    flushingPushes = false;
  }
}

function mergeRemoteCards(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  let changed = false;
  const byId = new Map(state.cards.map(c => [c.id, c]));
  for (const r of rows) {
    if (!r || !r.id) continue;
    const local = byId.get(r.id);
    const remoteUpdated = r.updated_at || '';
    const localUpdated = (local && local.updated_at) || '';
    if (!local || remoteUpdated > localUpdated) {
      const merged = {
        id: r.id,
        front: r.front,
        back: r.back,
        tags: Array.isArray(r.tags) ? r.tags : (r.tags || []),
        source: r.source || null,
        linked_cards: Array.isArray(r.linked_cards) ? r.linked_cards : (r.linked_cards || []),
        fsrs: r.fsrs || (local ? local.fsrs : null),
        review_history: local ? (local.review_history || []) : [],
        updated_at: r.updated_at
      };
      byId.set(r.id, merged);
      changed = true;
    }
  }
  if (changed) state.cards = [...byId.values()];
  return changed;
}

function mergeRemoteMistakes(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  let changed = false;
  const byId = new Map((state.mistakes || []).map(m => [m.id, m]));
  for (const r of rows) {
    if (!r || !r.id) continue;
    const local = byId.get(r.id);
    const remoteUpdated = r.updated_at || r.at || '';
    const localUpdated = (local && (local.updated_at || local.at)) || '';
    if (!local || remoteUpdated > localUpdated) {
      byId.set(r.id, {
        id: r.id,
        at: r.at,
        text: r.text,
        tags: Array.isArray(r.tags) ? r.tags : (r.tags || []),
        source: r.source || null,
        hit_card_ids: Array.isArray(r.hit_card_ids) ? r.hit_card_ids : (r.hit_card_ids || []),
        status: r.status || 'open',
        updated_at: r.updated_at
      });
      changed = true;
    }
  }
  if (changed) state.mistakes = [...byId.values()];
  return changed;
}

function mergeRemoteCheckins(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  let changed = false;
  const byDate = new Map((state.checkins || []).map(c => [c.date, c]));
  for (const r of rows) {
    if (!r || !r.date) continue;
    const local = byDate.get(r.date);
    const remoteUpdated = r.updated_at || r.at || '';
    const localUpdated = (local && (local.updated_at || local.at)) || '';
    if (!local || remoteUpdated > localUpdated) {
      byDate.set(r.date, {
        date: r.date,
        subjects: Array.isArray(r.subjects) ? r.subjects : (r.subjects || []),
        topic: r.topic || '',
        progress: r.progress || '',
        sources: Array.isArray(r.sources) ? r.sources : (r.sources || []),
        calendar_confirmations: Array.isArray(r.calendar_confirmations) ? r.calendar_confirmations : (r.calendar_confirmations || []),
        manual_entries: Array.isArray(r.manual_entries) ? r.manual_entries : (r.manual_entries || []),
        at: r.at,
        updated_at: r.updated_at
      });
      changed = true;
    }
  }
  if (changed) state.checkins = [...byDate.values()];
  return changed;
}

function mergeRemoteImportedSources(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  let changed = false;
  const byPath = new Map((state.imported_sources || []).map(s => [s.path, s]));
  for (const r of rows) {
    if (!r || !r.path) continue;
    const local = byPath.get(r.path);
    const remoteUpdated = r.updated_at || r.imported_at || '';
    const localUpdated = (local && (local.updated_at || local.imported_at)) || '';
    if (!local || remoteUpdated > localUpdated) {
      byPath.set(r.path, {
        path: r.path,
        basename: r.basename,
        subject: r.subject || null,
        imported_at: r.imported_at,
        card_count: r.card_count || 0,
        card_ids: Array.isArray(r.card_ids) ? r.card_ids : (r.card_ids || []),
        updated_at: r.updated_at
      });
      changed = true;
    }
  }
  if (changed) state.imported_sources = [...byPath.values()];
  return changed;
}

function mergeRemoteTodayEvents(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  let changed = false;
  const byDate = new Map((state.today_events || []).map(t => [t.date, t]));
  for (const r of rows) {
    if (!r || !r.date) continue;
    const local = byDate.get(r.date);
    const remoteUpdated = r.updated_at || '';
    const localUpdated = (local && local.updated_at) || '';
    if (!local || remoteUpdated > localUpdated) {
      byDate.set(r.date, {
        date: r.date,
        events: Array.isArray(r.events) ? r.events : (r.events || []),
        updated_at: r.updated_at
      });
      changed = true;
    }
  }
  if (changed) state.today_events = [...byDate.values()];
  return changed;
}

async function pull() {
  if (!isSignedIn()) return;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;

  const since = new Date(state.sync.last_pull_at || 0).toISOString();
  const t = Date.now();
  let anyChange = false;
  try {
    const [cardsR, mistakesR, checkinsR, importedR, todayR] = await Promise.all([
      supabase.from('cards').select('*').gt('updated_at', since),
      supabase.from('mistakes').select('*').gt('updated_at', since),
      supabase.from('checkins').select('*').gt('updated_at', since),
      supabase.from('imported_sources').select('*').gt('updated_at', since),
      supabase.from('today_events').select('*').gt('updated_at', since)
    ]);
    if (cardsR.data) anyChange = mergeRemoteCards(cardsR.data) || anyChange;
    if (mistakesR.data) anyChange = mergeRemoteMistakes(mistakesR.data) || anyChange;
    if (checkinsR.data) anyChange = mergeRemoteCheckins(checkinsR.data) || anyChange;
    if (importedR.data) anyChange = mergeRemoteImportedSources(importedR.data) || anyChange;
    if (todayR.data) anyChange = mergeRemoteTodayEvents(todayR.data) || anyChange;
    state.sync.last_pull_at = t;
    saveState();
    if (anyChange) renderAll();
  } catch (e) {
    console.warn('pull failed:', e);
  }
}

function renderAll() {
  // 既存の表示をリビルド（review タブのみ buildQueue を回す）
  buildQueue();
  updateStats();
  if (activeTab === 'review') {
    if (queue.length === 0) showDone();
    else showCard(queue[0]);
  } else if (activeTab === 'mistake') {
    renderMistakeList();
    refreshMistakeSourceOptions();
  }
}

let realtimeChannel = null;
function subscribeRealtime() {
  if (!isSignedIn()) return;
  if (realtimeChannel) {
    try { supabase.removeChannel(realtimeChannel); } catch (e) {}
    realtimeChannel = null;
  }
  const tables = ['cards', 'review_history', 'mistakes', 'checkins', 'today_events', 'imported_sources'];
  let ch = supabase.channel('srs-sync');
  for (const tbl of tables) {
    ch = ch.on('postgres_changes', { event: '*', schema: 'public', table: tbl }, payload => {
      applyRemoteChange(tbl, payload);
    });
  }
  realtimeChannel = ch.subscribe();
}

function applyRemoteChange(table, payload) {
  if (!payload) return;
  // 自分の uid のものだけ反映（保険）
  const row = payload.new || payload.record || null;
  if (row && row.user_id && state.sync.user_id && row.user_id !== state.sync.user_id) return;

  let changed = false;
  if (table === 'cards' && row) changed = mergeRemoteCards([row]);
  else if (table === 'mistakes' && row) changed = mergeRemoteMistakes([row]);
  else if (table === 'checkins' && row) changed = mergeRemoteCheckins([row]);
  else if (table === 'imported_sources' && row) changed = mergeRemoteImportedSources([row]);
  else if (table === 'today_events' && row) changed = mergeRemoteTodayEvents([row]);
  // review_history はローカル状態に持たないので無視（card.review_history はローカル独自）

  if (changed) {
    saveState();
    renderAll();
  }
}

// 初回サインイン後のローカル → クラウド一括 upsert
async function migrateLocalToSupabase() {
  if (!isSignedIn()) return;
  try {
    // cards のリモート件数を確認
    const { count, error } = await supabase
      .from('cards').select('id', { count: 'exact', head: true });
    if (error) {
      console.warn('migrate count failed:', error);
      return;
    }
    if ((count || 0) > 0) return; // 既にクラウド側にデータがある → 移行不要

    let total = 0;
    const uid = state.sync.user_id;

    // cards
    if (Array.isArray(state.cards) && state.cards.length > 0) {
      const rows = state.cards.map(c => ({
        id: c.id,
        front: c.front,
        back: c.back,
        tags: c.tags || [],
        source: c.source || null,
        linked_cards: c.linked_cards || [],
        fsrs: c.fsrs,
        user_id: uid
      }));
      // チャンク化（500件ずつ）
      for (let i = 0; i < rows.length; i += 500) {
        const slice = rows.slice(i, i + 500);
        const { error: e } = await supabase.from('cards').upsert(slice);
        if (e) { console.warn('migrate cards chunk failed:', e); break; }
        total += slice.length;
      }
    }
    // mistakes
    if (Array.isArray(state.mistakes) && state.mistakes.length > 0) {
      const rows = state.mistakes.map(m => ({
        id: m.id,
        at: m.at,
        text: m.text,
        tags: m.tags || [],
        source: m.source || null,
        hit_card_ids: m.hit_card_ids || [],
        status: m.status || 'open',
        user_id: uid
      }));
      const { error: e } = await supabase.from('mistakes').upsert(rows);
      if (!e) total += rows.length; else console.warn('migrate mistakes failed:', e);
    }
    // checkins
    if (Array.isArray(state.checkins) && state.checkins.length > 0) {
      const rows = state.checkins.map(c => ({
        date: c.date,
        subjects: c.subjects || [],
        topic: c.topic || null,
        progress: c.progress || null,
        sources: c.sources || [],
        calendar_confirmations: c.calendar_confirmations || [],
        manual_entries: c.manual_entries || [],
        at: c.at,
        user_id: uid
      }));
      const { error: e } = await supabase.from('checkins').upsert(rows);
      if (!e) total += rows.length; else console.warn('migrate checkins failed:', e);
    }
    // imported_sources
    if (Array.isArray(state.imported_sources) && state.imported_sources.length > 0) {
      const rows = state.imported_sources.map(s => ({
        path: s.path,
        basename: s.basename,
        subject: s.subject || null,
        imported_at: s.imported_at,
        card_count: s.card_count || 0,
        card_ids: s.card_ids || [],
        user_id: uid
      }));
      const { error: e } = await supabase.from('imported_sources').upsert(rows, { onConflict: 'path' });
      if (!e) total += rows.length; else console.warn('migrate imported_sources failed:', e);
    }
    // today_events
    if (Array.isArray(state.today_events) && state.today_events.length > 0) {
      const rows = state.today_events.map(t => ({
        date: t.date,
        events: t.events || [],
        user_id: uid
      }));
      const { error: e } = await supabase.from('today_events').upsert(rows);
      if (!e) total += rows.length; else console.warn('migrate today_events failed:', e);
    }

    if (total > 0) {
      showAuthFlash(`ローカルデータ ${total} 件を同期しました`, 'ok');
    }
  } catch (e) {
    console.warn('migrateLocalToSupabase error:', e);
  }
}

// ─── Auth UI ──────────────────────────
function showAuthFlash(message, kind) {
  if (!el.authFlash) return;
  el.authFlash.textContent = message;
  el.authFlash.classList.remove('hidden', 'ok', 'warn');
  el.authFlash.classList.add(kind === 'warn' ? 'warn' : 'ok');
}

function openAuthModal() {
  if (el.authModal && typeof el.authModal.showModal === 'function' && !el.authModal.open) {
    el.authModal.showModal();
  }
}

function closeAuthModal() {
  if (el.authModal && el.authModal.open) el.authModal.close();
}

function renderAuthStatus() {
  if (!el.authStatus) return;
  if (isSignedIn()) {
    el.authStatus.classList.remove('hidden');
    if (el.authStatusEmail) {
      el.authStatusEmail.textContent = 'サインイン中: ' + (state.sync.user_email || state.sync.user_id || '');
    }
  } else {
    el.authStatus.classList.add('hidden');
  }
}

async function handleSendMagicLink() {
  const email = (el.authEmail && el.authEmail.value || '').trim();
  if (!email) {
    showAuthFlash('メールアドレスを入力してください', 'warn');
    return;
  }
  try {
    if (el.btnAuthSend) el.btnAuthSend.disabled = true;
    // Magic Link は必ず canonical URL に戻す (Vercel の deployment-specific URL や
     // www あり/なし違いで別オリジン扱いになり localStorage が共有されない問題の回避)。
     const CANONICAL_ORIGIN = 'https://srs-app-murex.vercel.app';
     const redirect = CANONICAL_ORIGIN + window.location.pathname + window.location.search;
     const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirect }
    });
    if (error) {
      showAuthFlash('送信失敗: ' + error.message, 'warn');
    } else {
      showAuthFlash('メールが届いたら 8桁コードをここに入力するか、メール内のリンクをタップ。', 'ok');
      // コード入力欄を露出してフォーカスを当てる(PWA mode で localStorage 分離問題を回避)
      if (el.authCodeField) el.authCodeField.style.display = '';
      if (el.btnAuthVerify) el.btnAuthVerify.style.display = '';
      if (el.btnAuthSend) el.btnAuthSend.textContent = '別アドレスで再送';
      if (el.authCode) setTimeout(() => el.authCode.focus(), 200);
    }
  } catch (e) {
    showAuthFlash('送信失敗: ' + (e && e.message || String(e)), 'warn');
  } finally {
    if (el.btnAuthSend) el.btnAuthSend.disabled = false;
  }
}

function handleAuthSkip() {
  closeAuthModal();
}

async function handleSignOut() {
  try {
    await supabase.auth.signOut();
  } catch (e) {
    console.warn('signOut failed:', e);
  }
  state.sync.user_id = null;
  state.sync.user_email = null;
  state.sync.last_pull_at = 0;
  saveState();
  if (realtimeChannel) {
    try { supabase.removeChannel(realtimeChannel); } catch (e) {}
    realtimeChannel = null;
  }
  renderAuthStatus();
  openAuthModal();
}

function handleExportUserId() {
  if (!isSignedIn()) {
    alert('サインインしてから取得してください。');
    return;
  }
  const payload = {
    user_id: state.sync.user_id,
    user_email: state.sync.user_email,
    note: 'PC スクリプトの service_role 実行時に user_id として指定する値。'
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'user_id.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function applySession(session) {
  if (session && session.user) {
    state.sync.user_id = session.user.id;
    state.sync.user_email = session.user.email || null;
    saveState();
    renderAuthStatus();
    closeAuthModal();
    // 初回サインインなら localStorage → Supabase 移行
    await migrateLocalToSupabase();
    // 初回 pull + Realtime 購読 + キュー flush
    await pull();
    subscribeRealtime();
    await flushPushes();
  } else {
    state.sync.user_id = null;
    state.sync.user_email = null;
    saveState();
    renderAuthStatus();
  }
}

async function initAuth() {
  // URL フラグメントにマジックリンクトークンが含まれていれば取り込む
  // （supabase-js v2 は detectSessionInUrl: true で自動処理する）
  let session = null;
  try {
    const { data } = await supabase.auth.getSession();
    session = data && data.session ? data.session : null;
  } catch (e) {
    console.warn('getSession failed:', e);
  }

  // 認証状態の変化を購読
  supabase.auth.onAuthStateChange((_event, sess) => {
    applySession(sess).catch(e => console.warn('applySession error:', e));
  });

  if (session) {
    await applySession(session);
  } else {
    openAuthModal();
  }
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

  // Auth UI
  if (el.btnAuthSend) el.btnAuthSend.addEventListener('click', handleSendMagicLink);
  if (el.btnAuthSkip) el.btnAuthSkip.addEventListener('click', handleAuthSkip);
  if (el.btnSignOut) el.btnSignOut.addEventListener('click', handleSignOut);
  if (el.btnExportUserid) el.btnExportUserid.addEventListener('click', handleExportUserId);

  // オンライン復帰時に未送信を flush、オフラインで状態更新
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
      if (state.sync) state.sync.online = true;
      flushPushes().catch(e => console.warn(e));
    });
    window.addEventListener('offline', () => {
      if (state.sync) state.sync.online = false;
    });
    // 可視化時にも軽く pull / flush
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && isSignedIn()) {
        pull().catch(e => console.warn(e));
        flushPushes().catch(e => console.warn(e));
      }
    });
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
    attachEvents();
    renderTab('review');

    // Auth 初期化（セッション有/無 を判定し、無ければ auth-modal を表示）
    // Auth フローと並行して、ローカルキャッシュで UI を即起動できるようにする
    initAuth().catch(e => console.warn('initAuth error:', e));

    // 当日のチェックインが未記録ならモーダル → 完了時に rebuildAndShow
    const todayEntry = getTodayCheckin();
    if (!todayEntry) {
      // auth-modal が開いていない（既にサインイン済 or skip 済）なら checkin を出す
      // auth-modal を優先表示するため、ここでは buildQueue のみ
      buildQueue();
      updateStats();
      if (queue.length === 0) showDone();
      else showCard(queue[0]);
      // auth-modal が開いていない場合のみ checkin モーダルを開く
      if (!(el.authModal && el.authModal.open)) {
        openCheckinModal();
      }
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
