import { DateTime } from "luxon";
import { RunLog } from "./store/store.js";

export type LogLevel = "INFO" | "WARN" | "ERROR" | "CRITICAL";
export type Subsystem = "INGEST" | "GENERATE" | "SCHEDULE" | "PUBLISH" | "HEALTH";

export type LoggerOptions = {
  timezone: string;
  runLogsEnabled?: boolean;
  runLogsMinLevel?: LogLevel;
  runLogWriter?: (log: RunLog) => Promise<void>;
};

export class Logger {
  constructor(private readonly options: LoggerOptions) {}

  private levelPriority(level: LogLevel) {
    switch (level) {
      case "INFO":
        return 10;
      case "WARN":
        return 20;
      case "ERROR":
        return 30;
      case "CRITICAL":
        return 40;
    }
  }

  async log(params: {
    level: LogLevel;
    subsystem: Subsystem;
    message: string;
    postRecordId?: string;
    error?: unknown;
    meta?: unknown;
  }) {
    const timestamp = DateTime.now().setZone(this.options.timezone).toISO();
    const errorStack =
      params.error instanceof Error ? `${params.error.name}: ${params.error.message}\n${params.error.stack ?? ""}` : undefined;

    // Always log to stdout/stderr for visibility
    const line = `[${params.level}] [${params.subsystem}] ${params.message}`;
    if (params.level === "ERROR" || params.level === "CRITICAL") {
      // eslint-disable-next-line no-console
      console.error(line, params.error ?? "");
    } else {
      // eslint-disable-next-line no-console
      console.log(line);
    }

    // Best-effort persisted run log (never throws)
    const runLogsEnabled = this.options.runLogsEnabled ?? false;
    if (!runLogsEnabled || !this.options.runLogWriter) return;

    const minLevel = this.options.runLogsMinLevel ?? "WARN";
    if (this.levelPriority(params.level) < this.levelPriority(minLevel)) return;

    try {
      await this.options.runLogWriter({
        timestampIso: timestamp ?? new Date().toISOString(),
        level: params.level,
        subsystem: params.subsystem,
        message: params.message,
        ...(params.postRecordId ? { postId: params.postRecordId } : {}),
        ...(errorStack ? { errorStack } : {}),
        ...(params.meta !== undefined ? { metaJson: JSON.stringify(params.meta, null, 2) } : {})
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[LOGGER] Failed to write Run Logs:", err);
    }
  }
}
