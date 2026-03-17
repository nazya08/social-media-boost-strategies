import "dotenv/config";

const requiredEnv = (name) => {
  const v = String(process.env[name] ?? "").trim();
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
};

const apiKey = requiredEnv("AIRTABLE_API_KEY");
const baseId = requiredEnv("AIRTABLE_BASE_ID");
const donorsTableName = String(process.env.AIRTABLE_DONORS_TABLE_NAME ?? "Threads Donors").trim() || "Threads Donors";

const apiFetch = async (url, init = {}) => {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Airtable HTTP ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
};

const main = async () => {
  const tablesResp = await apiFetch(`https://api.airtable.com/v0/meta/bases/${baseId}/tables`);
  const tables = Array.isArray(tablesResp?.tables) ? tablesResp.tables : [];
  const table = tables.find((t) => String(t?.name ?? "") === donorsTableName);
  if (!table?.id) {
    const available = tables.map((t) => t?.name).filter(Boolean).join(", ");
    throw new Error(`Could not find table "${donorsTableName}". Available: ${available || "(none)"}`);
  }

  const fields = Array.isArray(table?.fields) ? table.fields : [];
  const existing = fields.find((f) => String(f?.name ?? "") === "Skip Media");
  if (existing) {
    console.log('Airtable: field "Skip Media" already exists in Threads Donors.');
    return;
  }

  await apiFetch(`https://api.airtable.com/v0/meta/bases/${baseId}/tables/${table.id}/fields`, {
    method: "POST",
    body: JSON.stringify({
      name: "Skip Media",
      type: "checkbox",
      description: "If enabled, ingest skips RSS items that contain images/videos.",
      options: { icon: "check", color: "greenBright" }
    })
  });

  console.log('Airtable: created checkbox field "Skip Media" in Threads Donors.');
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

