import { createHash, randomInt } from "node:crypto";

export const sha256Hex = (input: string) => createHash("sha256").update(input).digest("hex");

export const jitterMs = (minMs: number, maxMs: number) => {
  if (maxMs <= minMs) return minMs;
  return randomInt(minMs, maxMs + 1);
};

