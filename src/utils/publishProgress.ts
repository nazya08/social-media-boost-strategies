export type PublishProgress = {
  rootId?: string;
  publishedIds: string[];
  nextIndex: number;
  updatedAtIso: string;
};

const PREFIX = "PROGRESS:";

export const formatPublishProgress = (progress: PublishProgress, lastErrorMessage?: string) => {
  const json = JSON.stringify(progress);
  const base = `${PREFIX}${json}`;
  if (!lastErrorMessage) return base;
  return `${base}\nLAST_ERROR: ${lastErrorMessage}`.trim();
};

export const parsePublishProgress = (errorField: string | undefined | null): PublishProgress | undefined => {
  const raw = String(errorField ?? "").trim();
  if (!raw.startsWith(PREFIX)) return undefined;
  const firstLine = raw.split(/\r?\n/)[0] ?? "";
  const json = firstLine.slice(PREFIX.length).trim();
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as PublishProgress;
    if (!parsed || typeof parsed !== "object") return undefined;
    const publishedIds = Array.isArray(parsed.publishedIds) ? parsed.publishedIds.map(String) : [];
    const nextIndex = Number.isFinite(Number(parsed.nextIndex)) ? Number(parsed.nextIndex) : 0;
    const updatedAtIso = typeof parsed.updatedAtIso === "string" ? parsed.updatedAtIso : "";
    const rootId = typeof parsed.rootId === "string" ? parsed.rootId : undefined;
    if (publishedIds.length === 0 && !rootId) return undefined;
    if (!updatedAtIso) return undefined;
    return { rootId, publishedIds, nextIndex, updatedAtIso };
  } catch {
    return undefined;
  }
};

