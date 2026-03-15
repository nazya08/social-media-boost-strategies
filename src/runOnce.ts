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
import { runLogsCleanupJob } from "./jobs/runLogsCleanup.js";
import { loadThreadsAccounts } from "./accounts.js";
import { getLastAccountCycleFinishedAt, writeAccountCycleMarker } from "./utils/accountCycle.js";

export type RunOnceSummary = {
  skipped?: { reason: string };
  ingest?: { newSeeds: number; dedupedSeeds: number; processedDonors: number; donorsCount: number; errorsCount: number };
  generate?: { processed: number; generated: number; failed: number };
  publish?: { attempted: number; published: number; failed: number; criticalAlerts: number };
  accounts?: Record<string, unknown>;
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

  // Prevent Airtable Free plan Run Logs from hitting the 1000-record cap.
  try {
    await runLogsCleanupJob({
      airtable,
      runLogsTableName: config.airtable.runLogsTableName,
      thresholdRecords: config.runtime.runLogsCleanupThresholdRecords,
      trimToRecords: config.runtime.runLogsCleanupTrimToRecords
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[RUN_LOGS] Cleanup failed:", err);
  }

  const logger = new Logger({
    airtable,
    runLogsTableName: config.airtable.runLogsTableName,
    timezone: config.runtime.timezone,
    airtableEnabled: config.runtime.runLogsAirtableEnabled,
    airtableMinLevel: config.logging.runLogsMinLevel
  });

  const anthropic = new AnthropicClient({ apiKey: config.anthropic.apiKey, model: config.anthropic.model });

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

  const accounts = loadThreadsAccounts(config);
  const perAccount: Record<string, any> = {};

  // Aggregate summary (kept for backward compatibility)
  let totalNewSeeds = 0;
  let totalDedupedSeeds = 0;
  let totalProcessedDonors = 0;
  let totalDonorsCount = 0;
  let totalErrorsCount = 0;
  let totalAttempted = 0;
  let totalPublished = 0;
  let totalFailed = 0;
  let totalCriticalAlerts = 0;

  for (const account of accounts) {
    const now = DateTime.now().setZone(config.runtime.timezone);
    const key = account.key;
    const intervalHours = Math.max(1, account.intervalHours);

    if (config.runtime.runLogsAirtableEnabled) {
      try {
        const lastFinished = await getLastAccountCycleFinishedAt({
          airtable,
          runLogsTableName: config.airtable.runLogsTableName,
          timezone: config.runtime.timezone,
          accountKey: key
        });
        if (lastFinished) {
          const hoursSince = now.diff(lastFinished, "hours").hours;
          // Small slack to avoid accidental skips due to cron drift.
          const slackHours = 0.05; // ~3 minutes
          if (hoursSince < intervalHours - slackHours) {
            const reason = `Account ${key}: last run ${Math.floor(hoursSince * 60)}m ago; interval=${intervalHours}h; skipping`;
            await logger.log({ level: "INFO", subsystem: "SCHEDULE", message: reason });
            perAccount[key] = { skipped: { reason } };
            continue;
          }
        }
      } catch (err) {
        await logger.log({
          level: "WARN",
          subsystem: "SCHEDULE",
          message: `Account ${key}: failed to read last cycle marker; running anyway`,
          error: err
        });
      }

      try {
        await writeAccountCycleMarker({
          airtable,
          runLogsTableName: config.airtable.runLogsTableName,
          timezone: config.runtime.timezone,
          accountKey: key,
          event: "ACCOUNT_CYCLE_START",
          meta: { intervalHours }
        });
      } catch (err) {
        await logger.log({ level: "WARN", subsystem: "SCHEDULE", message: `Account ${key}: failed to write cycle START marker`, error: err });
      }
    }

    const threads = new ThreadsClient(account.threads);

    const ingestResult = await ingestJob({
      airtable,
      donorsTableName: config.airtable.donorsTableName,
      postsTableName: config.airtable.postsTableName,
      logger,
      timezone: config.runtime.timezone,
      maxItemsPerDonor: config.runtime.ingestMaxItemsPerDonor,
      ctaUrl: config.runtime.ctaUrl,
      ctaTextEn: config.runtime.ctaTextEn,
      ctaTextUa: config.runtime.ctaTextUa,
      accountKey: key,
      treatBlankAccountKeyAsMatch: account.isDefault
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
      await logger.log({ level: "INFO", subsystem: "GENERATE", message: `Account ${key}: no new seeds to generate` });
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
      ctaUrlOverride: config.runtime.ctaUrl,
      promptThreadInterPartDelayMs: config.runtime.promptThreadInterPartDelayMs,
      promptThreadReplyRetryDelayMs: config.runtime.promptThreadReplyRetryDelayMs,
      accountKey: key,
      treatBlankAccountKeyAsMatch: account.isDefault
    });

    await healthJob({
      airtable,
      postsTableName: config.airtable.postsTableName,
      logger,
      telegram,
      timezone: config.runtime.timezone,
      accountKey: key,
      treatBlankAccountKeyAsMatch: account.isDefault
    });

    if (config.runtime.runLogsAirtableEnabled) {
      try {
        await writeAccountCycleMarker({
          airtable,
          runLogsTableName: config.airtable.runLogsTableName,
          timezone: config.runtime.timezone,
          accountKey: key,
          event: "ACCOUNT_CYCLE_FINISH",
          meta: { intervalHours, ingest: { newSeeds: ingestResult.newSeeds, dedupedSeeds: ingestResult.dedupedSeeds }, publish: publishResult }
        });
      } catch (err) {
        await logger.log({ level: "WARN", subsystem: "SCHEDULE", message: `Account ${key}: failed to write cycle FINISH marker`, error: err });
      }
    }

    perAccount[key] = {
      ingest: {
        newSeeds: ingestResult.newSeeds,
        dedupedSeeds: ingestResult.dedupedSeeds,
        processedDonors: ingestResult.processedDonors,
        donorsCount: ingestResult.donorsCount,
        errorsCount: ingestResult.errorsCount
      },
      publish: publishResult
    };

    totalNewSeeds += ingestResult.newSeeds;
    totalDedupedSeeds += ingestResult.dedupedSeeds;
    totalProcessedDonors += ingestResult.processedDonors;
    totalDonorsCount += ingestResult.donorsCount;
    totalErrorsCount += ingestResult.errorsCount;
    totalAttempted += publishResult.attempted;
    totalPublished += publishResult.published;
    totalFailed += publishResult.failed;
    totalCriticalAlerts += publishResult.criticalAlerts;
  }

  await logger.log({ level: "INFO", subsystem: "HEALTH", message: "Once run finished" });

  return {
    ingest: {
      newSeeds: totalNewSeeds,
      dedupedSeeds: totalDedupedSeeds,
      processedDonors: totalProcessedDonors,
      donorsCount: totalDonorsCount,
      errorsCount: totalErrorsCount
    },
    publish: { attempted: totalAttempted, published: totalPublished, failed: totalFailed, criticalAlerts: totalCriticalAlerts },
    accounts: perAccount,
    finishedAtIso: DateTime.now().toISO() ?? new Date().toISOString()
  };
};
