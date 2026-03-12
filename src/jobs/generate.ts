import { AirtableClient } from "../airtable/airtableClient.js";
import { PostFields } from "../airtable/fields.js";
import { Logger } from "../logger.js";
import { AnthropicClient } from "../services/anthropic.js";
import { toPreview } from "../utils/text.js";

type Post = Record<string, unknown>;

const detectLanguage = (text: string): "UA" | "EN" => {
  const sample = text.slice(0, 2000);
  const latin = (sample.match(/[A-Za-z]/g) ?? []).length;
  const cyrillic = (sample.match(/[\u0400-\u04FF]/g) ?? []).length;
  if (latin > cyrillic * 2) return "EN";
  return "UA";
};

const hasTooMuchOverlap = (seed: string, generated: string) => {
  const seedNorm = seed.replace(/\s+/g, " ").toLowerCase();
  const genNorm = generated.replace(/\s+/g, " ").toLowerCase();
  const window = 80;
  for (let i = 0; i + window <= seedNorm.length; i += 40) {
    const sub = seedNorm.slice(i, i + window);
    if (sub.trim().length < window) continue;
    if (genNorm.includes(sub)) return true;
  }
  return false;
};

const inferFormatHint = (seedTitle: string, seedText: string): "tool_list" | "alternatives_list" | undefined => {
  const combined = `${seedTitle}\n${seedText}`;
  const lines = combined
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const alternativesCount = lines.filter((l) => /(→|->)/.test(l)).length;
  if (alternativesCount >= 3) return "alternatives_list";

  const numberedCount = lines.filter((l) => /^\d+[.)]\s+/.test(l)).length;
  if (numberedCount >= 5) return "tool_list";

  return undefined;
};

const enforceRootListForToolPosts = (format: string, parts: string[], maxChars: number) => {
  if (!(format === "tool_list" || format === "alternatives_list")) return parts;
  if (parts.length < 2) return parts;

  const cta = parts[parts.length - 1]!;
  const nonCta = parts.slice(0, -1);
  const combined = nonCta.join("\n");

  const listLineRegex =
    format === "tool_list"
      ? /^\s*\d+[.)]\s+.+/m
      : /^\s*.+\s*(→|->)\s*.+/m;

  const fitLines = (lines: string[]) => {
    const kept: string[] = [];
    for (const line of lines) {
      const next = kept.length === 0 ? line : `${kept.join("\n")}\n${line}`;
      if (next.length > maxChars) break;
      kept.push(line);
    }
    return kept.join("\n").trim();
  };

  // If root already has list lines, keep just root + CTA (compact) but never cut mid-line.
  if (listLineRegex.test(parts[0] ?? "")) {
    const rootLines = String(parts[0] ?? "")
      .split(/\r?\n/)
      .map((l) => l.trimEnd())
      .filter((l) => l.trim().length > 0);
    const fitted = fitLines(rootLines);
    return [fitted || String(parts[0] ?? "").slice(0, maxChars).trim(), cta];
  }

  // Extract candidate list lines from all parts.
  const lines = combined
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const listLines = lines.filter((l) => listLineRegex.test(l));
  const hook = (parts[0] ?? "").split(/\r?\n/)[0]?.trim() ?? "";
  const rootLines: string[] = [];
  if (hook) rootLines.push(hook);
  for (const l of listLines) {
    const next = rootLines.length === 0 ? l : `${rootLines.join("\n")}\n${l}`;
    if (next.length > maxChars) break;
    rootLines.push(l);
  }
  const root = rootLines.join("\n").trim();
  return [root || String(parts[0] ?? "").slice(0, maxChars).trim(), cta];
};

