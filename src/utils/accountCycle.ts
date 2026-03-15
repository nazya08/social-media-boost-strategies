import { DateTime } from "luxon";
import { AirtableClient } from "../airtable/airtableClient.js";
import { RunLogFields } from "../airtable/fields.js";
import { escapeAirtableString } from "./airtableFormula.js";

type RunLog = Record<string, unknown>;

export type AccountCycleEvent = "ACCOUNT_CYCLE_START" | "ACCOUNT_CYCLE_FINISH";

export const accountCycleMessage = (event: AccountCycleEvent, accountKey: string) => `${event}:${accountKey}`;

export const writeAccountCycleMarker = async (params: {
  airtable: AirtableClient;
  runLogsTableName: string;
  timezone: string;
  accountKey: string;
  event: AccountCycleEvent;
  meta?: unknown;
}) => {
  const ts = DateTime.now().setZone(params.timezone).toISO() ?? new Date().toISOString();
  await params.airtable.createRecord(params.runLogsTableName, {
    [RunLogFields.Timestamp]: ts,
    [RunLogFields.Level]: "INFO",
    [RunLogFields.Subsystem]: "SCHEDULE",
    [RunLogFields.Message]: accountCycleMessage(params.event, params.accountKey),
    ...(params.meta !== undefined ? { [RunLogFields.MetaJson]: JSON.stringify(params.meta, null, 2) } : {})
  } as any);
};

export const getLastAccountCycleFinishedAt = async (params: {
  airtable: AirtableClient;
  runLogsTableName: string;
  timezone: string;
  accountKey: string;
}): Promise<DateTime | undefined> => {
  const msg = accountCycleMessage("ACCOUNT_CYCLE_FINISH", params.accountKey);
  const formula = `{${RunLogFields.Message}}="${escapeAirtableString(msg)}"`;

  const rows = await params.airtable.listAll<RunLog>(params.runLogsTableName, {
    filterByFormula: formula,
    sortField: RunLogFields.Timestamp,
    sortDirection: "desc",
    maxRecords: 1,
    fields: [RunLogFields.Timestamp, RunLogFields.Message]
  });

  const ts = String(rows[0]?.fields?.[RunLogFields.Timestamp] ?? "");
  const dt = ts ? DateTime.fromISO(ts).setZone(params.timezone) : undefined;
  return dt && dt.isValid ? dt : undefined;
};

