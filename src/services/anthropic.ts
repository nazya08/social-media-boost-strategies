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

    const system =
      input.language === "EN"
        ? [
            "You are a Threads content editor (English). Style: punchy, viral, clear, no fluff.",
            "Do NOT copy seed text verbatim (no long exact substrings).",
            "Write new content inspired by the seed angle.",
            `Constraint: each thread part <= ${input.maxCharsPerPart} characters.`,
            `Thread length: ${input.partsTargetMin}..${input.partsTargetMax} parts.`,
            "Formats: prompt_thread (prompts list), tool_list (tools list), alternatives_list (paid→free swaps), news_insight (news→insight→action).",
            "For tool_list: keep the root post under the limit by using 7–9 items max and very short descriptions.",
            "For alternatives_list: keep swaps concise; 6–10 lines max.",
            hintLineEn,
            `Last part must be CTA: "${input.ctaText} ${input.ctaUrl}".`
          ].join("\n")
        : [
            "Ти — український контент-редактор для Threads, стиль: енергійний, віральний, чіткий, без води.",
            "Ти не копіюєш текст дослівно з SEED (жодних довгих дослівних шматків).",
            "Ти генеруєш новий контент за ідеєю/кутом (angle) SEED.",
            `Обмеження: кожна частина треду <= ${input.maxCharsPerPart} символів.`,
            `Довжина треду: від ${input.partsTargetMin} до ${input.partsTargetMax} частин.`,
            "Формати: prompt_thread (список промптів), tool_list (список інструментів), alternatives_list (платне→безкоштовне), news_insight (новина→висновок→що робити).",
            "Для tool_list: щоб влізти в ліміт, роби 7–9 пунктів максимум і дуже короткі описи.",
            "Для alternatives_list: роби свопи коротко; 6–10 рядків максимум.",
            hintLineUa,
            `Остання частина завжди CTA: "${input.ctaText} ${input.ctaUrl}".`
          ].join("\n");

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

    const formatRule =
      input.language === "EN"
        ? "If format is tool_list or alternatives_list, return EXACTLY 2 parts: (1) hook + list, (2) CTA. Do not put the list only in replies."
        : "Якщо формат tool_list або alternatives_list — поверни РІВНО 2 частини: (1) хук + список, (2) CTA. Не винось список лише в replies.";

    const payload = {
      model: this.options.model,
      max_tokens: 2200,
      temperature: 0.5,
      system: system + "\n" + formatRule,
      tools: [submitThreadTool],
      tool_choice: { type: "tool", name: "submit_thread" },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                userSeed +
                "\n\nUse the tool `submit_thread` to return the result. parts: root first, CTA last."
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
      throw new Error(`Anthropic returned invalid structured output.`);
    }

    const sanitizedParts = parsed.parts.map((p: string) => clamp(String(p ?? ""), input.maxCharsPerPart).trim());
    const last = sanitizedParts[sanitizedParts.length - 1] ?? "";
    const expectedCta = `${input.ctaText} ${input.ctaUrl}`.trim();
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
