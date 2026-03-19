import "dotenv/config";

const requiredEnv = (name) => {
  const v = String(process.env[name] ?? "").trim();
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
};

const apiKey = requiredEnv("AIRTABLE_API_KEY");
const baseId = requiredEnv("AIRTABLE_BASE_ID");
const postsTableName = String(process.env.AIRTABLE_TABLE_NAME ?? "Posts").trim() || "Posts";

const escapeAirtableString = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');

const apiFetch = async (url) => {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Airtable HTTP ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
};

const listAll = async (tableName, params) => {
  const records = [];
  let offset = undefined;
  do {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v === undefined || v === null || v === "") continue;
      sp.set(k, String(v));
    }
    if (offset) sp.set("offset", offset);
    const url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}?${sp.toString()}`;
    const data = await apiFetch(url);
    records.push(...(Array.isArray(data?.records) ? data.records : []));
    offset = data?.offset;
  } while (offset);
  return records;
};

const main = async () => {
  const accountKey = String(process.argv[2] ?? (process.env.THREADS_DEFAULT_ACCOUNT_KEY ?? "DEFAULT"))
    .trim()
    .toUpperCase();
  const limit = Number.parseInt(String(process.argv[3] ?? "50"), 10);
  const max = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 200)) : 50;

  const formula = `AND({Language}="EN", {Post Status}="Published", OR({Account Key}="", {Account Key}="${escapeAirtableString(
    accountKey
  )}"))`;
  const records = await listAll(postsTableName, {
    filterByFormula: formula,
    sort: JSON.stringify([{ field: "Published At", direction: "desc" }]),
    maxRecords: String(max)
  });

  const formats = {};
  for (const r of records) {
    const f = String(r?.fields?.Format ?? "").trim() || "(blank)";
    formats[f] = (formats[f] ?? 0) + 1;
  }

  const out = {
    ok: true,
    accountKey,
    pulled: records.length,
    formats
  };
  console.log(JSON.stringify(out, null, 2));
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

