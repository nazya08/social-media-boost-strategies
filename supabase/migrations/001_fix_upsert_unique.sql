-- Fix unique indexes so `upsert(..., { onConflict: "account_key,seed_hash" })` works.
-- This assumes you use the default prefix: `social_media_strategy_`.
-- If you changed the prefix, replace table names accordingly.

-- 1) Normalize NULL/blank account_key to DEFAULT (required if columns were nullable before)
update public.social_media_strategy_threads_donors
set account_key = 'DEFAULT'
where account_key is null or btrim(account_key) = '';

update public.social_media_strategy_posts
set account_key = 'DEFAULT'
where account_key is null or btrim(account_key) = '';

-- 2) Make account_key NOT NULL + default (safe if already applied)
alter table public.social_media_strategy_threads_donors
  alter column account_key set default 'DEFAULT',
  alter column account_key set not null;

alter table public.social_media_strategy_posts
  alter column account_key set default 'DEFAULT',
  alter column account_key set not null;

-- 3) Drop partial unique indexes (if they exist from older schema)
drop index if exists public.ux_smst_posts_account_seed_hash;
drop index if exists public.ux_smst_posts_account_seed_url;

-- 4) Re-create non-partial unique indexes for upsert
create unique index if not exists ux_smst_posts_account_seed_hash on public.social_media_strategy_posts (account_key, seed_hash);
create unique index if not exists ux_smst_posts_account_seed_url on public.social_media_strategy_posts (account_key, seed_url);

