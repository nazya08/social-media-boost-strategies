import { DateTime } from "luxon";
import { AirtableClient } from "../airtable/airtableClient.js";
import { PostFields } from "../airtable/fields.js";
import { Logger } from "../logger.js";
import { TelegramClient } from "../services/telegram.js";

type Post = Record<string, unknown>;

export const healthJob = async (params: {
  airtable: AirtableClient;
  postsTableName: string;
  logger: Logger;
  telegram?: TelegramClient;
  timezone: string;
}) => {
  const now = DateTime.now().setZone(params.timezone);

  const scheduled = await params.airtable.listAll<Post>(params.postsTableName, {
    filterByFormula: `AND({${PostFields.PostStatus}}="Scheduled", {${PostFields.ScheduledAt}}!="")`,
    maxRecords: 50,
    fields: [PostFields.ScheduledAt, PostFields.SeedUrl]
  });
  const overdue = scheduled.filter((p) => {
    const dt = DateTime.fromISO(String(p.fields?.[PostFields.ScheduledAt] ?? "")).setZone(params.timezone);
    return dt.isValid && dt < now.minus({ hours: 2 });
  });

  const queueNonEmpty = await params.airtable.listAll<Post>(params.postsTableName, {
    filterByFormula: `OR({${PostFields.PostStatus}}="Generated", {${PostFields.PostStatus}}="Scheduled")`,
    maxRecords: 1,
    fields: [PostFields.PostStatus]
  });

  const lastPublished = await params.airtable.listAll<Post>(params.postsTableName, {
    filterByFormula: `{${PostFields.PostStatus}}="Published"`,
    sortField: PostFields.PublishedAt,
    sortDirection: "desc",
    maxRecords: 1,
    fields: [PostFields.PublishedAt]
  });

  const lastPublishedAtIso = String(lastPublished[0]?.fields?.[PostFields.PublishedAt] ?? "");
  const lastPublishedAt = lastPublishedAtIso ? DateTime.fromISO(lastPublishedAtIso).setZone(params.timezone) : undefined;

  const stalePublishing = queueNonEmpty.length > 0 && (!lastPublishedAt || now.diff(lastPublishedAt, "hours").hours > 24);

  if (overdue.length === 0 && !stalePublishing) return;

  const messageLines = ["CRITICAL HEALTH"];
  if (overdue.length > 0) messageLines.push(`overdue_scheduled_count: ${overdue.length}`);
  if (stalePublishing)
    messageLines.push(`no_published_for_hours: ${lastPublishedAt ? Math.floor(now.diff(lastPublishedAt, "hours").hours) : "unknown"}`);
  messageLines.push("next: check queue, tokens, and Threads API; consider AUTOPUBLISH_ENABLED=false while investigating");

  const text = messageLines.join("\n");
  await params.logger.log({
    level: "CRITICAL",
    subsystem: "HEALTH",
    message: text,
    meta: { overdueCount: overdue.length, stalePublishing }
  });

  if (params.telegram) {
    try {
      await params.telegram.sendMessage(text);
    } catch (tgErr) {
      await params.logger.log({
        level: "ERROR",
        subsystem: "HEALTH",
        message: "Failed to send Telegram health alert",
        error: tgErr
      });
    }
  }
};
