import { loadConfig } from "./config.js";
import { runOnce } from "./runOnce.js";

const createExclusiveRunner = <T>(fn: () => Promise<T>) => {
  let running = false;
  return async (): Promise<T | undefined> => {
    if (running) return undefined;
    running = true;
    try {
      return await fn();
    } finally {
      running = false;
    }
  };
};

const main = async () => {
  const config = loadConfig();

  // Single exclusive runner for the whole cycle (multi-account is handled inside runOnce).
  const runCronCycle = createExclusiveRunner(async () => {
    await runOnce();
  });

  // Kick off immediately
  await runCronCycle();

  setInterval(runCronCycle, config.runtime.intervalHours * 60 * 60 * 1000);
};

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal:", err);
  process.exitCode = 1;
});
