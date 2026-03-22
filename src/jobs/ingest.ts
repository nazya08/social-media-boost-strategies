import Parser from "rss-parser";
import { Logger } from "../logger.js";
import { DataStore } from "../store/store.js";
import { sha256Hex } from "../utils/crypto.js";
import { normalizeForHash } from "../utils/text.js";
import { isHttpUrl } from "../utils/url.js";

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
  store: DataStore;
  logger: Logger;
  timezone: string;
  maxItemsPerDonor: number;
  ctaUrl: string;
  ctaTextEn: string;
  ctaTextUa: string;
  skipMediaDefault?: boolean;
  autoDisableOn402?: boolean;
  accountKey?: string;
  treatBlankAccountKeyAsMatch?: boolean;
}) => {
  const parser = new Parser({
    headers: {
      // Some RSS providers block "unknown" clients; a stable UA reduces accidental blocks.
      "User-Agent": "ThreadsAutoposter/1.0 (+rss-parser)"
    }
  });

  const createdPostRecordIds: string[] = [];
  let donorsCount = 0;
  let processedDonors = 0;
  let newSeeds = 0;
  let dedupedSeeds = 0;
  let skippedMediaSeeds = 0;
  let errorsCount = 0;

  const donors = await params.store.listActiveDonors({
    accountKey: params.accountKey,
    treatBlankAccountKeyAsMatch: params.treatBlankAccountKeyAsMatch,
    maxRecords: 50
  });
  donorsCount = donors.length;

  for (const donor of donors) {
    const feedUrl = String(donor.feedUrl ?? "").trim();
    const username = String(donor.username ?? "").trim() || donor.id;
    if (!feedUrl) continue;

    try {
      processedDonors += 1;
      const feed = await parser.parseURL(feedUrl);
      const items = feed.items ?? [];
      const donorLanguage = donor.language === "EN" ? "EN" : "UA";
      const skipMedia = (donor.skipMedia ?? params.skipMediaDefault) ?? false;

      const take = Math.max(1, Math.min(params.maxItemsPerDonor, 20));
      const top = items.slice(0, take);

      for (const item of top) {
        const title = String(item?.title ?? "").trim();
        const link = String(item?.link ?? "").trim();
        const publishedAtRaw = item?.isoDate ?? item?.pubDate ?? "";
        const publishedAt = publishedAtRaw ? new Date(publishedAtRaw).toISOString() : undefined;
        const seedText = String(item?.contentSnippet ?? item?.content ?? item?.summary ?? "").trim();
        const media = extractMediaFromItem(item);

        if (!title && !seedText) continue;
        if (link && !isHttpUrl(link)) continue;
        if (skipMedia && media?.url) {
          skippedMediaSeeds += 1;
          continue;
        }

        const hashInput = normalizeForHash([title, link, seedText].filter(Boolean).join(" | "));
        const seedHash = sha256Hex(hashInput);

        if (link) {
          const existsByUrl = await params.store.hasPostBySeedUrl({
            seedUrl: link,
            accountKey: params.accountKey,
            treatBlankAccountKeyAsMatch: params.treatBlankAccountKeyAsMatch
          });
          if (existsByUrl) {
            dedupedSeeds += 1;
            continue;
          }
        }

        const existsByHash = await params.store.hasPostBySeedHash({
          seedHash,
          accountKey: params.accountKey,
          treatBlankAccountKeyAsMatch: params.treatBlankAccountKeyAsMatch
        });
        if (existsByHash) {
          dedupedSeeds += 1;
          continue;
        }

        const created = await params.store.createSeedPost({
          title,
          seedText,
          seedUrl: link || undefined,
          seedPublishedAtIso: publishedAt,
          seedAuthor: username || undefined,
          seedHash,
          language: donorLanguage,
          ctaText: donorLanguage === "EN" ? params.ctaTextEn : params.ctaTextUa,
          ctaUrl: params.ctaUrl,
          sourceId: donor.id,
          mediaUrl: media?.url,
          mediaType: media?.type,
          mediaAltText: media?.url ? title : undefined,
          accountKey: params.accountKey
        });

        createdPostRecordIds.push(created.postId);
        newSeeds += 1;
      }

      await params.store.touchDonorFetchedAt({ donorId: donor.id, fetchedAtIso: new Date().toISOString() });
    } catch (error) {
      errorsCount += 1;

      const statusCode = (error as any)?.statusCode;
      const is402 = statusCode === 402 || (error instanceof Error && /status code\s*402/i.test(String(error.message ?? "")));
      if (is402 && params.autoDisableOn402) {
        try {
          const nowIso = new Date().toISOString();
          const existingNotes = String(donor.notes ?? "").trim();
          const noteLine = `[AUTO] Disabled donor due to RSS 402 (Payment Required) at ${nowIso}`;
          const notes = existingNotes ? `${existingNotes}\n${noteLine}` : noteLine;
          await params.store.updateDonor({ donorId: donor.id, status: "Inactive", notes });
        } catch {
          // ignore donor status update failures
        }
      }

      await params.logger.log({
        level: "ERROR",
        subsystem: "INGEST",
        message: `Ingest failed for donor ${username}`,
        error,
        meta: { feedUrl, statusCode, autoDisabled: Boolean(is402 && params.autoDisableOn402) }
      });
    }
  }

  await params.logger.log({
    level: "INFO",
    subsystem: "INGEST",
    message:
      donorsCount === 0
        ? `Ingest: no active donors with Feed URL`
        : `Ingest: donors=${donorsCount}, processed=${processedDonors}, new_seeds=${newSeeds}, deduped=${dedupedSeeds}, skipped_media=${skippedMediaSeeds}, errors=${errorsCount}`,
    meta: { donorsCount, processedDonors, newSeeds, dedupedSeeds, skippedMediaSeeds, errorsCount }
  });

  return { createdPostRecordIds, newSeeds, dedupedSeeds, skippedMediaSeeds, donorsCount, processedDonors, errorsCount };
};

