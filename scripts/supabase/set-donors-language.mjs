import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const requireEnv = (name) => {
  const v = String(process.env[name] ?? "").trim();
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
};

const normalizeAccountKey = (raw) => String(raw ?? "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");

const getArg = (name) => {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
};

const main = async () => {
  const accountKey = normalizeAccountKey(getArg("account") ?? getArg("accountKey") ?? "DEFAULT");
  const langRaw = String(getArg("lang") ?? getArg("language") ?? "EN").trim().toUpperCase();
  const language = langRaw === "EN" ? "EN" : "UA";

  const usernames = String(getArg("usernames") ?? "").trim();
  const keep = (usernames ? usernames.split(",") : ["anjela.marketing", "dailyprompter", "bizziology", "vlad.ushakov.ai"])
    .map((s) => s.trim())
    .filter(Boolean);
  if (keep.length === 0) throw new Error("No usernames to update. Provide --usernames a,b,c or omit to use default list.");

  const url = requireEnv("SUPABASE_URL");
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const prefix = String(process.env.SUPABASE_TABLE_PREFIX ?? "").trim();
  const donorsTable = `${prefix}threads_donors`;

  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: before, error: beforeErr } = await client
    .from(donorsTable)
    .select("id,username,language,status,account_key")
    .eq("account_key", accountKey)
    .in("username", keep)
    .limit(100);
  if (beforeErr) throw new Error(`Select before failed: ${beforeErr.message}`);

  const { error: updErr } = await client
    .from(donorsTable)
    .update({ language })
    .eq("account_key", accountKey)
    .in("username", keep);
  if (updErr) throw new Error(`Update failed: ${updErr.message}`);

  const { data: after, error: afterErr } = await client
    .from(donorsTable)
    .select("id,username,language,status,account_key")
    .eq("account_key", accountKey)
    .in("username", keep)
    .limit(100);
  if (afterErr) throw new Error(`Select after failed: ${afterErr.message}`);

  console.log(JSON.stringify({ ok: true, donorsTable, accountKey, language, updatedUsernames: keep, before: before ?? [], after: after ?? [] }, null, 2));
};

await main();

