import type {
  CaptchaChallenge,
  CaptchaProvider,
  CaptchaSolution,
  CaptchaStrategy,
} from "../types.js";

/**
 * A token-returning external solving service (the expensive last resort for
 * vendor captchas that can't be avoided). Abstracted so 2Captcha / CapSolver /
 * etc. are interchangeable.
 */
export interface TokenService {
  readonly name: string;
  getToken(provider: CaptchaProvider, url: string, sitekey: string): Promise<string>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TWOCAPTCHA_TASK: Record<CaptchaProvider, string | null> = {
  recaptcha: "RecaptchaV2TaskProxyless",
  hcaptcha: "HCaptchaTaskProxyless",
  turnstile: "TurnstileTaskProxyless",
  datadome: null, // needs extra params (captcha_url) — out of scope
};

/** Real 2Captcha client (createTask → poll). Needs an account + credits. */
export class TwoCaptchaService implements TokenService {
  readonly name = "2captcha";
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.2captcha.com",
  ) {}

  async getToken(provider: CaptchaProvider, url: string, sitekey: string): Promise<string> {
    const type = TWOCAPTCHA_TASK[provider];
    if (!type) throw new Error(`2captcha: unsupported provider "${provider}"`);

    const created = await this.post("/createTask", {
      clientKey: this.apiKey,
      task: { type, websiteURL: url, websiteKey: sitekey },
    });
    if (created.errorId) throw new Error(`2captcha createTask: ${created.errorDescription}`);

    for (let i = 0; i < 24; i++) {
      await sleep(5000);
      const res = await this.post("/getTaskResult", { clientKey: this.apiKey, taskId: created.taskId });
      if (res.errorId) throw new Error(`2captcha getTaskResult: ${res.errorDescription}`);
      if (res.status === "ready") return res.solution.token ?? res.solution.gRecaptchaResponse;
    }
    throw new Error("2captcha: timed out waiting for a solution");
  }

  private async post(path: string, body: unknown): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  }
}

/** Strategy that delegates vendor captchas to a token service. */
export class TokenServiceStrategy implements CaptchaStrategy {
  readonly name: string;
  constructor(private readonly service: TokenService) {
    this.name = `token:${service.name}`;
  }

  canHandle(c: CaptchaChallenge): boolean {
    // Services return a token for vendor captchas (incl. their image grids).
    return (c.type === "token" || c.type === "image-grid") && !!c.provider && !!c.sitekey;
  }

  async solve(c: CaptchaChallenge): Promise<CaptchaSolution> {
    if (!c.provider || !c.sitekey) throw new Error("token service needs provider + sitekey");
    return { kind: "token", token: await this.service.getToken(c.provider, c.url, c.sitekey) };
  }
}
