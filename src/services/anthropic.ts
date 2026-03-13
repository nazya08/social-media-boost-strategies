import { clamp } from "../utils/text.js";

export type GenerateThreadInput = {
  seedTitle: string;
  seedText: string;
  seedUrl?: string;
  language: "UA" | "EN";
  formatHint?: GeneratedThread["format"];
  maxCharsPerPart: number;
  partsTargetMin: number;
  partsTargetMax: number;
  ctaText: string;
  ctaUrl: string;
};

export type GeneratedThread = {
  format: "prompt_thread" | "tool_list" | "alternatives_list" | "news_insight";
  language: "UA" | "EN";
  parts: string[];
};

type AnthropicClientOptions = {
  apiKey: string;
  model: string;
};

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

export class AnthropicClient {
  constructor(private readonly options: AnthropicClientOptions) {}

  async generateThread(input: GenerateThreadInput): Promise<GeneratedThread> {
    const userSeed = [
      `SEED TITLE: ${input.seedTitle}`,
      `SEED URL: ${input.seedUrl ?? ""}`,
      `SEED TEXT:\n${input.seedText}`
    ].join("\n\n");

    const hintLineEn = input.formatHint ? `Preferred format: ${input.formatHint}. Use it unless clearly wrong.` : "";
    const hintLineUa = input.formatHint ? `Бажаний формат: ${input.formatHint}. Використай його, якщо це не явно неправильно.` : "";

    const baseRulesEn = [
      "You are a Threads content editor (English). Style: punchy, viral, clear, no fluff.",
      "Do NOT copy seed text verbatim (no long exact substrings). Write original content inspired by the seed angle.",
      `Hard constraint: each thread part <= ${input.maxCharsPerPart} characters.`,
      `Default length target: ${input.partsTargetMin}..${input.partsTargetMax} parts (you may use fewer/more if the format needs it).`,
      "Formats: prompt_thread, tool_list, alternatives_list, news_insight.",
      "Format rules:",
      "- prompt_thread: 8–12 parts; split prompts across parts; keep each prompt compact.",
      "- tool_list: EXACTLY 2 parts: (1) ROOT = hook + FULL list (fit within limit), (2) CTA. Do NOT continue the list in replies. Use the seed's specific items (rewritten) — don't replace the list with a generic claim.",
      "- alternatives_list: EXACTLY 2 parts: (1) ROOT = hook + FULL paid->free swaps list (fit within limit), (2) CTA. Do NOT continue the list in replies. Use the seed's specific swaps (rewritten) — don't replace the list with a generic claim.",
      "- news_insight: 3–6 parts; (news) → (why it matters) → (what to do).",
      "For tool_list/alternatives_list: ROOT must include at least 3 list lines (don't put the entire list only in replies).",
      "Keep lists useful but bounded: aim for ~10–14 total lines/items max (quality > quantity).",
      hintLineEn,
      `Last part must be CTA: "${input.ctaText} ${input.ctaUrl}".`
    ]
      .filter(Boolean)
      .join("\n");

    const baseRulesUa = [
      "Ти — український контент-редактор для Threads. Стиль: енергійний, віральний, чіткий, без води.",
      "Не копіюй seed-текст дослівно (жодних довгих дослівних шматків). Генеруй оригінальний контент за кутом (angle) зі SEED.",
      `Жорстке обмеження: кожна частина треду <= ${input.maxCharsPerPart} символів.`,
      `Дефолтна ціль довжини: ${input.partsTargetMin}..${input.partsTargetMax} частин (можна менше/більше, якщо формат цього вимагає).`,
      "Формати: prompt_thread, tool_list, alternatives_list, news_insight.",
      "Правила форматів:",
      "- prompt_thread: 8–12 частин; розкидай промпти по частинах; кожен короткий.",
      "- tool_list: РІВНО 2 частини: (1) ROOT = хук + ПОВНИЙ список (влізти в ліміт), (2) CTA. Не продовжуй список у replies. Використай конкретні пункти з seed (перепиши) — не замінюй список загальною фразою.",
      "- alternatives_list: РІВНО 2 частини: (1) ROOT = хук + ПОВНИЙ список свопів paid->free (влізти в ліміт), (2) CTA. Не продовжуй список у replies. Використай конкретні свопи з seed (перепиши) — не замінюй список загальною фразою.",
      "- news_insight: 3–6 частин; (новина) → (чому важливо) → (що робити).",
      "Для tool_list/alternatives_list: ROOT мусить мати щонайменше 3 рядки списку (не винось усе лише в replies).",
      "Списки обмежуй по кількості: орієнтир ~10–14 ліній/пунктів (якість > кількість).",
      hintLineUa,
      `Остання частина завжди CTA: "${input.ctaText} ${input.ctaUrl}".`
    ]
      .filter(Boolean)
      .join("\n");

    const system = input.language === "EN" ? baseRulesEn : baseRulesUa;

    const submitThreadTool = {
      name: "submit_thread",
      description: "Submit the generated Threads thread as structured data.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          format: { type: "string", enum: ["prompt_thread", "tool_list", "alternatives_list", "news_insight"] },
          language: { type: "string", enum: ["UA", "EN"] },
          parts: { type: "array", items: { type: "string" }, minItems: 2 }
        },
        required: ["format", "language", "parts"]
      }
    } as const;

    const payload = {
      model: this.options.model,
      max_tokens: 2200,
      temperature: 0.5,
      system,
      tools: [submitThreadTool],
      tool_choice: { type: "tool", name: "submit_thread" },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `${userSeed}\n\nUse the tool \`submit_thread\` to return the result. parts: root first, CTA last.`
            }
          ]
        }
      ]
    };

    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.options.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(payload)
    });

    const text = await res.text();
    if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${text}`);
    const data = JSON.parse(text) as any;

    const toolUse = Array.isArray(data?.content)
      ? data.content.find((c: any) => c && c.type === "tool_use" && c.name === "submit_thread")
      : undefined;
    const toolInput = toolUse?.input;

    let parsed: GeneratedThread | undefined;
    if (toolInput && typeof toolInput === "object") {
      parsed = toolInput as GeneratedThread;
    } else {
      // Fallback: try to recover from text response if tools are not returned
      const contentText = data?.content?.find?.((c: any) => c.type === "text")?.text ?? "";
      const firstBrace = contentText.indexOf("{");
      const lastBrace = contentText.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        const jsonSlice = contentText.slice(firstBrace, lastBrace + 1);
        parsed = JSON.parse(jsonSlice) as GeneratedThread;
      }
    }

    if (!parsed || !Array.isArray((parsed as any).parts) || parsed.parts.length < 2) {
      throw new Error("Anthropic returned invalid structured output.");
    }

    const sanitizedParts = parsed.parts.map((p: string) => clamp(String(p ?? ""), input.maxCharsPerPart).trim());
    const expectedCta = `${input.ctaText} ${input.ctaUrl}`.trim();
    const last = sanitizedParts[sanitizedParts.length - 1] ?? "";
    if (!last.includes(input.ctaUrl)) {
      sanitizedParts[sanitizedParts.length - 1] = expectedCta;
    }

    return {
      format: parsed.format,
      language: input.language,
      parts: sanitizedParts
    };
  }
}
