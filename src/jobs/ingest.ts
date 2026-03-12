import Parser from "rss-parser";
import { AirtableClient } from "../airtable/airtableClient.js";
import { DonorFields, PostFields } from "../airtable/fields.js";
import { Logger } from "../logger.js";
import { sha256Hex } from "../utils/crypto.js";
import { normalizeForHash } from "../utils/text.js";
import { isHttpUrl } from "../utils/url.js";

type Donor = Record<string, unknown>;
type Post = Record<string, unknown>;

const guessMediaType = (url: string, mimeType?: string) => {
  const lowerUrl = url.toLowerCase();
  const lowerMime = (mimeType ?? "").toLowerCase();
  if (lowerMime.startsWith("image/")) return "IMAGE" as const;
  if (lowerMime.startsWith("video/")) return "VIDEO" as const;
  if (/\.(png|jpe?g|gif|webp)(\?|$)/.test(lowerUrl)) return "IMAGE" as const;
  if (/\.(mp4|mov|webm)(\?|$)/.test(lowerUrl)) return "VIDEO" as const;
  return undefined;
};

const extractFirstImageUrlFromHtml = (html: string) => {
  // best-effort, not a full HTML parser
  const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return match?.[1];
};

const extractMediaFromItem = (item: any): { url: string; type?: "IMAGE" | "VIDEO" } | undefined => {
  const enclosureUrl = String(item?.enclosure?.url ?? "").trim();
  const enclosureType = String(item?.enclosure?.type ?? "").trim();
  if (enclosureUrl) {
    return { url: enclosureUrl, type: guessMediaType(enclosureUrl, enclosureType) };
  }
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

export const ingestJob = async (params: {
  airtable: AirtableClient;
  donorsTableName: string;
  postsTableName: string;
  logger: Logger;
  timezone: string;
  maxItemsPerDonor: number;
  ctaUrl: string;
  ctaTextEn: string;
  ctaTextUa: string;
}) => {
  const parser = new Parser();
  const createdPostRecordIds: string[] = [];
  let donorsCount = 0;
  let processedDonors = 0;
  let newSeeds = 0;
  let dedupedSeeds = 0;
  let errorsCount = 0;

  const donors = await params.airtable.listAll<Donor>(params.donorsTableName, {
    filterByFormula: `AND({${DonorFields.Status}}="Active", {${DonorFields.FeedUrl}}!="")`,
    maxRecords: 50
  });
  donorsCount = donors.length;

  for (const donor of donors) {
    const feedUrl = String(donor.fields?.[DonorFields.FeedUrl] ?? "").trim();
    const username = String(donor.fields?.[DonorFields.Username] ?? "").trim() || donor.id;
    if (!feedUrl) continue;

    try {
      processedDonors += 1;
      const feed = await parser.parseURL(feedUrl);
      const items = feed.items ?? [];
      const donorLanguageRaw = String(donor.fields?.[DonorFields.Language] ?? "UA").trim().toUpperCase();
      const donorLanguage = donorLanguageRaw === "EN" ? "EN" : "UA";

      const parseItemDate = (it: any) => {
        const iso = String(it?.isoDate ?? it?.pubDate ?? "").trim();
        const dt = iso ? new Date(iso) : undefined;
        return dt && !Number.isNaN(dt.getTime()) ? dt.getTime() : 0;
      };

      const selected = items
        .slice()
        .sort((a: any, b: any) => parseItemDate(b) - parseItemDate(a))
        .slice(0, Math.max(1, Math.min(params.maxItemsPerDonor, 20)));

      for (const item of selected) {
        const title = String(item.title ?? "").trim() || "Seed";
        const link = String(item.link ?? "").trim();
        const seedText =
          String((item as any).contentSnippet ?? "").trim() ||
          String((item as any).content ?? "").trim() ||
          title;
        const publishedAt = String((item as any).isoDate ?? (item as any).pubDate ?? "").trim();
        const rawMedia = extractMediaFromItem(item);
        const media = rawMedia?.url && isHttpUrl(rawMedia.url) ? rawMedia : undefined;

        const hashInput = normalizeForHash([title, link, seedText].filter(Boolean).join(" | "));
        const seedHash = sha256Hex(hashInput);

        if (link) {
          const existingByUrl = await params.airtable.listAll<Post>(params.postsTableName, {
            filterByFormula: `{${PostFields.SeedUrl}}="${link.replace(/"/g, '\\"')}"`,
            maxRecords: 1
          });
          if (existingByUrl.length > 0) {
            dedupedSeeds += 1;
            continue;
          }
        }

        const existing = await params.airtable.listAll<Post>(params.postsTableName, {
          filterByFormula: `{${PostFields.SeedHash}}="${seedHash}"`,
          maxRecords: 1
        });
        if (existing.length > 0) {
          dedupedSeeds += 1;
          continue;
        }

        const fields: Record<string, unknown> = {
          [PostFields.Title]: title,
          [PostFields.SeedText]: seedText,
          [PostFields.SeedUrl]: link || undefined,
          [PostFields.SeedPublishedAt]: publishedAt || undefined,
          [PostFields.SeedAuthor]: username || undefined,
          [PostFields.SeedHash]: seedHash,
          [PostFields.PostStatus]: "Seeded",
          [PostFields.Language]: donorLanguage,
          [PostFields.CtaText]: donorLanguage === "EN" ? params.ctaTextEn : params.ctaTextUa,
          [PostFields.CtaUrl]: params.ctaUrl,
          [PostFields.Source]: [donor.id],
          ...(media?.url ? { [PostFields.MediaUrl]: media.url } : {}),
          ...(media?.type ? { [PostFields.MediaType]: media.type } : {}),
          ...(media?.url ? { [PostFields.MediaAltText]: title } : {})
        };

        const created = await params.airtable.createRecord(params.postsTableName, fields);
        createdPostRecordIds.push(created.id);
        newSeeds += 1;
      }

      await params.airtable.updateRecord(params.donorsTableName, donor.id, {
        [DonorFields.LastFetchedAt]: new Date().toISOString()
      } as any);
    } catch (error) {
      errorsCount += 1;
      await params.logger.log({
        level: "ERROR",
        subsystem: "INGEST",
        message: `Ingest failed for donor ${username}`,
        error,
        meta: { feedUrl }
      });
    }
  }

  await params.logger.log({
    level: "INFO",
    subsystem: "INGEST",
    message:
      donorsCount === 0
        ? `Ingest: no active donors with Feed URL (table: ${params.donorsTableName})`
        : `Ingest: donors=${donorsCount}, processed=${processedDonors}, new_seeds=${newSeeds}, deduped=${dedupedSeeds}, errors=${errorsCount}`,
    meta: { donorsCount, processedDonors, newSeeds, dedupedSeeds, errorsCount }
  });

  return { createdPostRecordIds, newSeeds, dedupedSeeds, donorsCount, processedDonors, errorsCount };
};
