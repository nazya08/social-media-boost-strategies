export const normalizeForHash = (value: string) =>
  value
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim()
    .toLowerCase();

export const clamp = (value: string, maxChars: number) => {
  if (value.length <= maxChars) return value;
  return value.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "…";
};

export const safeJsonParse = <T>(value: string): T | undefined => {
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
};

export const toPreview = (parts: string[]) => parts.join("\n\n—\n\n");

