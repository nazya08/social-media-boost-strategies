import "dotenv/config";
import Parser from "rss-parser";
import { createHash } from "node:crypto";

const requiredEnv = (name) => {
  const v = String(process.env[name] ?? "").trim();
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
};

const escapeAirtableString = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');

const countMatches = (text, re) => (String(text ?? "").match(re) ?? []).length;

const isHttpUrl = (value) => {
  try {
    const u = new URL(String(value));
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

const guessMediaType = (url, mimeType) => {
  const lowerUrl = String(url ?? "").toLowerCase();
  const lowerMime = String(mimeType ?? "").toLowerCase();
  if (lowerMime.startsWith("image/")) return "IMAGE";
  if (lowerMime.startsWith("video/")) return "VIDEO";
  if (/\.(png|jpe?g|gif|webp)(\?|$)/.test(lowerUrl)) return "IMAGE";
  if (/\.(mp4|mov|webm)(\?|$)/.test(lowerUrl)) return "VIDEO";
  return undefined;
};

const extractFirstImageUrlFromHtml = (html) => {
  const match = String(html ?? "").match(/<img[^>]+src=["']([^"']+)["']/i);
  return match?.[1];
};

const extractMediaFromItem = (item) => {
  const enclosureUrl = String(item?.enclosure?.url ?? "").trim();
  const enclosureType = String(item?.enclosure?.type ?? "").trim();
  if (enclosureUrl) return { url: enclosureUrl, type: guessMediaType(enclosureUrl, enclosureType) };

  const enclosures = Array.isArray(item?.enclosures) ? item.enclosures : [];
  if (enclosures.length > 0 && enclosures[0]?.url) {
    const url = String(enclosures[0].url).trim();
    const type = guessMediaType(url, String(enclosures[0]?.type ?? ""));
    return { url, type };
  }

  const mediaContent = item?.["media:content"];
  if (mediaContent) {
    const mc = Array.isArray(mediaContent) ? mediaContent[0] : mediaContent;
    const url = String(mc?.url ?? mc?.$?.url ?? "").trim();
    if (url) return { url, type: guessMediaType(url, String(mc?.type ?? "")) };
  }

  const html = String(item?.content ?? "");
  const imgUrl = html ? extractFirstImageUrlFromHtml(html) : undefined;
  if (imgUrl) return { url: imgUrl, type: guessMediaType(imgUrl) };
  return undefined;
};

const normalizeForHash = (text) =>
  String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const sha256Hex = (text) => createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");

const apiKey = requiredEnv("AIRTABLE_API_KEY");
const baseId = requiredEnv("AIRTABLE_BASE_ID");
const postsTableName = String(process.env.AIRTABLE_TABLE_NAME ?? "Posts").trim() || "Posts";
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
    const batch = Array.isArray(data?.records) ? data.records : [];
    records.push(...batch);
    offset = data?.offset;
  } while (offset);
  return records;
};

