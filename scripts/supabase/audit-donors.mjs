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

const groupBy = (rows, keyFn) => {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
};

const main = async () => {
  const onlyAccountKeyRaw = getArg("account") ?? getArg("accountKey");
  const onlyAccountKey = onlyAccountKeyRaw ? normalizeAccountKey(onlyAccountKeyRaw) : undefined;

  const url = requireEnv("SUPABASE_URL");
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const prefix = String(process.env.SUPABASE_TABLE_PREFIX ?? "").trim();
  const donorsTable = `${prefix}threads_donors`;

  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  let q = client
    .from(donorsTable)
    .select("id,username,feed_url,status,account_key,profile_url,platform,last_fetched_at,created_at,updated_at")
    .limit(1000);
  if (onlyAccountKey) q = q.eq("account_key", onlyAccountKey);

  const { data, error } = await q;
  if (error) throw new Error(`Select failed: ${error.message}`);
  const rows = data ?? [];

  const byAccount = groupBy(rows, (r) => String(r.account_key ?? "DEFAULT"));
  const accounts = Array.from(byAccount.keys()).sort();

  const summaryByAccount = accounts.map((ak) => {
    const accountRows = byAccount.get(ak);
    const active = accountRows.filter((r) => String(r.status ?? "") === "Active");
    const inactive = accountRows.filter((r) => String(r.status ?? "") !== "Active");
    return { accountKey: ak, total: accountRows.length, active: active.length, inactive: inactive.length };
  });

  const dupUsernamesByAccount = [];
  for (const ak of accounts) {
    const accountRows = byAccount.get(ak);
    const byUsername = groupBy(accountRows, (r) => String(r.username ?? "").trim().toLowerCase());
    for (const [uname, list] of byUsername.entries()) {
      if (!uname) continue;
      if (list.length > 1) {
        dupUsernamesByAccount.push({
          accountKey: ak,
          username: uname,
          count: list.length,
          ids: list.map((r) => r.id),
          feedUrls: Array.from(new Set(list.map((r) => r.feed_url)))
        });
      }
    }
  }

  const activeDonors = rows
    .filter((r) => String(r.status ?? "") === "Active")
    .sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")))
    .slice(0, 200);

  console.log(
    JSON.stringify(
      {
        ok: true,
        donorsTable,
        filterAccountKey: onlyAccountKey ?? null,
        summaryByAccount,
        duplicateUsernamesByAccount: dupUsernamesByAccount,
        activeDonors
      },
      null,
      2
    )
  );
};

await main();

