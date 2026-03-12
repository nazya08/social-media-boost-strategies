import { describe, expect, it, vi } from "vitest";
import { publishNowJob } from "../src/jobs/publishNow.js";

describe("publishNowJob", () => {
  it("keeps post Generated (not Failed) on attempt 1/3 and does not alert Telegram", async () => {
    const updates: Array<{ recordId: string; fields: Record<string, unknown> }> = [];

    const airtable = {
      listAll: vi.fn(async () => [
        {
          id: "recPOST1",
          fields: {
            "Post Status": "Generated",
            "Attempt Count": 0,
            "Thread Parts JSON": JSON.stringify(["Root", "CTA https://t.me/nazik_fill_ai_tech"]),
            "Seed URL": "https://example.com"
          }
        }
      ]),
      updateRecord: vi.fn(async (_tableName: string, recordId: string, fields: any) => {
        updates.push({ recordId, fields });
        return { id: recordId, fields };
      })
    } as any;

    const logger = { log: vi.fn(async () => {}) } as any;
    const threads = {
      publishThread: vi.fn(async () => {
        throw new Error("Threads HTTP 500: boom");
      })
    } as any;
    const telegram = { sendMessage: vi.fn(async () => {}) } as any;

    await publishNowJob({
      airtable,
      postsTableName: "Posts",
      logger,
      threads,
      telegram,
      timezone: "Europe/Kiev",
      maxCharsPerPart: 450,
      autopublishEnabled: true,
      postMediaEnabled: false
    });

    const finalUpdate = updates[updates.length - 1];
    expect(finalUpdate.recordId).toBe("recPOST1");
    expect(finalUpdate.fields["Post Status"]).toBe("Generated");
    expect(telegram.sendMessage).toHaveBeenCalledTimes(0);
  });

  it("marks post Failed and sends CRITICAL Telegram alert on attempt 3/3", async () => {
    const updates: Array<{ recordId: string; fields: Record<string, unknown> }> = [];

    const airtable = {
      listAll: vi.fn(async () => [
        {
          id: "recPOST2",
          fields: {
            "Post Status": "Generated",
            "Attempt Count": 2,
            "Thread Parts JSON": JSON.stringify(["Root", "CTA https://t.me/nazik_fill_ai_tech"]),
            "Seed URL": "https://example.com"
          }
        }
      ]),
      updateRecord: vi.fn(async (_tableName: string, recordId: string, fields: any) => {
        updates.push({ recordId, fields });
        return { id: recordId, fields };
      })
    } as any;

    const logger = { log: vi.fn(async () => {}) } as any;
    const threads = {
      publishThread: vi.fn(async () => {
        throw new Error("Threads HTTP 500: boom");
      })
    } as any;
    const telegram = { sendMessage: vi.fn(async () => {}) } as any;

    await publishNowJob({
      airtable,
      postsTableName: "Posts",
      logger,
      threads,
      telegram,
      timezone: "Europe/Kiev",
      maxCharsPerPart: 450,
      autopublishEnabled: true,
      postMediaEnabled: false
    });

    const finalUpdate = updates[updates.length - 1];
    expect(finalUpdate.recordId).toBe("recPOST2");
    expect(finalUpdate.fields["Post Status"]).toBe("Failed");
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(String(telegram.sendMessage.mock.calls[0]?.[0] ?? "")).toContain("CRITICAL");
  });
});

