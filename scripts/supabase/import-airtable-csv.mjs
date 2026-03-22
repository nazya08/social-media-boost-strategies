import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parse } from "csv-parse/sync";
import { createClient } from "@supabase/supabase-js";

const requiredEnv = (name) => {
  const v = String(process.env[name] ?? "").trim();
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
};

const SUPABASE_URL = requiredEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
const RAW_PREFIX = String(process.env.SUPABASE_TABLE_PREFIX ?? "").trim();
const PREFIX = RAW_PREFIX ? (RAW_PREFIX.endsWith("_") ? RAW_PREFIX : `${RAW_PREFIX}_`) : "";
const withPrefix = (name) => {
  const base = String(name ?? "").trim();
  if (!PREFIX) return base;
  if (base.startsWith(PREFIX)) return base;
  return `${PREFIX}${base}`;
};

const DONORS_TABLE = withPrefix(process.env.SUPABASE_DONORS_TABLE_NAME ?? "threads_donors");
const POSTS_TABLE = withPrefix(process.env.SUPABASE_POSTS_TABLE_NAME ?? "posts");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const normalizeAccountKey = (raw) => String(raw ?? "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");

const normalizeForHash = (text) =>
  String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .toLowerCase();

const sha256Hex = (text) => crypto.createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");

const toBool = (raw) => {
  const v = String(raw ?? "").trim().toLowerCase();
  if (!v) return false;
  return ["1", "true", "yes", "y", "on", "checked"].includes(v);
};

const toIsoOrNull = (raw) => {
  const v = String(raw ?? "").trim();
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
};

const toInt = (raw, def = 0) => {
  const n = Number.parseInt(String(raw ?? "").trim(), 10);
  return Number.isFinite(n) ? n : def;
};

const readCsv = (filePath) => {
  const text = fs.readFileSync(filePath, "utf8");
  return parse(text, { columns: true, skip_empty_lines: true, relax_quotes: true });
};

const main = async () => {
  const donorsPath = path.join(process.cwd(), "data", "Threads Donors-Grid view.csv");
  const postsPath = path.join(process.cwd(), "data", "Posts-Grid view.csv");

  if (!fs.existsSync(donorsPath)) throw new Error(`Missing file: ${donorsPath}`);
  if (!fs.existsSync(postsPath)) throw new Error(`Missing file: ${postsPath}`);

  const donors = readCsv(donorsPath);
  const donorRows = donors
    .map((r) => ({
      username: String(r["Username"] ?? "").trim() || null,
      profile_url: String(r["Profile URL"] ?? "").trim() || null,
      platform: String(r["Platform"] ?? "").trim() || null,
      feed_url: String(r["Feed URL"] ?? "").trim(),
      status: String(r["Status"] ?? "Active").trim() || "Active",
      language: String(r["Language"] ?? "UA").trim().toUpperCase() === "EN" ? "EN" : "UA",
      account_key: r["Account Key"] ? normalizeAccountKey(r["Account Key"]) : "DEFAULT",
      skip_media: toBool(r["Skip Media"]),
      last_fetched_at: toIsoOrNull(r["Last Fetched At"]),
      notes: String(r["Notes"] ?? "").trim() || null
    }))
    .filter((r) => r.feed_url);

  if (donorRows.length > 0) {
    const { error } = await supabase
      .from(DONORS_TABLE)
      .upsert(donorRows, { onConflict: "account_key,feed_url", ignoreDuplicates: true });
    if (error) throw new Error(`Donors import failed: ${error.message}`);
    // eslint-disable-next-line no-console
    console.log(`Imported donors: ${donorRows.length}`);
  }

  const posts = readCsv(postsPath);
  const postRows = posts
    .map((r) => {
      const threadPartsRaw = String(r["Thread Parts JSON"] ?? "").trim();
      let thread_parts_json = null;
      if (threadPartsRaw) {
        try {
          const parsed = JSON.parse(threadPartsRaw);
          if (Array.isArray(parsed)) thread_parts_json = parsed;
        } catch {
          // keep null
        }
      }
      const accountKey = r["Account Key"] ? normalizeAccountKey(r["Account Key"]) : "DEFAULT";

      const seedTitle = String(r["Title"] ?? "").trim();
      const seedText = String(r["Seed Text"] ?? "").trim();
      const seedUrl = String(r["Seed URL"] ?? "").trim();
      const seedHashExisting = String(r["Seed Hash"] ?? "").trim();
      const seedHash = seedHashExisting || sha256Hex(normalizeForHash([seedTitle, seedUrl, seedText].filter(Boolean).join(" | ")));

      return {
        title: String(r["Title"] ?? "").trim() || null,
        seed_text: String(r["Seed Text"] ?? "").trim() || null,
        attachment_summary: String(r["Attachment Summary"] ?? "").trim() || null,
        post_status: String(r["Post Status"] ?? "Seeded").trim() || "Seeded",
        format: String(r["Format"] ?? "").trim() || null,
        language: String(r["Language"] ?? "UA").trim().toUpperCase() === "EN" ? "EN" : "UA",
        seed_url: seedUrl || null,
        seed_published_at: toIsoOrNull(r["Seed Published At"]),
        seed_author: String(r["Seed Author"] ?? "").trim() || null,
        seed_hash: seedHash || null,
        thread_parts_json,
        thread_preview: String(r["Thread Preview"] ?? "").trim() || null,
        cta_text: String(r["CTA Text"] ?? "").trim() || null,
        cta_url: String(r["CTA URL"] ?? "").trim() || null,
        attribution_url: String(r["Attribution URL"] ?? "").trim() || null,
        threads_root_id: String(r["Threads Root ID"] ?? "").trim() || null,
        threads_root_url: String(r["Threads Root URL"] ?? "").trim() || null,
        scheduled_at: toIsoOrNull(r["Scheduled At"]),
        published_at: toIsoOrNull(r["Published At"]),
        attempt_count: toInt(r["Attempt Count"], 0),
        last_attempt_at: toIsoOrNull(r["Last Attempt At"]),
        error: String(r["Error"] ?? "").trim() || null,
        tags: String(r["Tags"] ?? "").trim() || null,
        source: String(r["Source"] ?? "").trim() || null,
        media_url: String(r["Media URL"] ?? "").trim() || null,
        media_type: String(r["Media Type"] ?? "").trim() || null,
        media_alt_text: String(r["Media Alt Text"] ?? "").trim() || null,
        failure_subsystem: String(r["Failure Subsystem"] ?? "").trim() || null,
        account_key: accountKey
      };
    })
    .filter((r) => r.seed_hash || r.seed_url || r.title || r.seed_text);

  // Insert in chunks to avoid request size limits.
  const chunkSize = 500;
  let imported = 0;
  for (let i = 0; i < postRows.length; i += chunkSize) {
    const chunk = postRows.slice(i, i + chunkSize);
    const { error } = await supabase.from(POSTS_TABLE).upsert(chunk, { onConflict: "account_key,seed_hash", ignoreDuplicates: true });
    if (error) throw new Error(`Posts import failed (chunk ${i}-${i + chunk.length}): ${error.message}`);
    imported += chunk.length;
    // eslint-disable-next-line no-console
    console.log(`Imported posts: ${imported}/${postRows.length}`);
  }
};

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});
