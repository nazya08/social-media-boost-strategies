import { AppConfig } from "./config.js";
import { ThreadsClientOptions } from "./services/threads.js";

export type ThreadsAccountConfig = {
  key: string;
  isDefault: boolean;
  intervalHours: number;
  threads: ThreadsClientOptions;
};

const parseCsv = (value: string | undefined) =>
  String(value ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

const normalizeAccountKey = (raw: string) => raw.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");

const intFromEnv = (value: string | undefined) => {
  if (!value) return undefined;
  const parsed = Number.parseInt(String(value).trim(), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const requireEnv = (name: string) => {
  const v = String(process.env[name] ?? "").trim();
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
};

export const loadThreadsAccounts = (config: AppConfig): ThreadsAccountConfig[] => {
  const additionalRaw = parseCsv(process.env.THREADS_ADDITIONAL_ACCOUNTS);
  const additionalKeys = additionalRaw.map(normalizeAccountKey);

  const defaultKey = normalizeAccountKey(process.env.THREADS_DEFAULT_ACCOUNT_KEY ?? "DEFAULT");

  const accounts: ThreadsAccountConfig[] = [
    {
      key: defaultKey,
      isDefault: true,
      intervalHours: config.runtime.intervalHours,
      threads: {
        accessToken: config.threads.accessToken,
        userId: config.threads.userId,
        deviceId: config.threads.deviceId,
        apiBaseUrl: config.threads.apiBaseUrl,
        replyRetryCount: config.threads.replyRetryCount,
        replyRetryDelayMs: config.threads.replyRetryDelayMs,
        interPartDelayMs: config.threads.interPartDelayMs
      }
    }
  ];

  for (const key of additionalKeys) {
    if (key === defaultKey) continue;

    const accessToken = requireEnv(`THREADS_ACCESS_TOKEN_${key}`);
    const userId = requireEnv(`THREADS_USER_ID_${key}`);
    const deviceId = String(process.env[`THREADS_DEVICE_ID_${key}`] ?? "").trim() || config.threads.deviceId;

    const intervalHours =
      intFromEnv(process.env[`THREADS_INTERVAL_HOURS_${key}`]) ?? intFromEnv(process.env[`THREADS_ACCOUNT_INTERVAL_HOURS_${key}`]) ?? config.runtime.intervalHours;

    accounts.push({
      key,
      isDefault: false,
      intervalHours,
      threads: {
        accessToken,
        userId,
        deviceId,
        apiBaseUrl: config.threads.apiBaseUrl,
        replyRetryCount: config.threads.replyRetryCount,
        replyRetryDelayMs: config.threads.replyRetryDelayMs,
        interPartDelayMs: config.threads.interPartDelayMs
      }
    });
  }

  return accounts;
};

