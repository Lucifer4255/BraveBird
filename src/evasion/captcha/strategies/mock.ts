import type { CaptchaChallenge, CaptchaSolution, CaptchaStrategy } from "../types.js";

/**
 * Catch-all stand-in for tests/local — handles any challenge with a fake answer
 * of the right shape. Never touches the network. Registered last (lowest priority).
 */
export class MockStrategy implements CaptchaStrategy {
  readonly name = "mock";

  canHandle(): boolean {
    return true;
  }

  async solve(c: CaptchaChallenge): Promise<CaptchaSolution> {
    if (c.type === "image-grid") return { kind: "tiles", indices: [0, 4, 8] };
    if (c.type === "math" || c.type === "text") return { kind: "text", value: "42" };
    return { kind: "token", token: `mock-${c.provider ?? c.type}-${Date.now()}` };
  }
}
