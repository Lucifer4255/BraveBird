import { OpenRouter } from "@openrouter/sdk";
import { config } from "../../../config.js";
import type { CaptchaChallenge, CaptchaSolution, CaptchaStrategy } from "../types.js";

/**
 * Solves image-grid captchas ("select all buses") with a multimodal LLM via
 * OpenRouter — the free-ish, no-paid-account option. IMAGE PUZZLES ONLY: it
 * cannot help with behavioral/invisible captchas (Turnstile/DataDome/reCAPTCHA v3),
 * where the gate is the risk score, not a picture. Solving the puzzle ≠ passing.
 *
 * Needs the challenge image (imageBase64) + instruction (prompt). Extracting
 * those from a cross-origin captcha iframe is the integration layer; this is the
 * solving core.
 */
export class VisionGridStrategy implements CaptchaStrategy {
  readonly name = "vision-grid";
  private client?: OpenRouter;

  canHandle(c: CaptchaChallenge): boolean {
    return c.type === "image-grid" && !!c.imageBase64 && !!config.ai.apiKey;
  }

  async solve(c: CaptchaChallenge): Promise<CaptchaSolution> {
    if (!config.ai.apiKey) throw new Error("vision-grid needs OPENROUTER_API_KEY");
    this.client ??= new OpenRouter({ apiKey: config.ai.apiKey });

    const res = await this.client.chat.send({
      chatRequest: {
        model: config.ai.model,
        messages: [
          {
            role: "system",
            content:
              "You solve image-grid captchas. The image is an NxN grid numbered " +
              "0..N*N-1, left-to-right, top-to-bottom. Reply with ONLY a JSON array " +
              "of the tile indices matching the instruction, e.g. [0,3,7].",
          },
          {
            role: "user",
            content: [
              { type: "text", text: c.prompt ?? "Select the matching tiles." },
              { type: "image_url", imageUrl: { url: `data:image/png;base64,${c.imageBase64}` } },
            ],
          },
        ],
      },
    });

    const raw = res.choices?.[0]?.message?.content;
    const text = typeof raw === "string" ? raw : "";
    const match = text.match(/\[[\d,\s]*\]/);
    const indices: number[] = match ? JSON.parse(match[0]) : [];
    return { kind: "tiles", indices };
  }
}
