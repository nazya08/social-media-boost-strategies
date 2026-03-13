import { DateTime } from "luxon";
import { AirtableClient } from "../airtable/airtableClient.js";
import { PostFields } from "../airtable/fields.js";
import { Logger } from "../logger.js";
import { ThreadsClient } from "../services/threads.js";
import { TelegramClient } from "../services/telegram.js";
import { formatPublishProgress, parsePublishProgress, PublishProgress } from "../utils/publishProgress.js";
import { safeJsonParse } from "../utils/text.js";
import { isHttpUrl } from "../utils/url.js";

type Post = Record<string, unknown>;

const isAuthError = (error: unknown) => {
  if (!(error instanceof Error)) return false;
  return /\bHTTP 401\b|\bHTTP 403\b/.test(error.message);
};

const isMediaNotFoundError = (error: unknown) => {
  if (!(error instanceof Error)) return false;
  return error.message.includes("4279009") || /Media file/i.test(error.message) || /Медіафайл/i.test(error.message);
};

export const publishNowJob = async (params: {
  airtable: AirtableClient;
  postsTableName: string;
  logger: Logger;
  threads: ThreadsClient;
  telegram?: TelegramClient;
  timezone: string;
  maxCharsPerPart: number;
  autopublishEnabled: boolean;
  postMediaEnabled: boolean;
  recordIds?: string[];
  maxToPublish?: number;
  ctaUrlOverride?: string;
}): Promise<{ attempted: number; published: number; failed: number; criticalAlerts: number }> => {
  if (!params.autopublishEnabled) {
    await params.logger.log({ level: "INFO", subsystem: "PUBLISH", message: "PublishNow: AUTOPUBLISH_ENABLED=false; skipping" });
    return { attempted: 0, published: 0, failed: 0, criticalAlerts: 0 };
  }

  const idsFilter =
    params.recordIds && params.recordIds.length > 0
      ? `OR(${params.recordIds.map((id) => `RECORD_ID()="${id}"`).join(",")})`
      : undefined;
  const publishingWithProgress = `AND({${PostFields.PostStatus}}="Publishing", {${PostFields.Error}}!="", LEFT({${PostFields.Error}}, 9)="PROGRESS:")`;
  const publishingWithRootId = `AND({${PostFields.PostStatus}}="Publishing", {${PostFields.ThreadsRootId}}!="")`;
  const basePublishable = `OR(${publishingWithProgress}, ${publishingWithRootId}, {${PostFields.PostStatus}}="Generated", AND({${PostFields.PostStatus}}="Failed", {${PostFields.FailureSubsystem}}="PUBLISH", {${PostFields.AttemptCount}}<3, NOT(REGEX_MATCH({${PostFields.Error}}, "HTTP 401|HTTP 403"))))`;
  const filterByFormula = idsFilter ? `AND(${idsFilter}, ${basePublishable})` : basePublishable;

  const now = DateTime.now().setZone(params.timezone);

  // Recover posts stuck in Publishing (typically due to runtime timeout mid-thread).
  try {
    const stuck = await params.airtable.listAll<Post>(params.postsTableName, {
      filterByFormula: `AND({${PostFields.PostStatus}}="Publishing", {${PostFields.LastAttemptAt}}!="")`,
      maxRecords: 20,
      fields: [PostFields.LastAttemptAt, PostFields.AttemptCount, PostFields.Error, PostFields.ThreadsRootId]
    });
    const stuckMinutes = 20;
    for (const p of stuck) {
      const lastAttemptIso = String(p.fields?.[PostFields.LastAttemptAt] ?? "");
      const lastAttempt = lastAttemptIso ? DateTime.fromISO(lastAttemptIso).setZone(params.timezone) : undefined;
      const attempts = Number(p.fields?.[PostFields.AttemptCount] ?? 0);
      const currentError = String(p.fields?.[PostFields.Error] ?? "");
      const hasProgress = Boolean(parsePublishProgress(currentError));
      const isStale = !lastAttempt || !lastAttempt.isValid || lastAttempt < now.minus({ minutes: stuckMinutes });
      if (!isStale) continue;

      await params.airtable.updateRecord(params.postsTableName, p.id, {
        [PostFields.PostStatus]: attempts >= 3 ? "Failed" : "Generated",
        [PostFields.Error]: currentError || `Recovered from stuck Publishing (>${stuckMinutes}m). Please retry.`,
        [PostFields.FailureSubsystem]: "PUBLISH"
      } as any);
      await params.logger.log({
        level: "WARN",
        subsystem: "PUBLISH",
        message: `Recovered stuck Publishing post ${p.id} (attempts=${attempts}, hasProgress=${hasProgress})`,
        postRecordId: p.id,
        meta: { lastAttemptAtIso: lastAttemptIso, stuckMinutes }
      });
    }
  } catch (err) {
    await params.logger.log({
      level: "ERROR",
      subsystem: "PUBLISH",
      message: "Failed to recover stuck Publishing posts",
      error: err
    });
  }

  const candidates = await params.airtable.listAll<Post>(params.postsTableName, {
    filterByFormula,
    maxRecords: params.maxToPublish ?? 10,
    sortField: PostFields.SeedPublishedAt,
    sortDirection: "desc",
    fields: [
      PostFields.PostStatus,
      PostFields.AttemptCount,
      PostFields.ThreadPartsJson,
      PostFields.SeedUrl,
      PostFields.MediaUrl,
      PostFields.MediaType,
      PostFields.MediaAltText,
      PostFields.Error,
      PostFields.ThreadsRootId,
      PostFields.ThreadsRootUrl
    ]
  });

  if (candidates.length === 0) {
    await params.logger.log({
      level: "INFO",
      subsystem: "PUBLISH",
      message: "PublishNow: no publishable posts"
    });
    return { attempted: 0, published: 0, failed: 0, criticalAlerts: 0 };
  }

  let attempted = 0;
  let published = 0;
  let failedCount = 0;
  let criticalAlerts = 0;
  for (const post of candidates) {
    const postId = post.id;
    const currentStatus = String(post.fields?.[PostFields.PostStatus] ?? "").trim();
    const attemptCount = Number(post.fields?.[PostFields.AttemptCount] ?? 0);
    const rawParts = safeJsonParse<string[]>(String(post.fields?.[PostFields.ThreadPartsJson] ?? "")) ?? [];
    const existingError = String(post.fields?.[PostFields.Error] ?? "");
    const existingRootId = String(post.fields?.[PostFields.ThreadsRootId] ?? "").trim();
    const existingRootUrl = String(post.fields?.[PostFields.ThreadsRootUrl] ?? "").trim();
    let lastProgress: PublishProgress | undefined = undefined;

    const applyCtaOverride = (parts: string[]) => {
      const url = String(params.ctaUrlOverride ?? "").trim();
      if (!url || parts.length === 0) return parts;
      const updated = parts.slice();
      const idx = updated.length - 1;
      const last = String(updated[idx] ?? "").trim();
      const tmeRegex = /https?:\/\/t\.me\/[A-Za-z0-9_]+/g;
      if (tmeRegex.test(last)) {
        updated[idx] = last.replace(tmeRegex, url);
      } else if (!last.includes(url)) {
        updated[idx] = `${last} ${url}`.trim();
      }
      return updated;
    };

    const parts = applyCtaOverride(rawParts);

    const mediaUrl = String(post.fields?.[PostFields.MediaUrl] ?? "").trim();
    const mediaType = String(post.fields?.[PostFields.MediaType] ?? "").trim();
    const mediaAltText = String(post.fields?.[PostFields.MediaAltText] ?? "").trim();
    const rootMedia =
      params.postMediaEnabled && mediaUrl && isHttpUrl(mediaUrl) && (mediaType === "IMAGE" || mediaType === "VIDEO")
        ? ({ type: mediaType, url: mediaUrl, altText: mediaAltText || undefined } as any)
        : undefined;

    try {
      attempted += 1;

      let progress: PublishProgress | undefined = parsePublishProgress(existingError);
      if (!progress && currentStatus === "Publishing" && existingRootId) {
        // Best-effort resume for legacy stuck records that have a rootId but no progress marker.
        progress = {
          rootId: existingRootId,
          publishedIds: [existingRootId],
          nextIndex: 1,
          updatedAtIso: now.toISO() ?? new Date().toISOString()
        };
      }
      const isResume = Boolean(progress?.rootId) && Number(progress?.nextIndex ?? 0) >= 1;

      await params.logger.log({
        level: "INFO",
        subsystem: "PUBLISH",
        message: isResume
          ? `PublishNow: resuming post ${postId} from index ${progress!.nextIndex}/${parts.length} (attempt ${attemptCount + 1}/3)`
          : `PublishNow: starting post ${postId} (attempt ${attemptCount + 1}/3)`,
        postRecordId: postId,
        meta: {
          status: currentStatus,
          hasMedia: Boolean(rootMedia),
          partsCount: parts.length,
          partsLengths: parts.map((p) => String(p ?? "").length),
          hasProgress: Boolean(progress),
          progressNextIndex: progress?.nextIndex,
          progressPublishedCount: progress?.publishedIds?.length ?? 0
        }
      });

      let progressState: PublishProgress =
        progress ??
        ({
          rootId: undefined,
          publishedIds: [],
          nextIndex: 0,
          updatedAtIso: now.toISO() ?? new Date().toISOString()
        } satisfies PublishProgress);
      lastProgress = progressState;

      await params.airtable.updateRecord(params.postsTableName, postId, {
        [PostFields.PostStatus]: "Publishing",
        [PostFields.LastAttemptAt]: now.toISO(),
        [PostFields.AttemptCount]: attemptCount + 1,
        [PostFields.Error]: isResume ? formatPublishProgress({ ...progressState, updatedAtIso: now.toISO() ?? progressState.updatedAtIso }) : "",
        ...(params.ctaUrlOverride ? { [PostFields.CtaUrl]: params.ctaUrlOverride } : {})
      } as any);

      let result;
      try {
        const onPartPublished = async (ev: { partIndex: number; publishedId: string }) => {
          if (ev.partIndex === 0) progressState.rootId = ev.publishedId;
          if (!progressState.publishedIds.includes(ev.publishedId)) progressState.publishedIds.push(ev.publishedId);
          progressState.nextIndex = Math.max(progressState.nextIndex, ev.partIndex + 1);
          progressState.updatedAtIso = DateTime.now().setZone(params.timezone).toISO() ?? new Date().toISOString();
          lastProgress = { ...progressState, publishedIds: progressState.publishedIds.slice() };

          await params.airtable.updateRecord(params.postsTableName, postId, {
            ...(progressState.rootId ? { [PostFields.ThreadsRootId]: progressState.rootId } : {}),
            [PostFields.Error]: formatPublishProgress(progressState),
            [PostFields.LastAttemptAt]: DateTime.now().setZone(params.timezone).toISO()
          } as any);
        };

        const log = async (ev: any) => {
          await params.logger.log({
            level: ev.level,
            subsystem: "PUBLISH",
            message: `${ev.stage}: ${ev.message}`,
            postRecordId: postId,
            meta: ev.meta
          });
        };

        if (isResume) {
          const replyToId = progressState.publishedIds[progressState.publishedIds.length - 1] ?? progressState.rootId!;
          await params.threads.publishReplies({
            replyToId,
            parts,
            startIndex: Math.max(1, progressState.nextIndex),
            maxCharsPerPart: params.maxCharsPerPart,
            opts: { log, onPartPublished }
          });
          const rootId = progressState.rootId ?? existingRootId;
          if (!rootId) throw new Error("Resume publish failed: missing rootId");
          const permalink = existingRootUrl || (await params.threads.getPermalink(rootId)) || "";
          result = { rootId, rootPermalink: permalink, allIds: progressState.publishedIds.slice() };
        } else {
          result = await params.threads.publishThread(parts, params.maxCharsPerPart, rootMedia, { log, onPartPublished });
        }
      } catch (err) {
        if (rootMedia && isMediaNotFoundError(err)) {
          await params.logger.log({
            level: "WARN",
            subsystem: "PUBLISH",
            message: `Media attach failed for post ${postId}; retrying as TEXT-only`,
            postRecordId: postId,
            error: err,
            meta: { mediaUrl, mediaType }
          });

          const onPartPublished = async (ev: { partIndex: number; publishedId: string }) => {
            if (ev.partIndex === 0) progressState.rootId = ev.publishedId;
            if (!progressState.publishedIds.includes(ev.publishedId)) progressState.publishedIds.push(ev.publishedId);
            progressState.nextIndex = Math.max(progressState.nextIndex, ev.partIndex + 1);
            progressState.updatedAtIso = DateTime.now().setZone(params.timezone).toISO() ?? new Date().toISOString();
            lastProgress = { ...progressState, publishedIds: progressState.publishedIds.slice() };
            await params.airtable.updateRecord(params.postsTableName, postId, {
              ...(progressState.rootId ? { [PostFields.ThreadsRootId]: progressState.rootId } : {}),
              [PostFields.Error]: formatPublishProgress(progressState),
              [PostFields.LastAttemptAt]: DateTime.now().setZone(params.timezone).toISO()
            } as any);
          };

          const log = async (ev: any) => {
            await params.logger.log({
              level: ev.level,
              subsystem: "PUBLISH",
              message: `${ev.stage}: ${ev.message}`,
              postRecordId: postId,
              meta: ev.meta
            });
          };

          if (isResume) {
            const replyToId = progressState.publishedIds[progressState.publishedIds.length - 1] ?? progressState.rootId!;
            await params.threads.publishReplies({
              replyToId,
              parts,
              startIndex: Math.max(1, progressState.nextIndex),
              maxCharsPerPart: params.maxCharsPerPart,
              opts: { log, onPartPublished }
            });
            const rootId = progressState.rootId ?? existingRootId;
            if (!rootId) throw new Error("Resume publish failed: missing rootId");
            const permalink = existingRootUrl || (await params.threads.getPermalink(rootId)) || "";
            result = { rootId, rootPermalink: permalink, allIds: progressState.publishedIds.slice() };
          } else {
            result = await params.threads.publishThread(parts, params.maxCharsPerPart, undefined, { log, onPartPublished });
          }
        } else {
          throw err;
        }
      }
      await params.airtable.updateRecord(params.postsTableName, postId, {
        [PostFields.PostStatus]: "Published",
        [PostFields.PublishedAt]: now.toISO(),
        [PostFields.ThreadsRootId]: result.rootId,
        [PostFields.ThreadsRootUrl]: result.rootPermalink ?? "",
        [PostFields.FailureSubsystem]: null,
        [PostFields.Error]: ""
      } as any);

      await params.logger.log({
        level: "INFO",
        subsystem: "PUBLISH",
        message: `PublishNow: success post ${postId}`,
        postRecordId: postId,
        meta: { rootId: result.rootId, rootPermalink: result.rootPermalink }
      });
      published += 1;
    } catch (error) {
      const nextAttempt = attemptCount + 1;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const hardFail = nextAttempt >= 3;
      const critical = hardFail || isAuthError(error);

      const progressForError = lastProgress ?? parsePublishProgress(existingError);
      const errorFieldValue = progressForError ? formatPublishProgress(progressForError, errorMessage.slice(0, 800)) : errorMessage;

      await params.airtable.updateRecord(params.postsTableName, postId, {
        [PostFields.PostStatus]: hardFail || isAuthError(error) ? "Failed" : "Generated",
        [PostFields.Error]: errorFieldValue,
        [PostFields.LastAttemptAt]: now.toISO(),
        [PostFields.AttemptCount]: nextAttempt,
        [PostFields.FailureSubsystem]: "PUBLISH",
        ...(progressForError?.rootId ? { [PostFields.ThreadsRootId]: progressForError.rootId } : existingRootId ? { [PostFields.ThreadsRootId]: existingRootId } : {})
      } as any);

      await params.logger.log({
        level: critical ? "CRITICAL" : "ERROR",
        subsystem: "PUBLISH",
        message: `PublishNow failed for post ${postId} (attempt ${nextAttempt}/3)`,
        postRecordId: postId,
        error
      });
      failedCount += 1;

      if (critical && params.telegram) {
        const seedUrl = String(post.fields?.[PostFields.SeedUrl] ?? "");
        const summary = isAuthError(error) ? "CRITICAL AUTH" : "CRITICAL PUBLISH FAILED";
        const text = [
          summary,
          `post_id: ${postId}`,
          seedUrl ? `seed_url: ${seedUrl}` : undefined,
          `error: ${errorMessage.slice(0, 500)}`,
          isAuthError(error)
            ? "next: refresh THREADS_ACCESS_TOKEN / permissions; set AUTOPUBLISH_ENABLED=false until fixed"
            : "next: check Threads API / rate limits; retry later"
        ]
          .filter(Boolean)
          .join("\n");
        try {
          await params.telegram.sendMessage(text);
          criticalAlerts += 1;
        } catch (tgErr) {
          await params.logger.log({
            level: "ERROR",
            subsystem: "PUBLISH",
            message: `Failed to send Telegram alert for post ${postId}`,
            postRecordId: postId,
            error: tgErr
          });
        }
      }
    }
  }

  return { attempted, published, failed: failedCount, criticalAlerts };
};
