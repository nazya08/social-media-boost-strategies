import { runOnce } from "./runOnce.js";

runOnce().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});
