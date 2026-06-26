import type { Page } from "playwright";
import type { CaptchaInfo } from "../classifier.js";
import type { CaptchaSolverRegistry } from "./registry.js";
import type { CaptchaChallenge, CaptchaSolution } from "./types.js";

/**
 * Bridge: a captcha the classifier DETECTED → the solver registry that SOLVES it.
 *
 * This is what makes the Strategy/Factory actually fire in the live flow. Honors
 * "avoid > solve": with no provider configured, no strategy can handle a vendor
 * captcha → returns false → the caller rotates identity+proxy instead. With a
 * provider configured (2Captcha / vision), the matching strategy runs and we
 * apply its solution.
 *
 * Returns true if solved + applied (continue), false if unsolved (rotate).
 */
export async function handleCaptcha(
  page: Page,
  info: CaptchaInfo,
  registry: CaptchaSolverRegistry,
): Promise<boolean> {
  const challenge: CaptchaChallenge = {
    type: "token", // vendor captchas (reCAPTCHA/hCaptcha/Turnstile) are solved to a token
    provider: info.kind,
    sitekey: info.sitekey,
    url: page.url(),
    page,
  };

  const strategy = registry.resolve(challenge);
  if (!strategy) return false; // nothing configured to handle it → caller rotates

  try {
    const solution = await strategy.solve(challenge);
    return await applySolution(page, solution);
  } catch {
    return false; // solve failed (e.g. service error/timeout) → rotate
  }
}

/** Apply a solution to the page. Token injection is the wired path. */
async function applySolution(page: Page, solution: CaptchaSolution): Promise<boolean> {
  if (solution.kind !== "token") return false; // tiles/text need site-specific UI steps

  // Inject the token into the standard reCAPTCHA/hCaptcha response fields. Single
  // arrow + arg-passed (no nested functions) → safe from the esbuild __name trap.
  const injected = await page
    .evaluate((token) => {
      let applied = false;
      for (const id of ["g-recaptcha-response", "h-captcha-response"]) {
        const el = document.getElementById(id);
        if (el) {
          (el as HTMLTextAreaElement).value = token;
          applied = true;
        }
      }
      return applied;
    }, solution.token)
    .catch(() => false);

  return injected;
}
