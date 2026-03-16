import { AirtableClient } from "../airtable/airtableClient.js";
import { RunLogFields } from "../airtable/fields.js";

type RunLog = Record<string, unknown>;

export const runLogsCleanupJob = async (params: {
  airtable: AirtableClient;
  runLogsTableName: string;
  // When the table reaches this threshold, delete oldest records down to trimTo.
  thresholdRecords: number;
  trimToRecords: number;
}) => {
  if (params.thresholdRecords <= params.trimToRecords) return;

  // Fetch oldest records up to threshold+1. If we get <= threshold, we skip.
  const scanLimit = params.thresholdRecords + 1;
  const oldest = await params.airtable.listAll<RunLog>(params.runLogsTableName, {
    maxRecords: scanLimit,
    sortField: RunLogFields.Timestamp,
    sortDirection: "asc",
    fields: [RunLogFields.Timestamp]
  });

  if (oldest.length <= params.thresholdRecords) return;

  const toDeleteCount = Math.min(oldest.length, params.thresholdRecords) - params.trimToRecords;
  if (toDeleteCount <= 0) return;

  const ids = oldest.slice(0, toDeleteCount).map((r) => r.id);
  // Delete in chunks of 10 (Airtable limit).
  for (let i = 0; i < ids.length; i += 10) {
    await params.airtable.deleteRecords(params.runLogsTableName, ids.slice(i, i + 10));
  }
};

