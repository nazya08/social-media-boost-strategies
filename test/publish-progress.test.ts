import { describe, expect, it } from "vitest";
import { formatPublishProgress, parsePublishProgress } from "../src/utils/publishProgress.js";

describe("publishProgress", () => {
  it("round-trips PROGRESS JSON", () => {
    const formatted = formatPublishProgress({
      rootId: "root123",
      publishedIds: ["root123", "r1"],
      nextIndex: 2,
      updatedAtIso: "2026-03-13T00:00:00.000Z"
    });

    const parsed = parsePublishProgress(formatted)!;
    expect(parsed.rootId).toBe("root123");
    expect(parsed.publishedIds).toEqual(["root123", "r1"]);
    expect(parsed.nextIndex).toBe(2);
  });

  it("parses PROGRESS with LAST_ERROR suffix", () => {
    const formatted = formatPublishProgress(
      {
        rootId: "root123",
        publishedIds: ["root123"],
        nextIndex: 1,
        updatedAtIso: "2026-03-13T00:00:00.000Z"
      },
      "Threads HTTP 500: boom"
    );

    const parsed = parsePublishProgress(formatted)!;
    expect(parsed.rootId).toBe("root123");
    expect(parsed.nextIndex).toBe(1);
  });
});

