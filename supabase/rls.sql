-- =====================================================================
-- SRS App: Row Level Security (RLS) policies
-- =====================================================================
-- Run AFTER schema.sql.
--
-- 方針:
--   - 個人利用が主だが、将来 family や共有を見越して user_id 単位で隔離
--   - auth.uid() = user_id の行のみ R/W できる
--   - service_role キーは RLS をバイパスするので、PC 側スクリプトは
--     SUPABASE_SERVICE_ROLE_KEY を使う想定（あるいは user_id を明示）
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. user_id カラム追加（FK は auth.users）
-- ---------------------------------------------------------------------
alter table cards
  add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table review_history
  add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table mistakes
  add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table checkins
  add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table imported_sources
  add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table today_events
  add column if not exists user_id uuid references auth.users(id) on delete cascade;

-- ---------------------------------------------------------------------
-- 2. NOT NULL 化（既存データがある場合は UPDATE で埋めてから実行）
--    MVP では新規プロジェクトを想定して即 NOT NULL にする
-- ---------------------------------------------------------------------
alter table cards             alter column user_id set not null;
alter table review_history    alter column user_id set not null;
alter table mistakes          alter column user_id set not null;
alter table checkins          alter column user_id set not null;
alter table imported_sources  alter column user_id set not null;
alter table today_events      alter column user_id set not null;

-- ---------------------------------------------------------------------
-- 3. 主キーは既存維持（cards.id / mistakes.id / checkins.date / today_events.date）
--    NOTE: 複数ユーザー想定で衝突回避するなら、将来
--      alter table cards drop constraint cards_pkey;
--      alter table cards add primary key (user_id, id);
--    のようにコンポジット化する。MVP では単独 PK + RLS フィルタで足りる。
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- 4. user_id によるインデックス（クエリ効率化）
-- ---------------------------------------------------------------------
create index if not exists cards_user_id_idx            on cards(user_id);
create index if not exists review_history_user_id_idx   on review_history(user_id);
create index if not exists mistakes_user_id_idx         on mistakes(user_id);
create index if not exists checkins_user_id_idx         on checkins(user_id);
create index if not exists imported_sources_user_id_idx on imported_sources(user_id);
create index if not exists today_events_user_id_idx     on today_events(user_id);

-- ---------------------------------------------------------------------
-- 5. user_id 自動セット用 default（auth.uid() を既定値に）
--    これで INSERT 時にクライアントが user_id を渡さなくても自分の uid が入る
-- ---------------------------------------------------------------------
alter table cards             alter column user_id set default auth.uid();
alter table review_history    alter column user_id set default auth.uid();
alter table mistakes          alter column user_id set default auth.uid();
alter table checkins          alter column user_id set default auth.uid();
alter table imported_sources  alter column user_id set default auth.uid();
alter table today_events      alter column user_id set default auth.uid();

-- ---------------------------------------------------------------------
-- 6. RLS 有効化
-- ---------------------------------------------------------------------
alter table cards             enable row level security;
alter table review_history    enable row level security;
alter table mistakes          enable row level security;
alter table checkins          enable row level security;
alter table imported_sources  enable row level security;
alter table today_events      enable row level security;

-- ---------------------------------------------------------------------
-- 7. ポリシー: 自分のデータのみ R/W
-- ---------------------------------------------------------------------
drop policy if exists "own_data" on cards;
create policy "own_data" on cards
  for all
  using      (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "own_data" on review_history;
create policy "own_data" on review_history
  for all
  using      (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "own_data" on mistakes;
create policy "own_data" on mistakes
  for all
  using      (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "own_data" on checkins;
create policy "own_data" on checkins
  for all
  using      (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "own_data" on imported_sources;
create policy "own_data" on imported_sources
  for all
  using      (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "own_data" on today_events;
create policy "own_data" on today_events
  for all
  using      (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- =====================================================================
-- Note:
--   service_role キー（PC スクリプト用）は RLS を bypass する。
--   service_role を使うときは user_id を必ず明示的に INSERT すること。
--   ブラウザ側（anon キー + 認証済セッション）は auth.uid() が自動で入る。
-- =====================================================================
