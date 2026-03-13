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
import { DateTime } from "luxon";

const createExclusiveRunner = <T>(fn: () => Promise<T>) => {
  let running = false;
  return async (): Promise<T | undefined> => {
    if (running) return undefined;
    running = true;
    try {
      return await fn();
    } finally {
      running = false;
    }
  };
};

const main = async () => {
  const config = loadConfig();

  const airtable = new AirtableClient({
    apiKey: config.airtable.apiKey,
    baseId: config.airtable.baseId
  });

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

  const runIngest = createExclusiveRunner(async () => {
    return await ingestJob({
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
  });

  const runGenerate = createExclusiveRunner(async () => {
    await generateJob({
      airtable,
      postsTableName: config.airtable.postsTableName,
      logger,
      anthropic,
      maxCharsPerPart: config.runtime.threadPartMaxChars,
      partsTargetMin: config.runtime.partsTargetMin,
      partsTargetMax: config.runtime.partsTargetMax,
      maxRecords: config.runtime.generateMaxRecords
    });
  });

  const runHealth = createExclusiveRunner(async () => {
    await healthJob({
      airtable,
      postsTableName: config.airtable.postsTableName,
      logger,
      telegram,
      timezone: config.runtime.timezone
    });
  });

  await logger.log({ level: "INFO", subsystem: "HEALTH", message: "Service started" });

  const isWithinWindow = () => {
    const now = DateTime.now().setZone(config.runtime.timezone);
    const start = config.runtime.windowStartHour;
    const end = config.runtime.windowEndHour;
    // Window is [start, end) in local timezone. Example: 9..21 means 09:00-20:59.
    if (end === 24) return now.hour >= start;
    return now.hour >= start && now.hour < end;
  };

  const runCronCycle = createExclusiveRunner(async () => {
    if (config.runtime.scheduleMode === "interval" && !isWithinWindow()) {
      await logger.log({
        level: "INFO",
        subsystem: "SCHEDULE",
        message: `Cron: outside window ${config.runtime.windowStartHour}:00-${config.runtime.windowEndHour}:00 (${config.runtime.timezone}); skipping`
      });
      return;
    }

    const ingestResult = await runIngest();
    const recordIds = ingestResult?.createdPostRecordIds ?? [];
    if (recordIds.length === 0) {
      await logger.log({ level: "INFO", subsystem: "HEALTH", message: "Cron: no new seeds this cycle" });
    } else {
      await generateJob({
        airtable,
        postsTableName: config.airtable.postsTableName,
        logger,
        anthropic,
        maxCharsPerPart: config.runtime.threadPartMaxChars,
        partsTargetMin: config.runtime.partsTargetMin,
        partsTargetMax: config.runtime.partsTargetMax,
        maxRecords: config.runtime.generateMaxRecords,
        recordIds
      });
    }

    await publishNowJob({
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
  });

  // Kick off immediately
  await runCronCycle();
  await runHealth();

  setInterval(runCronCycle, config.runtime.intervalHours * 60 * 60 * 1000);
  setInterval(runHealth, 30 * 60 * 1000);
};

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal:", err);
  process.exitCode = 1;
});
