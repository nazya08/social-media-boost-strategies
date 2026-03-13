export type SeedLanguage = "UA" | "EN";

export const extractNumberedLines = (text: string) => {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => /^\d+[.)]\s+/.test(l));
};

export const extractSwapLines = (text: string) => {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => /\S+\s*(→|->|=>)\s*\S+/.test(l));
};

export const rewriteToolListLine = (line: string, language: SeedLanguage) => {
  const trimmed = line.trim();
  const match = trimmed.match(/^(\d+)[.)]\s*(.+?)\s*=\s*(.+)$/);
  if (!match) return trimmed;

  const n = match[1]!;
  const left = match[2]!.trim(); // e.g. "🇹🇭 VPN"
  let right = match[3]!.trim(); // e.g. "cheaper Agoda"

  right = right.replace(/^\s*cheaper\s+/i, "").trim();
  const thing = right || "deals";

  if (language === "UA") {
    return `${n}. ${thing} може бути дешевше через ${left}`;
  }
  return `${n}. ${thing} can be cheaper via ${left}`;
};

export const rewriteSwapLine = (line: string) => {
  const trimmed = line.trim();
  // Normalize arrows to a single symbol.
  return trimmed.replace(/\s*(->|=>)\s*/g, " → ").replace(/\s*→\s*/g, " → ");
};

export const rootHasNumberedListLines = (root: string, minCount: number) => {
  const lines = String(root ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const count = lines.filter((l) => /^\d+[.)]\s+/.test(l)).length;
  return count >= minCount;
};

export const rootHasSwapLines = (root: string, minCount: number) => {
  const lines = String(root ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const count = lines.filter((l) => /\S+\s*→\s*\S+/.test(l) || /\S+\s*(->|=>)\s*\S+/.test(l)).length;
  return count >= minCount;
};

export const buildRootWithLines = (hook: string, lines: string[], maxChars: number) => {
  const out: string[] = [];
  const hookClean = String(hook ?? "").trim();
  if (hookClean) out.push(hookClean);

  for (const l of lines) {
    const candidate = out.length === 0 ? l : `${out.join("\n")}\n${l}`;
    if (candidate.length > maxChars) break;
    out.push(l);
  }

  const text = out.join("\n").trim();
  return text.length > maxChars ? text.slice(0, maxChars).trim() : text;
};
