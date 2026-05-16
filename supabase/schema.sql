-- =====================================================================
-- SRS App: Supabase schema (Postgres)
-- =====================================================================
-- Run order:
--   1. schema.sql   (this file)        -- tables, indexes, triggers
--   2. rls.sql                         -- add user_id columns + RLS policies
--   3. migrate_initial.sql (optional)  -- seed from existing cards.json
-- =====================================================================

-- ---------------------------------------------------------------------
-- cards: フラッシュカード本体
--   write : PC 側スクリプト（import_md / apply_proposal / evolve）が中心
--   read  : 全デバイス（PC / iPhone / iPad のブラウザアプリ）
-- ---------------------------------------------------------------------
create table if not exists cards (
  id            text primary key,
  front         text not null,
  back          text not null,
  tags          jsonb not null default '[]'::jsonb,
  source        text,
  linked_cards  jsonb not null default '[]'::jsonb,
  fsrs          jsonb not null,
  updated_at    timestamptz not null default now()
);
create index if not exists cards_updated_at_idx on cards(updated_at);
create index if not exists cards_tags_gin_idx on cards using gin (tags);

-- ---------------------------------------------------------------------
-- review_history: 1 回ずつのレビューイベント（FSRS の入力）
--   write : 全デバイス（レビュー画面で評価したとき）
--   read  : PC 側スクリプト（evolve の素材）
-- ---------------------------------------------------------------------
create table if not exists review_history (
  id           bigserial primary key,
  card_id      text not null references cards(id) on delete cascade,
  at           timestamptz not null,
  rating       text not null,        -- 'again' | 'hard' | 'good' | 'easy'
  card_review  text,                 -- カード自己評価（ラベル）
  comment      text,
  device       text,                 -- 'pc' | 'iphone' | 'ipad' 等
  created_at   timestamptz not null default now()
);
create index if not exists review_history_card_id_idx on review_history(card_id);
create index if not exists review_history_at_idx on review_history(at);

-- ---------------------------------------------------------------------
-- mistakes: 演習で出てきたミス（evolve の主要入力）
--   write : 全デバイス（ミス入力 UI）
--   read  : PC 側スクリプト（evolve でカード提案を作る素材）
-- ---------------------------------------------------------------------
create table if not exists mistakes (
  id              text primary key,
  at              timestamptz not null,
  text            text not null,
  tags            jsonb not null default '[]'::jsonb,
  source          text,
  hit_card_ids    jsonb not null default '[]'::jsonb,
  status          text not null default 'open',  -- 'open' | 'addressed' | 'archived'
  updated_at      timestamptz not null default now()
);
create index if not exists mistakes_updated_at_idx on mistakes(updated_at);
create index if not exists mistakes_status_idx on mistakes(status);

-- ---------------------------------------------------------------------
-- checkins: 日次チェックイン（科目・トピック・進捗 等）
--   write : 全デバイス
--   read  : PC 側スクリプト（evolve コンテキスト）
-- ---------------------------------------------------------------------
create table if not exists checkins (
  date                    date primary key,
  subjects                jsonb not null default '[]'::jsonb,
  topic                   text,
  progress                text,
  sources                 jsonb not null default '[]'::jsonb,
  calendar_confirmations  jsonb not null default '[]'::jsonb,
  manual_entries          jsonb not null default '[]'::jsonb,
  at                      timestamptz not null,
  updated_at              timestamptz not null default now()
);
create index if not exists checkins_updated_at_idx on checkins(updated_at);

-- ---------------------------------------------------------------------
-- imported_sources: import_md.ps1 がどの md ファイルから何カード作ったかの台帳
--   write : PC 側のみ（import_md.ps1）
--   read  : 全デバイス
-- ---------------------------------------------------------------------
create table if not exists imported_sources (
  id           bigserial primary key,
  path         text not null unique,
  basename     text not null,
  subject      text,
  imported_at  timestamptz not null,
  card_count   integer not null,
  card_ids     jsonb not null default '[]'::jsonb,
  updated_at   timestamptz not null default now()
);
create index if not exists imported_sources_updated_at_idx on imported_sources(updated_at);

-- ---------------------------------------------------------------------
-- today_events: Google Calendar から取得したその日の予定
--   write : PC 側のみ（refresh_today.ps1）
--   read  : 全デバイス
-- ---------------------------------------------------------------------
create table if not exists today_events (
  date        date primary key,
  events      jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now()
);
create index if not exists today_events_updated_at_idx on today_events(updated_at);

-- ---------------------------------------------------------------------
-- updated_at 自動更新トリガ
-- ---------------------------------------------------------------------
create or replace function tg_set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_cards_updated on cards;
create trigger trg_cards_updated
  before update on cards
  for each row execute function tg_set_updated_at();

drop trigger if exists trg_mistakes_updated on mistakes;
create trigger trg_mistakes_updated
  before update on mistakes
  for each row execute function tg_set_updated_at();

drop trigger if exists trg_checkins_updated on checkins;
create trigger trg_checkins_updated
  before update on checkins
  for each row execute function tg_set_updated_at();

drop trigger if exists trg_imported_sources_updated on imported_sources;
create trigger trg_imported_sources_updated
  before update on imported_sources
  for each row execute function tg_set_updated_at();

drop trigger if exists trg_today_events_updated on today_events;
create trigger trg_today_events_updated
  before update on today_events
  for each row execute function tg_set_updated_at();

-- review_history は append-only なので updated_at トリガ不要
