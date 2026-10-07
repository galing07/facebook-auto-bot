-- Facebook Auto Bot Content Engine
-- Run after supabase/schema.sql.

create table if not exists trend_topics (
  id uuid primary key default gen_random_uuid(),
  keyword text not null,
  geo text not null default 'US',
  trend_source text not null default 'google_trends',
  trend_score numeric not null default 0,
  freshness_score numeric not null default 0,
  niche_score numeric not null default 0,
  safety_score numeric not null default 100,
  content_score numeric not null default 0,
  total_score numeric not null default 0,
  status text not null default 'new',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  used_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

create unique index if not exists trend_topics_keyword_geo_idx
  on trend_topics (lower(keyword), geo);

create index if not exists trend_topics_queue_idx
  on trend_topics (geo, status, total_score desc, last_seen_at desc);