export const generateJob = async (params: {
  airtable: AirtableClient;
  postsTableName: string;
  logger: Logger;
  anthropic: AnthropicClient;
  maxCharsPerPart: number;
  partsTargetMin: number;
  partsTargetMax: number;
  maxRecords: number;
  recordIds?: string[];
}) => {
  let processed = 0;
  let generatedCount = 0;
  let failedCount = 0;
  const baseFilter = `OR({${PostFields.PostStatus}}="Seeded", AND({${PostFields.PostStatus}}="Failed", {${PostFields.ThreadPartsJson}}=""))`;
  const idsFilter =
    params.recordIds && params.recordIds.length > 0
      ? `OR(${params.recordIds.map((id) => `RECORD_ID()="${id}"`).join(",")})`
      : undefined;
  const filterByFormula = idsFilter ? `AND(${idsFilter}, ${baseFilter})` : baseFilter;

  const posts = await params.airtable.listAll<Post>(params.postsTableName, {
    filterByFormula,
    maxRecords: params.recordIds?.length ? params.recordIds.length : params.maxRecords
  });

  for (const post of posts) {
    const postId = post.id;
    const seedTitle = String(post.fields?.[PostFields.Title] ?? "Seed");
    const seedText = String(post.fields?.[PostFields.SeedText] ?? "");
    const seedUrl = String(post.fields?.[PostFields.SeedUrl] ?? "") || undefined;
    const ctaText = String(post.fields?.[PostFields.CtaText] ?? "Більше про AI та автоматизації тут:");
    const ctaUrl = String(post.fields?.[PostFields.CtaUrl] ?? "https://t.me/nazik_fill_ai_tech");
    const langRaw = String(post.fields?.[PostFields.Language] ?? "UA").trim().toUpperCase();
    const configuredLanguage = langRaw === "EN" ? ("EN" as const) : ("UA" as const);
    const inferredLanguage = detectLanguage(`${seedTitle}\n${seedText}`);
    const language = configuredLanguage === "UA" && inferredLanguage === "EN" ? ("EN" as const) : configuredLanguage;

    try {
      processed += 1;
      const formatHint = inferFormatHint(seedTitle, seedText);
      let generated = await params.anthropic.generateThread({
        seedTitle,
        seedText,
        seedUrl,
        language,
        formatHint,
        maxCharsPerPart: params.maxCharsPerPart,
        partsTargetMin: params.partsTargetMin,
        partsTargetMax: params.partsTargetMax,
        ctaText,
        ctaUrl
      });

      const root = generated.parts[0] ?? "";
      if (hasTooMuchOverlap(seedText, root)) {
        generated = await params.anthropic.generateThread({
          seedTitle,
          seedText,
          seedUrl,
          language,
          formatHint,
          maxCharsPerPart: params.maxCharsPerPart,
          partsTargetMin: params.partsTargetMin,
          partsTargetMax: params.partsTargetMax,
          ctaText,
          ctaUrl
        });
      }

      const adjustedParts = enforceRootListForToolPosts(generated.format, generated.parts, params.maxCharsPerPart);

      await params.airtable.updateRecord(params.postsTableName, postId, {
        [PostFields.PostStatus]: "Generated",
        [PostFields.Format]: generated.format,
        [PostFields.Language]: generated.language,
        [PostFields.ThreadPartsJson]: JSON.stringify(adjustedParts),
        [PostFields.ThreadPreview]: toPreview(adjustedParts),
        [PostFields.Error]: "",
        [PostFields.FailureSubsystem]: null
      } as any);
      generatedCount += 1;

      await params.logger.log({
        level: "INFO",
        subsystem: "GENERATE",
        message: `Generate: ok post ${postId}`,
        postRecordId: postId,
        meta: {
          format: generated.format,
          language: generated.language,
          partsCount: adjustedParts.length,
          rootLen: (adjustedParts[0] ?? "").length,
          maxCharsPerPart: params.maxCharsPerPart
        }
      });
    } catch (error) {
      await params.airtable.updateRecord(params.postsTableName, postId, {
        [PostFields.PostStatus]: "Failed",
        [PostFields.Error]: error instanceof Error ? error.message : String(error),
        [PostFields.FailureSubsystem]: "GENERATE"
      } as any);
      failedCount += 1;
      await params.logger.log({
        level: "ERROR",
        subsystem: "GENERATE",
        message: `Generation failed for post ${postId}`,
        postRecordId: postId,
        error
      });
    }
  }

  await params.logger.log({
    level: posts.length === 0 ? "INFO" : failedCount > 0 ? "WARN" : "INFO",
    subsystem: "GENERATE",
    message:
      posts.length === 0
        ? `Generate: no Seeded posts (table: ${params.postsTableName})`
        : `Generate: processed=${processed}, generated=${generatedCount}, failed=${failedCount}`,
    meta: { processed, generatedCount, failedCount }
  });
};
