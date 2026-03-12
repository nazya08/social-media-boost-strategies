import { describe, expect, it, vi } from "vitest";
import { healthJob } from "../src/jobs/health.js";

describe("healthJob", () => {
  it("alerts when scheduled posts are overdue or publishing is stale", async () => {
    const airtable = {
      listAll: vi.fn(async (_tableName: string, options?: any) => {
        const formula = String(options?.filterByFormula ?? "");
        if (formula.includes('Post Status') && formula.includes('"Scheduled"') && formula.includes("Scheduled At")) {
          return [
            {
              id: "recOverdue",
              fields: { "Seed URL": "https://example.com", "Scheduled At": new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() }
            }
          ];
        }
        if (formula.includes('"Generated"') || formula.includes('"Scheduled"')) {
          return [{ id: "recQueue", fields: { "Post Status": "Scheduled" } }];
        }
        if (formula.includes('"Published"')) {
          return []; // no published
        }
        return [];
      })
    } as any;

    const logger = { log: vi.fn(async () => {}) } as any;
    const telegram = { sendMessage: vi.fn(async () => {}) } as any;

    await healthJob({
      airtable,
      postsTableName: "Posts",
      logger,
      telegram,
      timezone: "Europe/Kiev"
    });

    expect(logger.log).toHaveBeenCalled();
    expect(telegram.sendMessage).toHaveBeenCalled();
    expect(String(telegram.sendMessage.mock.calls[0]?.[0] ?? "")).toContain("CRITICAL HEALTH");
  });
});
