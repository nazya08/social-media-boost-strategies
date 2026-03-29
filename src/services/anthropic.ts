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

const countMatches = (text: string, re: RegExp) => (String(text ?? "").match(re) ?? []).length;

const stripUrls = (text: string) =>
  String(text ?? "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\bt\.me\/[A-Za-z0-9_]+\b/gi, "");

const isLikelyUkrainianText = (text: string) => {
  const sample = stripUrls(text).slice(0, 8000);
  const cyrillic = countMatches(sample, /[\u0400-\u04FF]/g);
  const latin = countMatches(sample, /[A-Za-z]/g);
  const total = cyrillic + latin;
  if (total < 40) return cyrillic >= 10;
  // Allow some Latin (brand names, code, URLs), but require Cyrillic dominance.
  return cyrillic >= 40 && cyrillic / total >= 0.55;
};

const isLikelyUkrainianParts = (parts: string[]) => {
  const content = parts.slice(0, -1); // ignore CTA
  if (content.length === 0) return true;
  if (!isLikelyUkrainianText(content.join("\n"))) return false;

  for (const part of content) {
    const sample = stripUrls(part);
    const cyrillic = countMatches(sample, /[\u0400-\u04FF]/g);
    const latin = countMatches(sample, /[A-Za-z]/g);
    const total = cyrillic + latin;
    if (total < 40) continue;
    if (cyrillic < latin) return false;
  }
  return true;
};

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
      "ROOT/хук (перша частина) має бути максимально сильним: з першого рядка зрозуміло (1) що за вигода/обіцянка, (2) для кого, (3) чому це варто зберегти.",
      "Дозволено (і бажано) додавати 1 короткий CAPS-фрагмент на старті (2–6 слів) або тригер-слово типу: ТЕРМІНОВО, БЕЗКОШТОВНО, ЗБЕРЕЖИ, ОЦЕ ВАЖЛИВО.",
      "Якщо в seed є капслок/терміновість/сильна цифра (200/год, 7 промптів, 30 днів) — збережи цей 'удар' у перекладі, не згладжуй інтонацію.",
      "Уникай м'яких/розмитих формулювань у хуку (\"може\", \"ніби\", \"схоже\"). Пиши впевнено і конкретно.",
      "Подача для UA: короткі рядки, багато повітря (переноси), 1–3 речення до списку. Часто працює 1-а особа (\"Я зробив/зробила…\") + контраст (\"І ось що сталося…\").",
      "Можеш (але не завжди) використовувати структури хуку: (1) мікро-історія → (2) висновок → (3) \"Ось X запитів/промптів…\" → (4) \"збережи\" у дужках.",
      "Звучання: максимально по-людськи. Менше 'штучних' канцеляризмів і маркетинг-кліше, більше простих слів, коротких фраз і природних інтонацій.",
      "Уникай кальок/англіцизмів там, де є нормальна українська (\"юзати\", \"імплементити\", \"оптимізувати\" → простіше).",
      "Уникай 'AI-пафосу' та шаблонних заходів: \"в цьому треді\", \"зараз розкажу\", \"давай розберемо\", \"насправді\", \"ти маєш це знати\", \"це змінить твоє життя\" — якщо без цього можна.",
      "Пиши як живий автор: допускається 1 легка розмовна вставка (\"чесно\", \"я спочатку не повірив/повірила\", \"без жартів\") — але без перегравання.",
      "Емодзі — мінімально (0–2 на весь тред), без спаму символами. Краще ритм і сенс, ніж декор.",
      "Тримай один тон звертання (\"ти\" або \"ви\") в межах одного треду — не змішуй.",
      "Не імітуй дослівно конкретні фрази з SEED/донора. Перефразовуй так, щоб сенс/ідея лишались, але формулювання було новим.",
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

    const system =
      input.language === "EN"
        ? baseRulesEn
        : [
            baseRulesUa,
            "",
            "IMPORTANT: Output must be Ukrainian. Translate ALL list items/prompts into Ukrainian. Do not output English sentences (brand names/URLs are ok)."
          ].join("\n");

    const callAnthropic = async (
      systemText: string,
      userText: string,
      temperature = 0.5
    ): Promise<GeneratedThread> => {
      const payload = {
        model: this.options.model,
        max_tokens: 2200,
        temperature,
        system: systemText,
        tools: [submitThreadTool],
        tool_choice: { type: "tool", name: "submit_thread" },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: userText
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

      return parsed;
    };

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

    const seedUserText = `${userSeed}\n\nUse the tool \`submit_thread\` to return the result. parts: root first, CTA last.`;
    let parsed = await callAnthropic(system, seedUserText);
    let sanitizedParts = parsed.parts.map((p: string) => clamp(String(p ?? ""), input.maxCharsPerPart).trim());
    const expectedCta = clamp(`${input.ctaText} ${input.ctaUrl}`.trim(), input.maxCharsPerPart).trim();
    const last = sanitizedParts[sanitizedParts.length - 1] ?? "";
    if (!last.includes(input.ctaUrl)) {
      sanitizedParts[sanitizedParts.length - 1] = expectedCta;
    }

    if (input.language === "UA") {
      if (!isLikelyUkrainianParts(sanitizedParts)) {
        const strictSystem = [
          system,
          "",
          "STRICT MODE: Rewrite EVERYTHING into Ukrainian (Cyrillic). Translate all list items/prompts into Ukrainian. Do not output English sentences."
        ].join("\n");
        parsed = await callAnthropic(strictSystem, seedUserText, 0.2);
        sanitizedParts = parsed.parts.map((p: string) => clamp(String(p ?? ""), input.maxCharsPerPart).trim());
        const retryLast = sanitizedParts[sanitizedParts.length - 1] ?? "";
        if (!retryLast.includes(input.ctaUrl)) {
          sanitizedParts[sanitizedParts.length - 1] = expectedCta;
        }
        if (!isLikelyUkrainianParts(sanitizedParts)) {
          const draft = sanitizedParts
            .map((p, i) => `PART ${i + 1}:\n${p}`)
            .join("\n\n");
          const translateSystem = [
            system,
            "",
            "EMERGENCY TRANSLATION MODE: You will be given a DRAFT thread that may be partially/fully English.",
            "Rewrite it into Ukrainian. Keep the same number of parts and the same structure (lists, numbering, bullets).",
            `Hard constraint: each part <= ${input.maxCharsPerPart} characters.`,
            `Last part MUST be exactly: "${expectedCta}".`,
            "Do not add new ideas, do not expand. Just rewrite/translate to Ukrainian and make it sound natural."
          ].join("\n");

          const translateUserText = [
            "DRAFT THREAD (rewrite into Ukrainian):",
            draft,
            "",
            "Use the tool `submit_thread` to return the result. parts: root first, CTA last."
          ].join("\n\n");

          parsed = await callAnthropic(translateSystem, translateUserText, 0.2);
          sanitizedParts = parsed.parts.map((p: string) => clamp(String(p ?? ""), input.maxCharsPerPart).trim());
          const retry2Last = sanitizedParts[sanitizedParts.length - 1] ?? "";
          if (!retry2Last.includes(input.ctaUrl)) {
            sanitizedParts[sanitizedParts.length - 1] = expectedCta;
          }

          if (!isLikelyUkrainianParts(sanitizedParts)) {
            throw new Error("UA generation failed: output is not Ukrainian (after retry).");
          }
        }
      }
    }

    return {
      format: parsed.format,
      language: input.language,
      parts: sanitizedParts
    };
  }
}
