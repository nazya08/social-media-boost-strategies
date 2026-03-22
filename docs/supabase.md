# Supabase migration (Airtable replacement)

This project can use Supabase/Postgres instead of Airtable to avoid Airtable Public API call limits.

## 1) Create schema

- In Supabase dashboard → **SQL Editor**
- Run `supabase/schema.sql` (creates tables with prefix `social_media_strategy_`)
  - If you already ran an older schema and `upsert` fails, also run `supabase/migrations/001_fix_upsert_unique.sql`

## 2) Import existing Airtable data (CSV exports)

Ensure you have these files in repo:

- `data/Threads Donors-Grid view.csv`
- `data/Posts-Grid view.csv`

Then run:

```bash
node scripts/supabase/import-airtable-csv.mjs
```

If you accidentally imported twice and donors got duplicated, run:

- `supabase/migrations/002_dedup_donors_and_unique.sql`

Requires env:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_TABLE_PREFIX=social_media_strategy_`

## 3) Switch runtime to Supabase

Set env:

- `DATA_STORE=supabase`
- `SUPABASE_TABLE_PREFIX=social_media_strategy_`
- keep existing Threads/Anthropic envs as-is

Deploy to Vercel and run:

`/api/cron?accounts=DEFAULT&secret=...`
