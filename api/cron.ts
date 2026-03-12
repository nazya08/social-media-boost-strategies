import { runOnce } from "../dist/runOnce.js";

export default async function handler(_req: any, res: any) {
  try {
    const secret = process.env.CRON_SECRET;
    if (secret) {
      const headerSecret = String(_req?.headers?.["x-cron-secret"] ?? "").trim();
      let querySecret = "";
      try {
        const base = `https://${String(_req?.headers?.host ?? "localhost")}`;
        const url = new URL(String(_req?.url ?? "/"), base);
        querySecret = String(url.searchParams.get("secret") ?? "").trim();
      } catch {
        // ignore
      }
      if (headerSecret !== secret && querySecret !== secret) {
        res.status(401).json({ ok: false, error: { message: "Unauthorized" } });
        return;
      }
    }

    const summary = await runOnce();
    res.status(200).json({ ok: true, summary });
  } catch (err: any) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? { message: err.message, stack: err.stack } : { message: String(err) }
    });
  }
}
