import { DateTime } from "luxon";
import { AirtableClient } from "../airtable/airtableClient.js";
import { PostFields } from "../airtable/fields.js";
import { Logger } from "../logger.js";
import { ThreadsClient } from "../services/threads.js";
import { TelegramClient } from "../services/telegram.js";
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

export const publishJob = async (params: {
  airtable: AirtableClient;
  postsTableName: string;
  logger: Logger;
  threads: ThreadsClient;
  telegram?: TelegramClient;
  timezone: string;
  maxCharsPerPart: number;
  autopublishEnabled: boolean;
  postMediaEnabled: boolean;
}) => {
  if (!params.autopublishEnabled) return;

  const now = DateTime.now().setZone(params.timezone);

  const scheduled = await params.airtable.listAll<Post>(params.postsTableName, {
    filterByFormula: `AND({${PostFields.PostStatus}}="Scheduled", {${PostFields.ScheduledAt}}!="")`,
    maxRecords: 20,
    fields: [
      PostFields.ScheduledAt,
      PostFields.AttemptCount,
      PostFields.ThreadPartsJson,
      PostFields.SeedUrl,
      PostFields.MediaUrl,
      PostFields.MediaType,
      PostFields.MediaAltText
    ]
  });
  const due = scheduled
    .map((p) => ({
      post: p,
      scheduledAt: DateTime.fromISO(String(p.fields?.[PostFields.ScheduledAt] ?? "")).setZone(params.timezone)
    }))
    .filter((x) => x.scheduledAt.isValid && x.scheduledAt <= now)
    .sort((a, b) => a.scheduledAt.toMillis() - b.scheduledAt.toMillis())
    .slice(0, 3)
    .map((x) => x.post);

  for (const post of due) {
    const postId = post.id;
    const attemptCount = Number(post.fields?.[PostFields.AttemptCount] ?? 0);
    const partsJson = String(post.fields?.[PostFields.ThreadPartsJson] ?? "");
    const parts = safeJsonParse<string[]>(partsJson) ?? [];
    const mediaUrl = String(post.fields?.[PostFields.MediaUrl] ?? "").trim();
    const mediaType = String(post.fields?.[PostFields.MediaType] ?? "").trim();
    const mediaAltText = String(post.fields?.[PostFields.MediaAltText] ?? "").trim();

    const rootMedia =
      params.postMediaEnabled && mediaUrl && isHttpUrl(mediaUrl) && (mediaType === "IMAGE" || mediaType === "VIDEO")
        ? ({ type: mediaType, url: mediaUrl, altText: mediaAltText || undefined } as any)
        : undefined;

    try {
      await params.airtable.updateRecord(params.postsTableName, postId, {
        [PostFields.PostStatus]: "Publishing",
        [PostFields.LastAttemptAt]: now.toISO(),
        [PostFields.AttemptCount]: attemptCount + 1,
        [PostFields.Error]: ""
      } as any);

      let result;
      try {
        result = await params.threads.publishThread(parts, params.maxCharsPerPart, rootMedia, {
          log: async (ev) => {
            await params.logger.log({
              level: ev.level,
              subsystem: "PUBLISH",
              message: `${ev.stage}: ${ev.message}`,
              postRecordId: postId,
              meta: ev.meta
            });
          }
        });
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
          result = await params.threads.publishThread(parts, params.maxCharsPerPart, undefined, {
            log: async (ev) => {
              await params.logger.log({
                level: ev.level,
                subsystem: "PUBLISH",
                message: `${ev.stage}: ${ev.message}`,
                postRecordId: postId,
                meta: ev.meta
              });
            }
          });
        } else {
          throw err;
        }
      }

      await params.airtable.updateRecord(params.postsTableName, postId, {
        [PostFields.PostStatus]: "Published",
        [PostFields.PublishedAt]: now.toISO(),
        [PostFields.ThreadsRootId]: result.rootId,
        [PostFields.ThreadsRootUrl]: result.rootPermalink ?? "",
        [PostFields.FailureSubsystem]: null
      } as any);
    } catch (error) {
      const nextAttempt = attemptCount + 1;
      const errorMessage = error instanceof Error ? error.message : String(error);

      const failed = nextAttempt >= 3;
      await params.airtable.updateRecord(params.postsTableName, postId, {
        [PostFields.PostStatus]: failed ? "Failed" : "Scheduled",
        [PostFields.Error]: errorMessage,
        [PostFields.LastAttemptAt]: now.toISO(),
        [PostFields.AttemptCount]: nextAttempt,
        ...(failed || isAuthError(error) ? { [PostFields.FailureSubsystem]: "PUBLISH" } : {})
      } as any);

      const critical = failed || isAuthError(error);
      await params.logger.log({
        level: critical ? "CRITICAL" : "ERROR",
        subsystem: "PUBLISH",
        message: `Publish failed for post ${postId} (attempt ${nextAttempt}/3)`,
        postRecordId: postId,
        error
      });

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
};
