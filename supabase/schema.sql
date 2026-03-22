-- Supabase schema for Threads autoposter (Airtable replacement)

-- Required for gen_random_uuid()
create extension if not exists "pgcrypto";

create table if not exists public.social_media_strategy_threads_donors (
  id uuid primary key default gen_random_uuid(),
  username text,
  profile_url text,
  platform text,
  feed_url text not null,
  status text not null default 'Active',
  language text not null default 'UA',
  account_key text not null default 'DEFAULT',
  skip_media boolean not null default false,
  last_fetched_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_smst_threads_donors_status on public.social_media_strategy_threads_donors (status);
create index if not exists idx_smst_threads_donors_account_key on public.social_media_strategy_threads_donors (account_key);
create unique index if not exists ux_smst_threads_donors_account_feed_url on public.social_media_strategy_threads_donors (account_key, feed_url);

create table if not exists public.social_media_strategy_posts (
  id uuid primary key default gen_random_uuid(),
  title text,
  seed_text text,
  attachment_summary text,
  post_status text not null default 'Seeded',
  format text,
  language text not null default 'UA',
  seed_url text,
  seed_published_at timestamptz,
  seed_author text,
  seed_hash text,
  thread_parts_json jsonb,
  thread_preview text,
  cta_text text,
  cta_url text,
  attribution_url text,
  threads_root_id text,
  threads_root_url text,
  scheduled_at timestamptz,
  published_at timestamptz,
  attempt_count integer not null default 0,
  last_attempt_at timestamptz,
  error text,
  tags text,
  source text,
  source_id text,
  media_url text,
  media_type text,
  media_alt_text text,
  failure_subsystem text,
  account_key text not null default 'DEFAULT',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_smst_posts_status on public.social_media_strategy_posts (post_status);
create index if not exists idx_smst_posts_account_key on public.social_media_strategy_posts (account_key);
create index if not exists idx_smst_posts_published_at on public.social_media_strategy_posts (published_at desc);
create index if not exists idx_smst_posts_seed_published_at on public.social_media_strategy_posts (seed_published_at desc);

-- Dedup safety: avoid re-seeding the same content per account.
-- NOTE: do NOT use partial unique indexes here because our import script uses `upsert(..., { onConflict: "account_key,seed_hash" })`,
-- which requires a matching unique constraint/index without a predicate.
create unique index if not exists ux_smst_posts_account_seed_hash on public.social_media_strategy_posts (account_key, seed_hash);
create unique index if not exists ux_smst_posts_account_seed_url on public.social_media_strategy_posts (account_key, seed_url);

create table if not exists public.social_media_strategy_run_logs (
  id uuid primary key default gen_random_uuid(),
  timestamp timestamptz not null,
  level text not null,
  subsystem text not null,
  post_id text,
  message text not null,
  error_stack text,
  meta_json text,
  created_at timestamptz not null default now()
);

create index if not exists idx_smst_run_logs_timestamp on public.social_media_strategy_run_logs (timestamp desc);

-- updated_at triggers
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_smst_threads_donors_updated_at on public.social_media_strategy_threads_donors;
create trigger trg_smst_threads_donors_updated_at
before update on public.social_media_strategy_threads_donors
for each row execute function public.set_updated_at();

drop trigger if exists trg_smst_posts_updated_at on public.social_media_strategy_posts;
create trigger trg_smst_posts_updated_at
before update on public.social_media_strategy_posts
for each row execute function public.set_updated_at();
