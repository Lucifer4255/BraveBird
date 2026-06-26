import type { CaptchaChallenge, CaptchaSolution, CaptchaStrategy } from "../types.js";

/**
 * Solves simple arithmetic captchas ("What is 7 + 5?"). Free, deterministic, no
 * network — the cheapest strategy, so the registry tries it first.
 */
export class MathStrategy implements CaptchaStrategy {
  readonly name = "math";
  private static readonly EXPR = /(\d+)\s*([-+x*×/÷])\s*(\d+)/;

  canHandle(c: CaptchaChallenge): boolean {
    return c.type === "math" && !!c.prompt && MathStrategy.EXPR.test(c.prompt);
  }

  async solve(c: CaptchaChallenge): Promise<CaptchaSolution> {
    const m = c.prompt?.match(MathStrategy.EXPR);
    if (!m) throw new Error(`math: no expression found in "${c.prompt}"`);
    const a = Number(m[1]);
    const b = Number(m[3]);
    const op = m[2]!;
    const value =
      op === "+" ? a + b : op === "-" ? a - b : /[x*×]/.test(op) ? a * b : a / b;
    return { kind: "text", value: String(value) };
  }
}