const createRecord = async (tableName, fields) => {
  const url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}`;
  const data = await apiFetch(url, { method: "POST", body: JSON.stringify({ fields }) });
  return data;
};

const parseItemDate = (it) => {
  const iso = String(it?.isoDate ?? it?.pubDate ?? "").trim();
  const dt = iso ? new Date(iso) : undefined;
  return dt && !Number.isNaN(dt.getTime()) ? dt.getTime() : 0;
};

const firstHttpUrl = (...candidates) => {
  for (const c of candidates) {
    const v = String(c ?? "").trim();
    if (v && isHttpUrl(v)) return v;
  }
  return "";
};

const coerceBool = (value) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (!v) return undefined;
    if (["1", "true", "yes", "y", "on"].includes(v)) return true;
    if (["0", "false", "no", "n", "off"].includes(v)) return false;
  }
  return undefined;
};

const main = async () => {
  const accountKeyRaw = process.argv[2] ?? "AI_SOLUTIONSHUB";
  const accountKey = String(accountKeyRaw).trim().toUpperCase();
  const targetCount = Number.parseInt(process.argv[3] ?? "3", 10);
  const count = Number.isFinite(targetCount) && targetCount > 0 ? targetCount : 3;

  const ctaUrl =
    String(process.env[`CTA_URL_${accountKey}`] ?? "").trim() ||
    String(process.env.CTA_URL ?? "https://t.me/solutions_247ai").trim();
  const ctaTextUa = String(process.env.CTA_TEXT_UA ?? "Більше про AI та автоматизацію тут:").trim();
  const ctaTextEn = String(process.env.CTA_TEXT_EN ?? "More about AI & automation here:").trim();

  const donorFilter = `AND({Status}=\"Active\", {Feed URL}!=\"\", {Account Key}=\"${escapeAirtableString(accountKey)}\")`;
  const donors = await listAll(donorsTableName, { filterByFormula: donorFilter, maxRecords: 50 });
  if (donors.length === 0) {
    throw new Error(`No active donors found for Account Key=${accountKey} in table "${donorsTableName}".`);
  }

  const parser = new Parser();
  const created = [];

  for (const donor of donors) {
    if (created.length >= count) break;

    const donorId = donor.id;
    const feedUrl = String(donor?.fields?.["Feed URL"] ?? "").trim();
    const username = String(donor?.fields?.["Username"] ?? "").trim() || donorId;
    const donorLanguageRaw = String(donor?.fields?.["Language"] ?? "UA").trim().toUpperCase();
    const donorLanguage = donorLanguageRaw === "EN" ? "EN" : "UA";
    const skipMedia = coerceBool(donor?.fields?.["Skip Media"]) ?? false;

    if (!feedUrl) continue;

    const feed = await parser.parseURL(feedUrl);
    const items = (feed.items ?? []).slice().sort((a, b) => parseItemDate(b) - parseItemDate(a));

    for (const item of items) {
      if (created.length >= count) break;

      const title = String(item?.title ?? "").trim() || "Seed";
      const link = firstHttpUrl(item?.link, item?.guid, item?.id, item?.linkUrl);
      const seedText = String(item?.contentSnippet ?? "").trim() || String(item?.content ?? "").trim() || title;
      const publishedAt = String(item?.isoDate ?? item?.pubDate ?? "").trim();

      const rawMedia = extractMediaFromItem(item);
      const media = rawMedia?.url && isHttpUrl(rawMedia.url) ? rawMedia : undefined;
      if (skipMedia && media?.url) continue;

      const existsFilter = `AND({Seed URL}=\"${escapeAirtableString(link)}\", {Account Key}=\"${escapeAirtableString(
        accountKey
      )}\")`;
      if (link) {
        const existing = await listAll(postsTableName, { filterByFormula: existsFilter, maxRecords: 1 });
        if (existing.length > 0) continue;
      }

      const hashInput = normalizeForHash([title, link, seedText].filter(Boolean).join(" | "));
      const seedHash = sha256Hex(hashInput);

      if (!link) {
        const hashExistsFilter = `AND({Seed Hash}=\"${escapeAirtableString(seedHash)}\", {Account Key}=\"${escapeAirtableString(
          accountKey
        )}\")`;
        const existingByHash = await listAll(postsTableName, { filterByFormula: hashExistsFilter, maxRecords: 1 });
        if (existingByHash.length > 0) continue;
      }

      const fields = {
        Title: title,
        "Seed Text": seedText,
        ...(link ? { "Seed URL": link } : {}),
        "Seed Published At": publishedAt || undefined,
        "Seed Author": username || undefined,
        "Seed Hash": seedHash,
        "Account Key": accountKey,
        "Post Status": "Seeded",
        Language: donorLanguage,
        "CTA Text": donorLanguage === "EN" ? ctaTextEn : ctaTextUa,
        "CTA URL": ctaUrl,
        Source: [donorId],
        ...(media?.url ? { "Media URL": media.url } : {}),
        ...(media?.type ? { "Media Type": media.type } : {}),
        ...(media?.url ? { "Media Alt Text": title } : {})
      };

      const rec = await createRecord(postsTableName, fields);
      created.push({ id: rec?.id, url: link || undefined });
    }
  }

  console.log(JSON.stringify({ ok: true, accountKey, createdCount: created.length, created }, null, 2));
  if (created.length < count) {
    console.log(
      `Note: created ${created.length}/${count}. Donor feed may not have more unseen items (or they lack link URLs).`
    );
  }
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
