import { DateTime } from "luxon";
import { AirtableClient } from "./airtable/airtableClient.js";
import { RunLogFields } from "./airtable/fields.js";

export type LogLevel = "INFO" | "WARN" | "ERROR" | "CRITICAL";
export type Subsystem = "INGEST" | "GENERATE" | "SCHEDULE" | "PUBLISH" | "HEALTH";

export type LoggerOptions = {
  airtable: AirtableClient;
  runLogsTableName: string;
  timezone: string;
  airtableMinLevel?: LogLevel;
};

export class Logger {
  constructor(private readonly options: LoggerOptions) {}

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

    // Best-effort Airtable run log (never throws)
    const minLevel = this.options.airtableMinLevel ?? "WARN";
    const levelOrder: Record<LogLevel, number> = { INFO: 10, WARN: 20, ERROR: 30, CRITICAL: 40 };
    if (levelOrder[params.level] < levelOrder[minLevel]) return;

    try {
      await this.options.airtable.createRecord(this.options.runLogsTableName, {
        [RunLogFields.Timestamp]: timestamp,
        [RunLogFields.Level]: params.level,
        [RunLogFields.Subsystem]: params.subsystem,
        ...(params.postRecordId ? { [RunLogFields.Post]: [params.postRecordId] } : {}),
        [RunLogFields.Message]: params.message,
        ...(errorStack ? { [RunLogFields.ErrorStack]: errorStack } : {}),
        ...(params.meta !== undefined ? { [RunLogFields.MetaJson]: JSON.stringify(params.meta, null, 2) } : {})
      } as Record<string, unknown>);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[LOGGER] Failed to write Run Logs to Airtable:", err);
    }
  }
}

