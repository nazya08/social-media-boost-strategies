import { describe, expect, it, vi } from "vitest";
import { TelegramClient } from "../src/services/telegram.js";

describe("TelegramClient", () => {
  it("sends message_thread_id for forum topics", async () => {
    const botToken = "TEST_TOKEN";
    const chatId = "-1002984562783";
    const messageThreadId = "206";

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      expect(body.chat_id).toBe(chatId);
      expect(body.message_thread_id).toBe(Number(messageThreadId));
      expect(String(body.text)).toContain("CRITICAL");

      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, result: { message_id: 1 } })
      } as any;
    });

    const client = new TelegramClient({ botToken, chatId, messageThreadId });
    await client.sendMessage("CRITICAL TEST");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });
});
