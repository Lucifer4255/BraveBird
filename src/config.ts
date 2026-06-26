import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

/**
 * Single source of truth for runtime configuration.
 *
 * Nothing else in the codebase reads `process.env` directly — everything imports
 * the validated `config` object below. Env is parsed once, at startup, and a bad
 * value fails loudly here rather than deep inside a workflow.
 */

const boolish = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v === "" ? def : v === "true" || v === "1"));

const EnvSchema = z.object({
  // Queue
  QUEUE_DRIVER: z.enum(["memory", "redis"]).default("memory"),
  REDIS_URL: z.string().default("redis://localhost:6379"),

  // Concurrency / browser
  WORKER_CONCURRENCY: z.coerce.number().int().positive().max(16).default(2),
  HEADLESS: boolish(true),

  // Stealth / proxy
  PROXY_URL: z.string().optional().transform((v) => (v ? v : undefined)),
  // Proxy pool: comma-separated entries. Each entry is a URL, optionally with
  // geo tags: "http://user:pass@host:port|US|America/New_York".
  PROXY_URLS: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [])),

  // Credentials
  BOOKING_EMAIL: z.string().optional().transform((v) => (v ? v : undefined)),
  BOOKING_PASSWORD: z.string().optional().transform((v) => (v ? v : undefined)),
  SAUCE_USERNAME: z.string().default("standard_user"),
  SAUCE_PASSWORD: z.string().default("secret_sauce"),

  // Tier-4 AI locator resolver (gated off by default).
  // Routed through OpenRouter via the official `@openrouter/sdk` client — it knows
  // its own endpoint, so no base URL needed. Cheap model by default; override freely.
  AI_LOCATOR_ENABLED: boolish(false),
  OPENROUTER_API_KEY: z.string().optional().transform((v) => (v ? v : undefined)),
  AI_LOCATOR_MODEL: z.string().default("google/gemini-2.5-flash-lite"),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // Fail fast with a readable message instead of a stack trace inside a worker.
  console.error("Invalid configuration:\n" + z.prettifyError(parsed.error));
  process.exit(1);
}
const env = parsed.data;

/**
 * A rotating pool of realistic, current desktop user-agents. The stealth layer
 * picks one per context so fingerprints are not identical across sessions.
 */
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
] as const;

export const config = {
  queue: {
    driver: env.QUEUE_DRIVER,
    redisUrl: env.REDIS_URL,
  },
  worker: {
    concurrency: env.WORKER_CONCURRENCY,
  },
  browser: {
    headless: env.HEADLESS,
    proxyUrl: env.PROXY_URL,
    proxyUrls: env.PROXY_URLS,
    userAgents: USER_AGENTS,
  },
  credentials: {
    booking:
      env.BOOKING_EMAIL && env.BOOKING_PASSWORD
        ? { email: env.BOOKING_EMAIL, password: env.BOOKING_PASSWORD }
        : undefined,
    sauce: { username: env.SAUCE_USERNAME, password: env.SAUCE_PASSWORD },
  },
  ai: {
    enabled: env.AI_LOCATOR_ENABLED,
    apiKey: env.OPENROUTER_API_KEY,
    model: env.AI_LOCATOR_MODEL,
  },
} as const;

export type Config = typeof config;
