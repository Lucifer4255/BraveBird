import type { Page } from "playwright";

/**
 * CAPTCHA solving — Strategy + Factory.
 *
 * "Solve a captcha" isn't one operation: an image grid → click tiles; a math
 * captcha → compute a number; a vendor captcha → fetch a token. Each is a
 * separate STRATEGY; the registry (factory) picks the first that can handle a
 * given challenge. New captcha type = new strategy, register it, done.
 */

export type CaptchaProvider = "recaptcha" | "hcaptcha" | "turnstile" | "datadome";

/** The SHAPE of the challenge — determines how solving works. */
export type CaptchaType = "image-grid" | "text" | "math" | "token" | "behavioral";

export interface CaptchaChallenge {
  type: CaptchaType;
  /** Page URL the captcha is on. */
  url: string;
  provider?: CaptchaProvider;
  sitekey?: string;
  /** Instruction/question: "select all buses", "What is 7 + 5?". */
  prompt?: string;
  /** Base64 PNG of the challenge, for vision strategies. */
  imageBase64?: string;
  /** Live page, for strategies that interact directly. */
  page?: Page;
}

/** How a solution is applied back to the page differs per challenge shape. */
export type CaptchaSolution =
  | { kind: "token"; token: string } // inject the token (vendor services)
  | { kind: "text"; value: string } // type into an input (math / OCR text)
  | { kind: "tiles"; indices: number[] }; // click these grid tiles (image-grid)

/** Strategy pattern: one way of solving one family of challenge. */
export interface CaptchaStrategy {
  readonly name: string;
  canHandle(challenge: CaptchaChallenge): boolean;
  solve(challenge: CaptchaChallenge): Promise<CaptchaSolution>;
}
