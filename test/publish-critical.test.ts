import { describe, expect, it, vi } from "vitest";
import { publishJob } from "../src/jobs/publish.js";

describe("publishJob", () => {
  it("marks post Failed and sends CRITICAL Telegram alert after 3rd attempt", async () => {
    const updates: Array<{ recordId: string; fields: Record<string, unknown> }> = [];

    const airtable = {
      listAll: vi.fn(async (_tableName: string, options?: any) => {
        if (options?.filterByFormula?.includes('Post Status') && options.filterByFormula.includes('"Scheduled"')) {
          return [
            {
              id: "recPOST1",
              fields: {
                "Scheduled At": new Date(Date.now() - 60_000).toISOString(),
                "Attempt Count": 2,
                "Thread Parts JSON": JSON.stringify(["Root", "CTA https://t.me/nazik_fill_ai_tech"]),
                "Seed URL": "https://example.com"
              }
            }
          ];
        }
        return [];
      }),
      updateRecord: vi.fn(async (_tableName: string, recordId: string, fields: any) => {
        updates.push({ recordId, fields });
        return { id: recordId, fields };
      })
    } as any;

    const logger = { log: vi.fn(async () => {}) } as any;
    const threads = { publishThread: vi.fn(async () => {
      throw new Error("Threads HTTP 500: boom");
    }) } as any;
    const telegram = { sendMessage: vi.fn(async () => {}) } as any;

    await publishJob({
      airtable,
      postsTableName: "Posts",
      logger,
      threads,
      telegram,
      timezone: "Europe/Kiev",
      maxCharsPerPart: 450,
      autopublishEnabled: true
    });

    const finalUpdate = updates[updates.length - 1];
    expect(finalUpdate.recordId).toBe("recPOST1");
    expect(finalUpdate.fields["Post Status"]).toBe("Failed");
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(String(telegram.sendMessage.mock.calls[0]?.[0] ?? "")).toContain("CRITICAL");
  });
});
