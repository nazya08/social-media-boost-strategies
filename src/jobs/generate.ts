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

  const alternativesCount = lines.filter((l) => /(→|->|=>)/.test(l)).length;
  if (alternativesCount >= 3) return "alternatives_list";

  const numberedCount = lines.filter((l) => /^\d+[.)]\s+/.test(l)).length;
  if (numberedCount >= 5) return "tool_list";

  return undefined;
};

const rebalanceListParts = (format: string, parts: string[], maxChars: number) => {
  if (!(format === "tool_list" || format === "alternatives_list")) return parts;
  if (parts.length < 2) return parts;

  const cta = String(parts[parts.length - 1] ?? "").trim();
  const content = parts.slice(0, -1);

  const isToolLine = (line: string) => /^\s*(\d+[.)]\s+|[-•]\s+)\S+/.test(line);
  const isAltLine = (line: string) => /\S+\s*(→|->|=>)\s*\S+/.test(line);
  const isListLine = (line: string) => (format === "tool_list" ? isToolLine(line) : isAltLine(line));

  const lines = content
    .join("\n")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const uniqueListLines = Array.from(new Set(lines.filter(isListLine)));
  if (uniqueListLines.length === 0) return parts;

  const maxListLines = format === "tool_list" ? 14 : 12;
  const listLines = uniqueListLines.slice(0, maxListLines);

  const firstPartLines = String(content[0] ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const hook = firstPartLines.find((l) => !isListLine(l)) ?? firstPartLines[0] ?? "";

  const chunks: string[] = [];
  const pushChunk = (chunkLines: string[]) => {
    const text = chunkLines.join("\n").trim();
    if (!text) return;
    chunks.push(text.length > maxChars ? text.slice(0, maxChars).trim() : text);
  };

  let current: string[] = [];
  if (hook) current.push(hook.length > maxChars ? hook.slice(0, maxChars).trim() : hook);

  for (const line of listLines) {
    const candidate = current.length === 0 ? line : `${current.join("\n")}\n${line}`;
    if (candidate.length <= maxChars) {
      current.push(line);
      continue;
    }
    pushChunk(current);
    current = [line.length > maxChars ? line.slice(0, maxChars).trim() : line];
  }
  pushChunk(current);

  return [...chunks, cta].filter(Boolean);
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
  ctaUrlOverride?: string;
  ctaTextEnOverride?: string;
  ctaTextUaOverride?: string;
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
    const langRaw = String(post.fields?.[PostFields.Language] ?? "UA").trim().toUpperCase();
    const configuredLanguage = langRaw === "EN" ? ("EN" as const) : ("UA" as const);
    const inferredLanguage = detectLanguage(`${seedTitle}\n${seedText}`);
    const language = configuredLanguage === "UA" && inferredLanguage === "EN" ? ("EN" as const) : configuredLanguage;

    const configuredCtaUrl = params.ctaUrlOverride ?? String(post.fields?.[PostFields.CtaUrl] ?? "");
    const ctaUrl = configuredCtaUrl || "https://t.me/solutions_247ai";
    const ctaText =
      language === "EN"
        ? params.ctaTextEnOverride ?? String(post.fields?.[PostFields.CtaText] ?? "More about AI & automation here:")
        : params.ctaTextUaOverride ?? String(post.fields?.[PostFields.CtaText] ?? "Більше про AI та автоматизацію тут:");

    try {
      processed += 1;
      const formatHint = inferFormatHint(seedTitle, seedText);
      const partsTargetMin =
        formatHint === "tool_list" || formatHint === "alternatives_list" ? 2 : params.partsTargetMin;
      const partsTargetMax =
        formatHint === "tool_list" || formatHint === "alternatives_list"
          ? Math.min(5, Math.max(2, params.partsTargetMax))
          : params.partsTargetMax;
      let generated = await params.anthropic.generateThread({
        seedTitle,
        seedText,
        seedUrl,
        language,
        formatHint,
        maxCharsPerPart: params.maxCharsPerPart,
        partsTargetMin,
        partsTargetMax,
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
          partsTargetMin,
          partsTargetMax,
          ctaText,
          ctaUrl
        });
      }

      const adjustedParts = rebalanceListParts(generated.format, generated.parts, params.maxCharsPerPart);

      await params.airtable.updateRecord(params.postsTableName, postId, {
        [PostFields.PostStatus]: "Generated",
        [PostFields.Format]: generated.format,
        [PostFields.Language]: generated.language,
        [PostFields.ThreadPartsJson]: JSON.stringify(adjustedParts),
        [PostFields.ThreadPreview]: toPreview(adjustedParts),
        [PostFields.CtaText]: ctaText,
        [PostFields.CtaUrl]: ctaUrl,
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
