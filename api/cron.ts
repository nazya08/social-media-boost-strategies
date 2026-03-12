import { runOnce } from "../dist/runOnce.js";

export default async function handler(_req: any, res: any) {
  try {
    const summary = await runOnce();
    res.status(200).json({ ok: true, summary });
  } catch (err: any) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? { message: err.message, stack: err.stack } : { message: String(err) }
    });
  }
}
