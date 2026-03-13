import { describe, expect, it } from "vitest";
import {
  buildRootWithLines,
  extractNumberedLines,
  extractSwapLines,
  rewriteSwapLine,
  rewriteToolListLine,
  rootHasNumberedListLines,
  rootHasSwapLines
} from "../src/utils/listSeed.js";

describe("listSeed helpers", () => {
  it("rewrites numbered tool_list lines and builds a root within the limit", () => {
    const seed = `1. 🇹🇭 VPN = cheaper Agoda
2. 🇵🇹 VPN = cheaper Ryanair
3. 🇮🇳 VPN = cheaper flights
4. 🇿🇦 VPN = cheaper resort packages
5. 🇲🇽 VPN = cheaper Spotify`;

    const numbered = extractNumberedLines(seed);
    const rewritten = numbered.map((l) => rewriteToolListLine(l, "EN"));
    const root = buildRootWithLines("VPN pricing hack:", rewritten, 500);

    expect(root.length).toBeLessThanOrEqual(500);
    expect(rootHasNumberedListLines(root, 3)).toBe(true);
    expect(root).toContain("Agoda");
    expect(root).toContain("Ryanair");
  });

  it("extracts and normalizes alternatives swaps", () => {
    const seed = `Claude -> Misty
Gmail => Proton Mail
Netflix → Peacock`;
    const swaps = extractSwapLines(seed).map((l) => rewriteSwapLine(l));
    const root = buildRootWithLines("Paid → free:", swaps, 500);

    expect(rootHasSwapLines(root, 3)).toBe(true);
    expect(root).toContain("Claude → Misty");
    expect(root).toContain("Gmail → Proton Mail");
  });
});

