import "dotenv/config";
import { z } from "zod";

const boolFromEnv = (value: string | undefined, defaultValue: boolean) => {
  if (value === undefined || value.trim() === "") return defaultValue;
  return ["1", "true", "yes", "y", "on"].includes(value.trim().toLowerCase());
};

const intFromEnv = (value: string | undefined, defaultValue: number) => {
  if (!value) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
};

export const ConfigSchema = z.object({
  airtable: z.object({
    apiKey: z.string().min(1),
    baseId: z.string().min(1),
    postsTableName: z.string().min(1).default("Posts"),
    donorsTableName: z.string().min(1).default("Threads Donors"),
    runLogsTableName: z.string().min(1).default("Run Logs")
  }),
  logging: z.object({
    runLogsMinLevel: z.enum(["INFO", "WARN", "ERROR", "CRITICAL"]).default("WARN")
  }),
  threads: z.object({
    accessToken: z.string().min(1),
    userId: z.string().min(1),
    deviceId: z.string().min(1).default("android-3jex3zty23s00000"),
    apiBaseUrl: z.string().url().default("https://graph.threads.net"),
    replyRetryCount: z.number().int().min(1).max(10).default(3),
    replyRetryDelayMs: z.number().int().min(0).max(300000).default(30000),
    interPartDelayMs: z.number().int().min(0).max(300000).default(30000)
  }),
  anthropic: z.object({
    apiKey: z.string().min(1),
    model: z.string().min(1).default("claude-sonnet-4-6")
  }),
  telegram: z.object({
    botToken: z.string().optional(),
    chatId: z.string().default("-1002984562783"),
    messageThreadId: z.string().default("206"),
    alertsEnabled: z.boolean().default(true)
  }),
  runtime: z.object({
    timezone: z.string().default("Europe/Kiev"),
    autopublishEnabled: z.boolean().default(true),
    postMediaEnabled: z.boolean().default(false),
    publishMaxPerRun: z.number().int().min(1).max(10).default(1),
    ctaUrl: z.string().url().default("https://t.me/solutions_247ai"),
    ctaTextEn: z.string().min(1).default("More about AI & automation here:"),
    ctaTextUa: z.string().min(1).default("Більше про AI та автоматизацію тут:"),
    dailyBatchEnabled: z.boolean().default(true),
    dailyBatchHour: z.number().int().min(0).max(23).default(9),
    dailyBatchMinute: z.number().int().min(0).max(59).default(0),
    ingestMaxItemsPerDonor: z.number().int().min(1).max(20).default(1),
    generateMaxRecords: z.number().int().min(1).max(50).default(20),
    partsTargetMin: z.number().int().min(2).max(15).default(8),
    partsTargetMax: z.number().int().min(2).max(15).default(10),
    scheduleMode: z.enum(["batch", "windows", "interval"]).default("interval"),
    batchSlotHours: z.array(z.number().int().min(0).max(23)).default([12, 15, 18, 21]),
    intervalHours: z.number().int().min(1).max(12).default(2),
    windowStartHour: z.number().int().min(0).max(23).default(9),
    windowEndHour: z.number().int().min(1).max(24).default(21),
    targetPostsPerDayMin: z.number().int().min(1).default(3),
    targetPostsPerDayMax: z.number().int().min(1).default(5),
    // Threads text limit is 500 characters (including spaces/links)
    threadPartMaxChars: z.number().int().min(100).max(500).default(450),
    // Prompt threads are long; use faster delays to avoid serverless timeouts.
    promptThreadInterPartDelayMs: z.number().int().min(0).max(300000).default(5000),
    promptThreadReplyRetryDelayMs: z.number().int().min(0).max(300000).default(20000)
  })
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export const loadConfig = (): AppConfig => {
  const parseHours = (value: string | undefined) => {
    if (!value) return [12, 15, 18, 21];
    const hours = value
      .split(",")
      .map((v) => Number.parseInt(v.trim(), 10))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 23);
    return hours.length > 0 ? Array.from(new Set(hours)).sort((a, b) => a - b) : [12, 15, 18, 21];
  };

  const raw = {
    airtable: {
      apiKey: process.env.AIRTABLE_API_KEY,
      baseId: process.env.AIRTABLE_BASE_ID,
      postsTableName: process.env.AIRTABLE_TABLE_NAME ?? "Posts",
      donorsTableName: process.env.AIRTABLE_DONORS_TABLE_NAME ?? "Threads Donors",
      runLogsTableName: process.env.AIRTABLE_RUN_LOGS_TABLE_NAME ?? "Run Logs"
    },
    logging: {
      runLogsMinLevel: (process.env.RUN_LOGS_MIN_LEVEL ?? "WARN").trim().toUpperCase()
    },
    threads: {
      accessToken: process.env.THREADS_ACCESS_TOKEN,
      userId: process.env.THREADS_USER_ID,
      deviceId: process.env.THREADS_DEVICE_ID ?? "android-3jex3zty23s00000",
      apiBaseUrl: process.env.THREADS_API_BASE_URL ?? "https://graph.threads.net",
      replyRetryCount: intFromEnv(process.env.THREADS_REPLY_RETRY_COUNT, 3),
      replyRetryDelayMs: intFromEnv(process.env.THREADS_REPLY_RETRY_DELAY_MS, 30000),
      interPartDelayMs: intFromEnv(process.env.THREADS_INTER_PART_DELAY_MS, 30000)
    },
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6"
    },
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      chatId: process.env.TELEGRAM_CHAT_ID ?? "-1002984562783",
      messageThreadId: process.env.TELEGRAM_MESSAGE_THREAD_ID ?? "206",
      alertsEnabled: boolFromEnv(process.env.TELEGRAM_ALERTS_ENABLED, true)
    },
    runtime: {
      timezone: process.env.TIMEZONE ?? "Europe/Kiev",
      autopublishEnabled: boolFromEnv(process.env.AUTOPUBLISH_ENABLED, true),
      postMediaEnabled: boolFromEnv(process.env.POST_MEDIA_ENABLED, false),
      publishMaxPerRun: intFromEnv(process.env.PUBLISH_MAX_PER_RUN, 1),
      ctaUrl: process.env.CTA_URL ?? "https://t.me/solutions_247ai",
      ctaTextEn: process.env.CTA_TEXT_EN ?? "More about AI & automation here:",
      ctaTextUa: process.env.CTA_TEXT_UA ?? "Більше про AI та автоматизацію тут:",
      dailyBatchEnabled: boolFromEnv(process.env.DAILY_BATCH_ENABLED, true),
      dailyBatchHour: intFromEnv(process.env.DAILY_BATCH_HOUR, 9),
      dailyBatchMinute: intFromEnv(process.env.DAILY_BATCH_MINUTE, 0),
      ingestMaxItemsPerDonor: intFromEnv(process.env.INGEST_MAX_ITEMS_PER_DONOR, 1),
      generateMaxRecords: intFromEnv(process.env.GENERATE_MAX_RECORDS, 20),
      partsTargetMin: intFromEnv(process.env.PARTS_TARGET_MIN, 8),
      partsTargetMax: intFromEnv(process.env.PARTS_TARGET_MAX, 10),
      scheduleMode: (process.env.SCHEDULE_MODE ?? "interval") as "batch" | "windows" | "interval",
      batchSlotHours: parseHours(process.env.BATCH_SLOT_HOURS),
      intervalHours: intFromEnv(process.env.INTERVAL_HOURS, 2),
      windowStartHour: intFromEnv(process.env.WINDOW_START_HOUR, 9),
      windowEndHour: intFromEnv(process.env.WINDOW_END_HOUR, 21),
      targetPostsPerDayMin: intFromEnv(process.env.TARGET_POSTS_PER_DAY_MIN, 3),
      targetPostsPerDayMax: intFromEnv(process.env.TARGET_POSTS_PER_DAY_MAX, 5),
      threadPartMaxChars: intFromEnv(process.env.THREAD_PART_MAX_CHARS, 450),
      promptThreadInterPartDelayMs: intFromEnv(process.env.PROMPT_THREAD_INTER_PART_DELAY_MS, 5000),
      promptThreadReplyRetryDelayMs: intFromEnv(process.env.PROMPT_THREAD_REPLY_RETRY_DELAY_MS, 20000)
    }
  };

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    // Keep error readable in logs
    const message = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${message}`);
  }
  return parsed.data;
};
