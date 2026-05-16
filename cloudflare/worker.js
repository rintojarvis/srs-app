// Cloudflare Workers entry point for SRS app sync.
// Endpoints:
//   GET  /sync/pull?since=<ms>   -> rows updated after `since`
//   POST /sync/push              -> upsert payload, returns counts
//
// Auth: bearer token in `Authorization: Bearer <SYNC_SECRET>` header.
// SYNC_SECRET is provisioned via `wrangler secret put SYNC_SECRET`.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const auth = request.headers.get('Authorization');
    if (!env.SYNC_SECRET || !auth || auth !== `Bearer ${env.SYNC_SECRET}`) {
      return jsonResp({ error: 'unauthorized' }, 401);
    }

    try {
      if (path === '/sync/pull' && method === 'GET') {
        const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
        return await handlePull(env.DB, since);
      }
      if (path === '/sync/push' && method === 'POST') {
        const body = await request.json();
        return await handlePush(env.DB, body);
      }
      if (path === '/health' && method === 'GET') {
        return jsonResp({ ok: true, server_time: Date.now() });
      }
      return jsonResp({ error: 'not_found', path, method }, 404);
    } catch (e) {
      return jsonResp({ error: String(e && e.message || e) }, 500);
    }
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders()
    }
  });
}

// -------------------- PULL --------------------

async function handlePull(DB, since) {
  const sinceVal = Number.isFinite(since) ? since : 0;

  const [cards, mistakes, checkins, reviewHistory] = await Promise.all([
    DB.prepare(
      'SELECT id, front, back, tags, source, linked_cards, fsrs, updated_at ' +
      'FROM cards WHERE updated_at > ? ORDER BY updated_at ASC'
    ).bind(sinceVal).all(),
    DB.prepare(
      'SELECT id, at, text, tags, source, hit_card_ids, status, updated_at ' +
      'FROM mistakes WHERE updated_at > ? ORDER BY updated_at ASC'
    ).bind(sinceVal).all(),
    DB.prepare(
      'SELECT date, subjects, topic, progress, sources, at, updated_at ' +
      'FROM checkins WHERE updated_at > ? ORDER BY updated_at ASC'
    ).bind(sinceVal).all(),
    DB.prepare(
      'SELECT card_id, at, rating, card_review, comment, updated_at ' +
      'FROM review_history WHERE updated_at > ? ORDER BY updated_at ASC'
    ).bind(sinceVal).all()
  ]);

  return jsonResp({
    cards:          (cards.results          || []).map(decodeCard),
    mistakes:       (mistakes.results       || []).map(decodeMistake),
    checkins:       (checkins.results       || []).map(decodeCheckin),
    review_history: (reviewHistory.results  || []).map(decodeReview),
    server_time: Date.now(),
    since: sinceVal
  });
}

function parseJSONField(s, fallback) {
  if (s === null || s === undefined || s === '') return fallback;
  try { return JSON.parse(s); } catch (_) { return fallback; }
}

function decodeCard(row) {
  return {
    id: row.id,
    front: row.front,
    back: row.back,
    tags: parseJSONField(row.tags, []),
    source: row.source,
    linked_cards: parseJSONField(row.linked_cards, []),
    fsrs: parseJSONField(row.fsrs, null),
    updated_at: row.updated_at
  };
}

function decodeMistake(row) {
  return {
    id: row.id,
    at: row.at,
    text: row.text,
    tags: parseJSONField(row.tags, []),
    source: row.source,
    hit_card_ids: parseJSONField(row.hit_card_ids, []),
    status: row.status,
    updated_at: row.updated_at
  };
}

function decodeCheckin(row) {
  return {
    date: row.date,
    subjects: parseJSONField(row.subjects, []),
    topic: row.topic,
    progress: row.progress,
    sources: parseJSONField(row.sources, []),
    at: row.at,
    updated_at: row.updated_at
  };
}

function decodeReview(row) {
  return {
    card_id: row.card_id,
    at: row.at,
    rating: row.rating,
    card_review: row.card_review,
    comment: row.comment,
    updated_at: row.updated_at
  };
}

// -------------------- PUSH --------------------

async function handlePush(DB, payload) {
  payload = payload || {};
  const now = Date.now();

  const cards         = Array.isArray(payload.cards)          ? payload.cards          : [];
  const mistakes      = Array.isArray(payload.mistakes)       ? payload.mistakes       : [];
  const checkins      = Array.isArray(payload.checkins)       ? payload.checkins       : [];
  const reviewHistory = Array.isArray(payload.review_history) ? payload.review_history : [];

  const statements = [];

  const cardStmt = DB.prepare(
    'INSERT OR REPLACE INTO cards ' +
    '(id, front, back, tags, source, linked_cards, fsrs, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  for (const c of cards) {
    if (!c || !c.id) continue;
    statements.push(cardStmt.bind(
      String(c.id),
      c.front ?? null,
      c.back ?? null,
      encodeJSONField(c.tags, []),
      c.source ?? null,
      encodeJSONField(c.linked_cards, []),
      encodeJSONField(c.fsrs, null),
      toInt(c.updated_at, now)
    ));
  }

  const mistakeStmt = DB.prepare(
    'INSERT OR REPLACE INTO mistakes ' +
    '(id, at, text, tags, source, hit_card_ids, status, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  for (const m of mistakes) {
    if (!m || !m.id) continue;
    statements.push(mistakeStmt.bind(
      String(m.id),
      m.at ?? null,
      m.text ?? null,
      encodeJSONField(m.tags, []),
      m.source ?? null,
      encodeJSONField(m.hit_card_ids, []),
      m.status ?? null,
      toInt(m.updated_at, now)
    ));
  }

  const checkinStmt = DB.prepare(
    'INSERT OR REPLACE INTO checkins ' +
    '(date, subjects, topic, progress, sources, at, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  for (const ci of checkins) {
    if (!ci || !ci.date) continue;
    statements.push(checkinStmt.bind(
      String(ci.date),
      encodeJSONField(ci.subjects, []),
      ci.topic ?? null,
      ci.progress ?? null,
      encodeJSONField(ci.sources, []),
      ci.at ?? null,
      toInt(ci.updated_at, now)
    ));
  }

  const reviewStmt = DB.prepare(
    'INSERT OR REPLACE INTO review_history ' +
    '(card_id, at, rating, card_review, comment, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const r of reviewHistory) {
    if (!r || !r.card_id || !r.at) continue;
    statements.push(reviewStmt.bind(
      String(r.card_id),
      String(r.at),
      r.rating ?? null,
      r.card_review ?? null,
      r.comment ?? null,
      toInt(r.updated_at, now)
    ));
  }

  if (statements.length > 0) {
    // D1 batch is transactional: all statements succeed or none do.
    await DB.batch(statements);
  }

  return jsonResp({
    ok: true,
    applied: {
      cards:          cards.filter(c => c && c.id).length,
      mistakes:       mistakes.filter(m => m && m.id).length,
      checkins:       checkins.filter(ci => ci && ci.date).length,
      review_history: reviewHistory.filter(r => r && r.card_id && r.at).length
    },
    server_time: now
  });
}

function encodeJSONField(val, fallback) {
  const v = (val === undefined || val === null) ? fallback : val;
  try { return JSON.stringify(v); } catch (_) { return JSON.stringify(fallback); }
}

function toInt(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}
