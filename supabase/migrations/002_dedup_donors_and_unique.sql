-- Deduplicate donors created by repeated CSV imports and add a unique index
-- to make future imports idempotent.
-- Default prefix: `social_media_strategy_`

-- 1) Normalize NULL/blank account_key to DEFAULT
update public.social_media_strategy_threads_donors
set account_key = 'DEFAULT'
where account_key is null or btrim(account_key) = '';

-- 2) Dedup by (account_key, feed_url), keep newest updated_at/created_at
with ranked as (
  select
    id,
    row_number() over (
      partition by account_key, feed_url
      order by updated_at desc nulls last, created_at desc nulls last
    ) as rn
  from public.social_media_strategy_threads_donors
)
delete from public.social_media_strategy_threads_donors d
using ranked r
where d.id = r.id and r.rn > 1;

-- 3) Ensure not null/default (safe if already applied)
alter table public.social_media_strategy_threads_donors
  alter column account_key set default 'DEFAULT',
  alter column account_key set not null;

-- 4) Add unique index (required for `upsert(..., { onConflict: "account_key,feed_url" })`)
create unique index if not exists ux_smst_threads_donors_account_feed_url
on public.social_media_strategy_threads_donors (account_key, feed_url);

