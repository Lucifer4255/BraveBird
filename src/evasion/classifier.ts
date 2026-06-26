import type { Page, Response } from "playwright";

/**
 * Response classifier — decides what actually happened after a navigation.
 *
 *   ok        — real content, proceed
 *   challenge — JS interstitial ("Just a moment…"), usually auto-passes
 *   captcha   — a solvable puzzle (reCAPTCHA / hCaptcha / Turnstile / DataDome)
 *   blocked   — hard wall (403 / 429 / "Access Denied")
 *
 * You can't react to a block you don't detect. This feeds detect-and-react:
 * blocked → burn identity + proxy → retry fresh; captcha → solve (or rotate).
 */

export type Verdict = "ok" | "challenge" | "captcha" | "blocked";
export type CaptchaKind = "recaptcha" | "hcaptcha" | "turnstile" | "datadome";

export interface CaptchaInfo {
  kind: CaptchaKind;
  sitekey?: string;
}

export interface Classification {
  verdict: Verdict;
  reason: string;
  captcha?: CaptchaInfo;
}

/** DOM signatures of the common CAPTCHA widgets (locator-based, no page.evaluate). */
const CAPTCHA_SELECTORS: Array<[CaptchaKind, string]> = [
  ["datadome", "iframe[src*='captcha-delivery.com'], iframe[src*='geo.captcha-delivery']"],
  ["turnstile", ".cf-turnstile, iframe[src*='challenges.cloudflare.com']"],
  ["hcaptcha", ".h-captcha, iframe[src*='hcaptcha.com']"],
  ["recaptcha", ".g-recaptcha, iframe[src*='recaptcha']"],
];

async function detectCaptcha(page: Page): Promise<CaptchaInfo | null> {
  for (const [kind, selector] of CAPTCHA_SELECTORS) {
    if ((await page.locator(selector).count()) > 0) {
      const sitekey =
        (await page.locator("[data-sitekey]").first().getAttribute("data-sitekey").catch(() => null)) ??
        undefined;
      return { kind, sitekey };
    }
  }
  return null;
}

/**
 * Classify the current page. Pass the navigation `response` for status/headers
 * (DOM markers alone can miss a 403 that still renders a styled block page).
 */
export async function classify(
  page: Page,
  response?: Response | null,
): Promise<Classification> {
  const status = response?.status() ?? 200;
  const headers: Record<string, string> = response
    ? await response.allHeaders().catch(() => ({}))
    : {};
  const server = (headers["server"] ?? "").toLowerCase();
  const body = (await page.locator("body").innerText().catch(() => "")).slice(0, 2000).toLowerCase();

  // 1. CAPTCHA first — it's the most actionable (solvable) outcome.
  const captcha = await detectCaptcha(page);
  if (captcha) {
    return { verdict: "captcha", reason: `${captcha.kind} widget present`, captcha };
  }

  // 2. Hard block / rate-limit.
  if (status === 429) return { verdict: "blocked", reason: "HTTP 429 (rate limited)" };
  if (status === 403 || /access denied|you have been blocked|unusual traffic from your/i.test(body)) {
    return { verdict: "blocked", reason: `HTTP ${status} / block page` };
  }

  // 3. JS challenge interstitial (often auto-passes after a moment).
  if (
    /just a moment|checking your browser|verifying you are human|enable javascript and cookies/i.test(body) ||
    (server.includes("datadome") && status >= 400)
  ) {
    return { verdict: "challenge", reason: "interstitial challenge" };
  }

  return { verdict: "ok", reason: `HTTP ${status}` };
}
