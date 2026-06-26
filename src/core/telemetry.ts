import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext } from "playwright";
import { config } from "../config.js";

/**
 * Failure telemetry — the forensics the assignment requires, captured on the way
 * out of a hard failure: error.log + screenshot.png + page.html + a Playwright
 * trace.zip (replayable). The trace would have shown the Goa modal on the first
 * replay — that's why it's worth its weight for a browser worker.
 *
 * Inngest already shows orchestration (what failed, retries). This captures the
 * thing Inngest can't: what the PAGE looked like when it broke.
 */

export interface FailureInfo {
  jobId: string;
  site: string;
  step?: string;
  error: unknown;
  identity?: string;
  proxy?: string;
}

/** The structured failure event sent to a sink (Sentry/Datadog plug in here). */
export interface TelemetryEvent {
  jobId: string;
  site: string;
  step?: string;
  error: string;
  identity?: string;
  proxy?: string;
  artifactsDir: string;
  at: string;
}

/**
 * Where the structured failure event goes. Default emits JSON to the console;
 * a Sentry/Datadog adapter implements this same interface and `setTelemetrySink`s
 * it in — the capture code never changes.
 */
export interface TelemetrySink {
  emit(event: TelemetryEvent): void | Promise<void>;
}

export class ConsoleSink implements TelemetrySink {
  emit(event: TelemetryEvent): void {
    console.error(`[telemetry] ${JSON.stringify(event)}`);
  }
}

let sink: TelemetrySink = new ConsoleSink();
export function setTelemetrySink(next: TelemetrySink): void {
  sink = next;
}

function describeError(error: unknown): { message: string; detail: string } {
  if (error instanceof Error) {
    return { message: error.message, detail: error.stack ?? error.message };
  }
  return { message: String(error), detail: String(error) };
}

/**
 * Capture forensics for a failed job into telemetry/failures/<jobId>-<ts>/.
 * Must be called while the context is still OPEN (so the page is live) — the
 * caller still closes the context in `finally`. The Playwright trace is saved by
 * stopping tracing here (BrowserManager started it at context creation).
 */
export async function captureFailure(
  context: BrowserContext,
  info: FailureInfo,
): Promise<string | undefined> {
  if (!config.telemetry.enabled) return undefined;

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(config.telemetry.dir, "failures", `${info.jobId}-${ts}`);
  await mkdir(dir, { recursive: true });

  const { message, detail } = describeError(info.error);
  const page = context.pages()[0];

  // 1. error.log — exception + which step + job + identity/proxy.
  await writeFile(
    join(dir, "error.log"),
    [
      `job:      ${info.jobId}`,
      `site:     ${info.site}`,
      `step:     ${info.step ?? "(unknown)"}`,
      `identity: ${info.identity ?? "-"}`,
      `proxy:    ${info.proxy ?? "-"}`,
      `time:     ${new Date().toISOString()}`,
      ``,
      detail,
      ``,
    ].join("\n"),
  ).catch(() => {});

  // 2 + 3. screenshot + raw HTML (need a live page).
  if (page) {
    await page.screenshot({ path: join(dir, "screenshot.png"), fullPage: true }).catch(() => {});
    await writeFile(join(dir, "page.html"), await page.content().catch(() => "")).catch(() => {});
  }

  // 4. Playwright trace — stop with a path to SAVE it (replayable timeline).
  await context.tracing.stop({ path: join(dir, "trace.zip") }).catch(() => {});

  const event: TelemetryEvent = {
    jobId: info.jobId,
    site: info.site,
    step: info.step,
    error: message,
    identity: info.identity,
    proxy: info.proxy,
    artifactsDir: dir,
    at: new Date().toISOString(),
  };
  await Promise.resolve(sink.emit(event)).catch(() => {});

  return dir;
}
