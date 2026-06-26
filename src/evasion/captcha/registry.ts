import { config } from "../../config.js";
import { MathStrategy } from "./strategies/math.js";
import { MockStrategy } from "./strategies/mock.js";
import { TokenServiceStrategy, TwoCaptchaService } from "./strategies/tokenService.js";
import { VisionGridStrategy } from "./strategies/visionGrid.js";
import type { CaptchaChallenge, CaptchaSolution, CaptchaStrategy } from "./types.js";

/**
 * Factory + registry. Strategies are tried in registration order; the first that
 * `canHandle` the challenge wins. Adding a captcha type = write a strategy and
 * register it here — nothing else changes.
 */
export class CaptchaSolverRegistry {
  private readonly strategies: CaptchaStrategy[] = [];

  register(strategy: CaptchaStrategy): this {
    this.strategies.push(strategy);
    return this;
  }

  resolve(c: CaptchaChallenge): CaptchaStrategy | undefined {
    return this.strategies.find((s) => s.canHandle(c));
  }

  async solve(c: CaptchaChallenge): Promise<CaptchaSolution> {
    const strategy = this.resolve(c);
    if (!strategy) {
      throw new Error(
        `no captcha strategy for type "${c.type}"${c.provider ? ` (${c.provider})` : ""}`,
      );
    }
    return strategy.solve(c);
  }

  get names(): string[] {
    return this.strategies.map((s) => s.name);
  }
}

/**
 * Build the registry from config — cheapest/most-specific first, mock last.
 * Avoid > solve: only enable the network/paid strategies that are configured.
 */
export function createCaptchaRegistry(): CaptchaSolverRegistry {
  const registry = new CaptchaSolverRegistry();

  // Free + deterministic — always on.
  registry.register(new MathStrategy());

  // Vision LLM for image grids — when OpenRouter is configured.
  if (config.ai.apiKey) registry.register(new VisionGridStrategy());

  // Paid token service for vendor captchas — when configured.
  if (config.captcha.provider === "2captcha" && config.captcha.apiKey) {
    registry.register(new TokenServiceStrategy(new TwoCaptchaService(config.captcha.apiKey)));
  }

  // Catch-all stand-in — only in explicit mock mode.
  if (config.captcha.provider === "mock") registry.register(new MockStrategy());

  return registry;
}
