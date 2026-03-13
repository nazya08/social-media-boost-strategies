import { DateTime } from "luxon";
import { loadConfig } from "./config.js";
import { AirtableClient } from "./airtable/airtableClient.js";
import { Logger } from "./logger.js";
import { AnthropicClient } from "./services/anthropic.js";
import { TelegramClient } from "./services/telegram.js";
import { ThreadsClient } from "./services/threads.js";
import { ingestJob } from "./jobs/ingest.js";
import { generateJob } from "./jobs/generate.js";
import { publishNowJob } from "./jobs/publishNow.js";
import { healthJob } from "./jobs/health.js";

export type RunOnceSummary = {
  skipped?: { reason: string };
  ingest?: { newSeeds: number; dedupedSeeds: number; processedDonors: number; donorsCount: number; errorsCount: number };
  generate?: { processed: number; generated: number; failed: number };
  publish?: { attempted: number; published: number; failed: number; criticalAlerts: number };
  finishedAtIso: string;
};

const isWithinWindow = (timezone: string, startHour: number, endHour: number) => {
  const now = DateTime.now().setZone(timezone);
  if (endHour === 24) return now.hour >= startHour;
  return now.hour >= startHour && now.hour < endHour;
};

export const runOnce = async (): Promise<RunOnceSummary> => {
  const config = loadConfig();

  const airtable = new AirtableClient({ apiKey: config.airtable.apiKey, baseId: config.airtable.baseId });
  const logger = new Logger({
    airtable,
    runLogsTableName: config.airtable.runLogsTableName,
    timezone: config.runtime.timezone
  });

  const anthropic = new AnthropicClient({ apiKey: config.anthropic.apiKey, model: config.anthropic.model });
  const threads = new ThreadsClient({
    accessToken: config.threads.accessToken,
    userId: config.threads.userId,
    deviceId: config.threads.deviceId,
    apiBaseUrl: config.threads.apiBaseUrl,
    replyRetryCount: config.threads.replyRetryCount,
    replyRetryDelayMs: config.threads.replyRetryDelayMs,
    interPartDelayMs: config.threads.interPartDelayMs
  });

  const telegram =
    config.telegram.alertsEnabled && config.telegram.botToken
      ? new TelegramClient({
          botToken: config.telegram.botToken,
          chatId: config.telegram.chatId,
          messageThreadId: config.telegram.messageThreadId
        })
      : undefined;

  await logger.log({ level: "INFO", subsystem: "HEALTH", message: "Once run started" });

  if (config.runtime.scheduleMode === "interval" && !isWithinWindow(config.runtime.timezone, config.runtime.windowStartHour, config.runtime.windowEndHour)) {
    const msg = `Once: outside window ${config.runtime.windowStartHour}:00-${config.runtime.windowEndHour}:00 (${config.runtime.timezone}); skipping`;
    await logger.log({ level: "INFO", subsystem: "SCHEDULE", message: msg });
    return { skipped: { reason: msg }, finishedAtIso: DateTime.now().toISO() ?? new Date().toISOString() };
  }

  const ingestResult = await ingestJob({
    airtable,
    donorsTableName: config.airtable.donorsTableName,
    postsTableName: config.airtable.postsTableName,
    logger,
    timezone: config.runtime.timezone,
    maxItemsPerDonor: config.runtime.ingestMaxItemsPerDonor,
    ctaUrl: config.runtime.ctaUrl,
    ctaTextEn: config.runtime.ctaTextEn,
    ctaTextUa: config.runtime.ctaTextUa
  });

  const recordIds = ingestResult.createdPostRecordIds;
  if (recordIds.length > 0) {
    await generateJob({
      airtable,
      postsTableName: config.airtable.postsTableName,
      logger,
      anthropic,
      maxCharsPerPart: config.runtime.threadPartMaxChars,
      partsTargetMin: config.runtime.partsTargetMin,
      partsTargetMax: config.runtime.partsTargetMax,
      maxRecords: config.runtime.generateMaxRecords,
      recordIds,
      ctaUrlOverride: config.runtime.ctaUrl,
      ctaTextEnOverride: config.runtime.ctaTextEn,
      ctaTextUaOverride: config.runtime.ctaTextUa
    });
  } else {
    await logger.log({ level: "INFO", subsystem: "GENERATE", message: "Once: no new seeds to generate" });
  }

  const publishResult = await publishNowJob({
    airtable,
    postsTableName: config.airtable.postsTableName,
    logger,
    threads,
    telegram,
    timezone: config.runtime.timezone,
    maxCharsPerPart: config.runtime.threadPartMaxChars,
    autopublishEnabled: config.runtime.autopublishEnabled,
    postMediaEnabled: config.runtime.postMediaEnabled,
    maxToPublish: config.runtime.publishMaxPerRun,
    ctaUrlOverride: config.runtime.ctaUrl
  });

  await healthJob({
    airtable,
    postsTableName: config.airtable.postsTableName,
    logger,
    telegram,
    timezone: config.runtime.timezone
  });

  await logger.log({ level: "INFO", subsystem: "HEALTH", message: "Once run finished" });

  return {
    ingest: {
      newSeeds: ingestResult.newSeeds,
      dedupedSeeds: ingestResult.dedupedSeeds,
      processedDonors: ingestResult.processedDonors,
      donorsCount: ingestResult.donorsCount,
      errorsCount: ingestResult.errorsCount
    },
    publish: publishResult,
    finishedAtIso: DateTime.now().toISO() ?? new Date().toISOString()
  };
};
