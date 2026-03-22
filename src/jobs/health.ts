import { DateTime } from "luxon";
import { Logger } from "../logger.js";
import { DataStore } from "../store/store.js";
import { TelegramClient } from "../services/telegram.js";

export const healthJob = async (params: {
  store: DataStore;
  logger: Logger;
  telegram?: TelegramClient;
  timezone: string;
  accountKey?: string;
  treatBlankAccountKeyAsMatch?: boolean;
}) => {
  const now = DateTime.now().setZone(params.timezone);

  const scheduled = await params.store.listScheduledPosts({
    accountKey: params.accountKey,
    treatBlankAccountKeyAsMatch: params.treatBlankAccountKeyAsMatch,
    maxRecords: 50
  });
  const overdue = scheduled.filter((p) => {
    const dt = DateTime.fromISO(String(p.scheduledAt ?? "")).setZone(params.timezone);
    return dt.isValid && dt < now.minus({ hours: 2 });
  });

  const queueNonEmpty = await params.store.hasQueuePosts({
    accountKey: params.accountKey,
    treatBlankAccountKeyAsMatch: params.treatBlankAccountKeyAsMatch
  });

  const lastPublishedAtIso = await params.store.getLastPublishedAt({
    accountKey: params.accountKey,
    treatBlankAccountKeyAsMatch: params.treatBlankAccountKeyAsMatch
  });
  const lastPublishedAt = lastPublishedAtIso ? DateTime.fromISO(lastPublishedAtIso).setZone(params.timezone) : undefined;

  const stalePublishing = queueNonEmpty && (!lastPublishedAt || now.diff(lastPublishedAt, "hours").hours > 24);

  if (overdue.length === 0 && !stalePublishing) return;

  const messageLines = ["CRITICAL HEALTH", params.accountKey ? `account_key: ${params.accountKey}` : undefined].filter(Boolean) as string[];
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
