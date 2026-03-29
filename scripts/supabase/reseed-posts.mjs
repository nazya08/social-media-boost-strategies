import "dotenv/config";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const normalizeAccountKey = (raw) => String(raw ?? "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");

const requireEnv = (name) => {
  const v = String(process.env[name] ?? "").trim();
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
};

const sha256Hex = (input) => crypto.createHash("sha256").update(String(input)).digest("hex");

const getArg = (name) => {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
};

const main = async () => {
  const accountKey = normalizeAccountKey(getArg("account") ?? getArg("accountKey") ?? "");
  if (!accountKey) {
    throw new Error("Usage: node scripts/supabase/reseed-posts.mjs --account AI_BUILDERS_LAB [--count 5]");
  }

  const count = Number.parseInt(String(getArg("count") ?? "5"), 10);
  if (!Number.isFinite(count) || count <= 0) throw new Error("--count must be a positive integer");

  const url = requireEnv("SUPABASE_URL");
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const prefix = String(process.env.SUPABASE_TABLE_PREFIX ?? "").trim();
  const postsTable = `${prefix}posts`;

  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: existing, error: selectError } = await client
    .from(postsTable)
    .select(
      "id,title,seed_text,attachment_summary,language,seed_url,seed_published_at,seed_author,cta_text,cta_url,attribution_url,source,source_id,account_key,media_url,media_type,media_alt_text"
    )
    .eq("account_key", accountKey)
    .eq("post_status", "Published")
    .order("published_at", { ascending: false })
    .limit(Math.max(count, 10));

  if (selectError) throw new Error(`Select failed: ${selectError.message}`);
  if (!existing || existing.length === 0) throw new Error(`No Published posts found for account ${accountKey}`);

  const picked = existing.slice(0, count);
  const nowIso = new Date().toISOString();

  const rows = picked.map((p, idx) => {
    const rand = crypto.randomUUID().slice(0, 8);
    const baseUrl = String(p.seed_url ?? p.attribution_url ?? "").trim();
    const reseedUrl = baseUrl
      ? baseUrl.includes("#")
        ? `${baseUrl}-reseed_${rand}`
        : `${baseUrl}#reseed_${rand}`
      : undefined;

    const seedText = String(p.seed_text ?? "").trim();
    const seedTitle = String(p.title ?? "").trim();
    const seedHash = sha256Hex(`reseed|${accountKey}|${nowIso}|${idx}|${rand}|${seedTitle}|${seedText}`);

    return {
      // keep seed payload
      title: seedTitle || null,
      seed_text: seedText || null,
      attachment_summary: String(p.attachment_summary ?? "").trim() || null,
      language: String(p.language ?? "UA").trim().toUpperCase() === "EN" ? "EN" : "UA",
      seed_url: reseedUrl || null,
      seed_published_at: p.seed_published_at ?? null,
      seed_author: String(p.seed_author ?? "").trim() || null,
      seed_hash: seedHash,
      source: String(p.source ?? "").trim() || null,
      source_id: String(p.source_id ?? "").trim() || null,
      account_key: accountKey,

      // reset lifecycle fields
      post_status: "Seeded",
      format: null,
      thread_parts_json: null,
      thread_preview: null,
      cta_text: null,
      cta_url: null,
      attribution_url: null,
      threads_root_id: null,
      threads_root_url: null,
      scheduled_at: null,
      published_at: null,
      attempt_count: 0,
      last_attempt_at: null,
      error: null,
      failure_subsystem: null,

      // do not carry media forward for manual reseed
      media_url: null,
      media_type: null,
      media_alt_text: null
    };
  });

  const { data: inserted, error: insertError } = await client.from(postsTable).insert(rows).select("id,seed_url,seed_hash");
  if (insertError) throw new Error(`Insert failed: ${insertError.message}`);

  console.log(JSON.stringify({ ok: true, accountKey, insertedCount: inserted?.length ?? 0, inserted }, null, 2));
};

await main();

