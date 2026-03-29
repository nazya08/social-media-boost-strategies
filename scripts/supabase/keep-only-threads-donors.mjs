import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const requireEnv = (name) => {
  const v = String(process.env[name] ?? "").trim();
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
};

const hasFlag = (name) => process.argv.includes(`--${name}`);

const getArg = (name) => {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
};

const KEEP = [
  {
    username: "anjela.marketing",
    profile_url: "https://www.threads.com/@anjela.marketing",
    feed_url: "https://rss.app/feeds/4iQo38zdaefu1Pba.xml"
  },
  {
    username: "dailyprompter",
    profile_url: "https://www.threads.com/@dailyprompter",
    feed_url: "https://rss.app/feeds/zbUGMH8BATqz4UXG.xml"
  },
  {
    username: "bizziology",
    profile_url: "https://www.threads.com/@bizziology",
    feed_url: "https://rss.app/feeds/sUHd1hIbiEoMMrrU.xml"
  },
  {
    username: "vlad.ushakov.ai",
    profile_url: "https://www.threads.com/@vlad.ushakov.ai",
    feed_url: "https://rss.app/feeds/vbV5EcluaCgsParB.xml"
  }
];

const main = async () => {
  const apply = hasFlag("apply") || hasFlag("yes");
  const langRaw = String(getArg("lang") ?? getArg("language") ?? "EN").trim().toUpperCase();
  const language = langRaw === "EN" ? "EN" : "UA";

  const url = requireEnv("SUPABASE_URL");
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const prefix = String(process.env.SUPABASE_TABLE_PREFIX ?? "").trim();
  const donorsTable = `${prefix}threads_donors`;

  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: beforeRows, error: beforeErr } = await client
    .from(donorsTable)
    .select("id,username,profile_url,feed_url,status,account_key")
    .limit(5000);
  if (beforeErr) throw new Error(`Select before failed: ${beforeErr.message}`);

  const before = beforeRows ?? [];

  if (!apply) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          dryRun: true,
          donorsTable,
          beforeCount: before.length,
          keep: KEEP,
          toDeleteCount: before.length,
          hint: "Re-run with --apply to delete ALL donors and re-insert exactly the 4 keep rows (account_key=DEFAULT).",
          insertLanguage: language
        },
        null,
        2
      )
    );
    return;
  }

  const ids = before.map((r) => r.id).filter(Boolean);
  if (ids.length > 0) {
    const { error: delErr } = await client.from(donorsTable).delete().in("id", ids);
    if (delErr) throw new Error(`Delete failed: ${delErr.message}`);
  }

  const insertRows = KEEP.map((d) => ({
    username: d.username,
    profile_url: d.profile_url,
    platform: "threads",
    feed_url: d.feed_url,
    status: "Active",
    language,
    account_key: "DEFAULT",
    skip_media: false,
    notes: null
  }));

  const { data: inserted, error: insErr } = await client
    .from(donorsTable)
    .insert(insertRows)
    .select("id,username,profile_url,feed_url,status,account_key");
  if (insErr) throw new Error(`Insert failed: ${insErr.message}`);

  const { data: afterRows, error: afterErr } = await client
    .from(donorsTable)
    .select("id,username,profile_url,feed_url,status,account_key")
    .limit(100);
  if (afterErr) throw new Error(`Select after failed: ${afterErr.message}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRun: false,
        donorsTable,
        insertLanguage: language,
        deletedCount: ids.length,
        insertedCount: inserted?.length ?? 0,
        afterCount: (afterRows ?? []).length,
        afterRows: afterRows ?? []
      },
      null,
      2
    )
  );
};

await main();
