import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const normalizeAccountKey = (raw) => String(raw ?? "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");

const requireEnv = (name) => {
  const v = String(process.env[name] ?? "").trim();
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
};

const getArg = (name) => {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
};

const hasFlag = (name) => process.argv.includes(`--${name}`);

const DONORS = [
  { username: "anjela.marketing", feedUrl: "https://rss.app/feeds/4iQo38zdaefu1Pba.xml" },
  { username: "dailyprompter", feedUrl: "https://rss.app/feeds/zbUGMH8BATqz4UXG.xml" },
  { username: "bizziology", feedUrl: "https://rss.app/feeds/sUHd1hIbiEoMMrrU.xml" },
  { username: "vlad.ushakov.ai", feedUrl: "https://rss.app/feeds/vbV5EcluaCgsParB.xml" }
];

const main = async () => {
  const accountKey = normalizeAccountKey(getArg("account") ?? getArg("accountKey") ?? "DEFAULT");
  const deactivateOthers = hasFlag("deactivate-others") || hasFlag("deactivateOthers");

  const url = requireEnv("SUPABASE_URL");
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const prefix = String(process.env.SUPABASE_TABLE_PREFIX ?? "").trim();
  const donorsTable = `${prefix}threads_donors`;

  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const results = [];
  const keepUsernames = new Set(DONORS.map((d) => String(d.username ?? "").trim()).filter(Boolean));

  for (const d of DONORS) {
    const username = String(d.username ?? "").trim();
    const feedUrl = String(d.feedUrl ?? "").trim();
    if (!username || !feedUrl) continue;

    const { data: existing, error: selErr } = await client
      .from(donorsTable)
      .select("id,username,feed_url,status,account_key")
      .eq("account_key", accountKey)
      .eq("username", username)
      .limit(1);
    if (selErr) throw new Error(`Select donor failed (${username}): ${selErr.message}`);

    const row = (existing ?? [])[0];
    if (row?.id) {
      const { error: updErr } = await client
        .from(donorsTable)
        .update({ feed_url: feedUrl, status: "Active" })
        .eq("id", row.id);
      if (updErr) throw new Error(`Update donor failed (${username}): ${updErr.message}`);
      results.push({ action: "updated", id: row.id, username, feedUrl });
    } else {
      const { data: ins, error: insErr } = await client
        .from(donorsTable)
        .insert({ username, feed_url: feedUrl, status: "Active", language: "UA", account_key: accountKey })
        .select("id,username,feed_url,status,account_key");
      if (insErr) throw new Error(`Insert donor failed (${username}): ${insErr.message}`);
      results.push({ action: "inserted", id: ins?.[0]?.id, username, feedUrl });
    }
  }

  const deactivated = [];
  if (deactivateOthers) {
    const { data: activeAll, error: activeErr } = await client
      .from(donorsTable)
      .select("id,username,feed_url,status,account_key")
      .eq("account_key", accountKey)
      .eq("status", "Active")
      .limit(200);
    if (activeErr) throw new Error(`List donors for deactivation failed: ${activeErr.message}`);

    for (const row of activeAll ?? []) {
      const username = String(row?.username ?? "").trim();
      if (username && keepUsernames.has(username)) continue;
      const { error: updErr } = await client.from(donorsTable).update({ status: "Inactive" }).eq("id", row.id);
      if (updErr) throw new Error(`Deactivate donor failed (${row.id}): ${updErr.message}`);
      deactivated.push({ id: row.id, username: row?.username ?? null, feedUrl: row?.feed_url ?? null });
    }
  }

  const { data: active, error: listErr } = await client
    .from(donorsTable)
    .select("id,username,feed_url,status,account_key,last_fetched_at,updated_at")
    .eq("account_key", accountKey)
    .eq("status", "Active")
    .order("updated_at", { ascending: false })
    .limit(100);
  if (listErr) throw new Error(`List active donors failed: ${listErr.message}`);

  console.log(
    JSON.stringify(
      { ok: true, accountKey, donorsTable, changed: results, deactivated, activeDonors: active ?? [] },
      null,
      2
    )
  );
};

await main();
