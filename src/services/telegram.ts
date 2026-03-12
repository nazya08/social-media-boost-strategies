export type TelegramClientOptions = {
  botToken: string;
  chatId: string;
  messageThreadId?: string;
};

export class TelegramClient {
  constructor(private readonly options: TelegramClientOptions) {}

  async sendMessage(text: string) {
    const url = `https://api.telegram.org/bot${this.options.botToken}/sendMessage`;
    const payload: Record<string, unknown> = {
      chat_id: this.options.chatId,
      text
    };
    if (this.options.messageThreadId) {
      payload.message_thread_id = Number(this.options.messageThreadId);
    }

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`Telegram HTTP ${res.status}: ${body}`);
  }
}

