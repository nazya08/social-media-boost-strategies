import { DateTime } from "luxon";
import { loadConfig } from "./config.js";
import { Logger } from "./logger.js";
import { AnthropicClient } from "./services/anthropic.js";
import { TelegramClient } from "./services/telegram.js";
import { ThreadsClient } from "./services/threads.js";
import { ingestJob } from "./jobs/ingest.js";
import { generateJob } from "./jobs/generate.js";
import { publishNowJob } from "./jobs/publishNow.js";
import { healthJob } from "./jobs/health.js";
import { loadThreadsAccounts } from "./accounts.js";
import { AirtableClient } from "./airtable/airtableClient.js";
import { AirtableStore } from "./store/airtableStore.js";
import { SupabaseStore } from "./store/supabaseStore.js";
import { DataStore } from "./store/store.js";
import { DEFAULT_CTA_TEXT_UA } from "./cta.js";

export type RunOnceSummary = {
  skipped?: { reason: string };
  ingest?: {
    newSeeds: number;
    dedupedSeeds: number;
    skippedMediaSeeds: number;
    processedDonors: number;
    donorsCount: number;
    errorsCount: number;
  };
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

  let store: DataStore;
  if (config.dataStore.kind === "airtable") {
    const airtable = new AirtableClient({ apiKey: config.airtable!.apiKey, baseId: config.airtable!.baseId });
    store = new AirtableStore(airtable, {
      posts: config.airtable!.postsTableName,
      donors: config.airtable!.donorsTableName,
      runLogs: config.airtable!.runLogsTableName
    });
  } else {
    store = new SupabaseStore(config);
  }

  // Best-effort cleanup for persisted run logs (if supported by the store).
  if (config.runtime.runLogsAirtableEnabled && store.cleanupRunLogs) {
    try {
      await store.cleanupRunLogs({
        thresholdRecords: config.runtime.runLogsCleanupThresholdRecords,
        trimToRecords: config.runtime.runLogsCleanupTrimToRecords
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[RUN_LOGS] Cleanup failed:", err);
    }
  }

  const logger = new Logger({
    timezone: config.runtime.timezone,
    runLogsEnabled: config.runtime.runLogsAirtableEnabled,
    runLogsMinLevel: config.logging.runLogsMinLevel,
    runLogWriter: store.createRunLog ? (log) => store.createRunLog!(log) : undefined
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
  let totalSkippedMediaSeeds = 0;
  let totalProcessedDonors = 0;
  let totalDonorsCount = 0;
  let totalErrorsCount = 0;
  let totalAttempted = 0;
  let totalPublished = 0;
  let totalFailed = 0;
  let totalCriticalAlerts = 0;

  for (const account of accounts) {
    const key = account.key;

    try {
      const accountCtaUrl = String(process.env[`CTA_URL_${key}`] ?? "").trim() || config.runtime.ctaUrl;
      const accountCtaTextEn = String(process.env[`CTA_TEXT_EN_${key}`] ?? "").trim() || config.runtime.ctaTextEn;
      const accountCtaTextUa =
        String(process.env[`CTA_TEXT_UA_${key}`] ?? "").trim() || String(process.env.CTA_TEXT_UA ?? "").trim() || DEFAULT_CTA_TEXT_UA;

      const ingestLanguageConfiguredRaw =
        String(process.env[`INGEST_LANGUAGE_${key}`] ?? "").trim() || String(process.env.INGEST_LANGUAGE ?? "").trim();
      const ingestLanguageOverrideRaw = ingestLanguageConfiguredRaw || (account.isDefault ? "EN" : "UA");
      const ingestLanguageOverride =
        ingestLanguageOverrideRaw.toUpperCase() === "EN" ? ("EN" as const) : ingestLanguageOverrideRaw.toUpperCase() === "UA" ? ("UA" as const) : undefined;
      const accountSkipMedia =
        String(process.env[`INGEST_SKIP_MEDIA_${key}`] ?? "").trim() !== ""
          ? ["1", "true", "yes", "y", "on"].includes(String(process.env[`INGEST_SKIP_MEDIA_${key}`] ?? "").trim().toLowerCase())
          : ["1", "true", "yes", "y", "on"].includes(String(process.env.INGEST_SKIP_MEDIA ?? "").trim().toLowerCase());

      const threads = new ThreadsClient(account.threads);

      const ingestResult = await ingestJob({
        store,
        logger,
        timezone: config.runtime.timezone,
        maxItemsPerDonor: config.runtime.ingestMaxItemsPerDonor,
        ctaUrl: accountCtaUrl,
        ctaTextEn: accountCtaTextEn,
        ctaTextUa: accountCtaTextUa,
        skipMediaDefault: accountSkipMedia,
        autoDisableOn402: config.runtime.ingestAutoDisableOn402,
        accountKey: key,
        treatBlankAccountKeyAsMatch: account.isDefault,
        languageOverride: ingestLanguageOverride
      });

      const recordIds = ingestResult.createdPostRecordIds;
      // Generate newly ingested posts first, then use remaining capacity for backlog (Seeded/Failed without parts).
      if (recordIds.length > 0) {
        await generateJob({
          store,
          logger,
          anthropic,
          maxCharsPerPart: config.runtime.threadPartMaxChars,
          partsTargetMin: config.runtime.partsTargetMin,
          partsTargetMax: config.runtime.partsTargetMax,
          maxRecords: Math.max(1, Math.min(recordIds.length, config.runtime.generateMaxRecords)),
          recordIds,
          ctaUrlOverride: accountCtaUrl,
          ctaTextEnOverride: accountCtaTextEn,
          ctaTextUaOverride: accountCtaTextUa,
          accountKey: key,
          treatBlankAccountKeyAsMatch: account.isDefault
        });
      }

      const remainingGenerate = Math.max(0, config.runtime.generateMaxRecords - recordIds.length);
      if (remainingGenerate > 0) {
        await generateJob({
          store,
          logger,
          anthropic,
          maxCharsPerPart: config.runtime.threadPartMaxChars,
          partsTargetMin: config.runtime.partsTargetMin,
          partsTargetMax: config.runtime.partsTargetMax,
          maxRecords: remainingGenerate,
          ctaUrlOverride: accountCtaUrl,
          ctaTextEnOverride: accountCtaTextEn,
          ctaTextUaOverride: accountCtaTextUa,
          accountKey: key,
          treatBlankAccountKeyAsMatch: account.isDefault
        });
      }

      const publishResult = await publishNowJob({
        store,
        logger,
        threads,
        telegram,
        timezone: config.runtime.timezone,
        maxCharsPerPart: config.runtime.threadPartMaxChars,
        autopublishEnabled: config.runtime.autopublishEnabled,
        postMediaEnabled: config.runtime.postMediaEnabled,
        maxToPublish: config.runtime.publishMaxPerRun,
        ctaUrlOverride: accountCtaUrl,
        promptThreadInterPartDelayMs: config.runtime.promptThreadInterPartDelayMs,
        promptThreadReplyRetryDelayMs: config.runtime.promptThreadReplyRetryDelayMs,
        accountKey: key,
        treatBlankAccountKeyAsMatch: account.isDefault
      });

      await healthJob({
        store,
        logger,
        telegram,
        timezone: config.runtime.timezone,
        accountKey: key,
        treatBlankAccountKeyAsMatch: account.isDefault
      });

      perAccount[key] = {
        ingest: {
          newSeeds: ingestResult.newSeeds,
          dedupedSeeds: ingestResult.dedupedSeeds,
          skippedMediaSeeds: ingestResult.skippedMediaSeeds,
          processedDonors: ingestResult.processedDonors,
          donorsCount: ingestResult.donorsCount,
          errorsCount: ingestResult.errorsCount
        },
        publish: publishResult
      };

      totalNewSeeds += ingestResult.newSeeds;
      totalDedupedSeeds += ingestResult.dedupedSeeds;
      totalSkippedMediaSeeds += ingestResult.skippedMediaSeeds;
      totalProcessedDonors += ingestResult.processedDonors;
      totalDonorsCount += ingestResult.donorsCount;
      totalErrorsCount += ingestResult.errorsCount;
      totalAttempted += publishResult.attempted;
      totalPublished += publishResult.published;
      totalFailed += publishResult.failed;
      totalCriticalAlerts += publishResult.criticalAlerts;
    } catch (error) {
      perAccount[key] = { error: error instanceof Error ? error.message : String(error) };
      await logger.log({
        level: "ERROR",
        subsystem: "HEALTH",
        message: `Account run failed (${key})`,
        error
      });
      // Keep other accounts running even if one fails.
      continue;
    }
  }

  await logger.log({ level: "INFO", subsystem: "HEALTH", message: "Once run finished" });

  return {
    ingest: {
      newSeeds: totalNewSeeds,
      dedupedSeeds: totalDedupedSeeds,
      skippedMediaSeeds: totalSkippedMediaSeeds,
      processedDonors: totalProcessedDonors,
      donorsCount: totalDonorsCount,
      errorsCount: totalErrorsCount
    },
    publish: { attempted: totalAttempted, published: totalPublished, failed: totalFailed, criticalAlerts: totalCriticalAlerts },
    accounts: perAccount,
    finishedAtIso: DateTime.now().toISO() ?? new Date().toISOString()
  };
};
