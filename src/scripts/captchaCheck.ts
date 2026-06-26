import { chromium } from "playwright";
import {
  CaptchaSolverRegistry,
  type CaptchaChallenge,
  createCaptchaRegistry,
  handleCaptcha,
  MathStrategy,
  MockStrategy,
} from "../evasion/captcha/index.js";
import { classify, type Verdict } from "../evasion/classifier.js";

/** Verify M6 — block classifier + the Strategy/Factory captcha system. */
const CASES: Array<[string, string, Verdict]> = [
  ["ok", "<body><h1>Welcome to the site</h1></body>", "ok"],
  ["recaptcha", `<body><div class="g-recaptcha" data-sitekey="6Lc_demo"></div></body>`, "captcha"],
  ["hcaptcha", `<body><div class="h-captcha" data-sitekey="hc_demo"></div></body>`, "captcha"],
  ["turnstile", `<body><div class="cf-turnstile" data-sitekey="ts_demo"></div></body>`, "captcha"],
  ["datadome", `<body><iframe src="https://geo.captcha-delivery.com/captcha/?cid=x"></iframe></body>`, "captcha"],
  ["blocked", "<body>Access Denied. You have been blocked.</body>", "blocked"],
  ["challenge", "<body>Just a moment... checking your browser before you proceed.</body>", "challenge"],
];

async function main() {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();

  console.log("── classifier ──");
  let allPass = true;
  for (const [name, html, want] of CASES) {
    await page.setContent(html);
    const c = await classify(page);
    const ok = c.verdict === want;
    allPass &&= ok;
    const extra = c.captcha ? ` (${c.captcha.kind}${c.captcha.sitekey ? ` sitekey=${c.captcha.sitekey}` : ""})` : "";
    console.log(`  ${ok ? "✅" : "❌"} ${name.padEnd(10)} → ${c.verdict}${extra}`);
  }
  await browser.close();

  console.log("\n── strategy + factory ──");
  console.log(`  createCaptchaRegistry() registered: [${createCaptchaRegistry().names.join(", ")}]`);

  // Controlled registry for deterministic assertions: math first, mock catch-all.
  const reg = new CaptchaSolverRegistry().register(new MathStrategy()).register(new MockStrategy());

  const math: CaptchaChallenge = { type: "math", url: "https://x", prompt: "What is 7 + 5?" };
  const grid: CaptchaChallenge = { type: "image-grid", url: "https://x", prompt: "select all buses" };
  const token: CaptchaChallenge = { type: "token", url: "https://x", provider: "turnstile", sitekey: "k" };

  console.log(`  math   → resolved by '${reg.resolve(math)?.name}'  →  ${JSON.stringify(await reg.solve(math))}`);
  console.log(`  grid   → resolved by '${reg.resolve(grid)?.name}'  →  ${JSON.stringify(await reg.solve(grid))}`);
  console.log(`  token  → resolved by '${reg.resolve(token)?.name}'  →  ${JSON.stringify(await reg.solve(token))}`);

  const mathOk = (await reg.solve(math)).kind === "text" && reg.resolve(math)?.name === "math";
  const gridOk = reg.resolve(grid)?.name === "mock"; // math can't, mock catches

  console.log("\n── no-strategy case (empty registry throws) ──");
  let threw = false;
  try {
    await new CaptchaSolverRegistry().solve(math);
  } catch {
    threw = true;
  }
  console.log(`  empty registry → throws: ${threw ? "✅" : "❌"}`);

  console.log("\n── live wiring: detected captcha → handleCaptcha → strategy ──");
  const wireBrowser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const wirePage = await wireBrowser.newPage();
  await wirePage.setContent(
    `<body><div class="g-recaptcha" data-sitekey="6Lc_demo"></div><textarea id="g-recaptcha-response"></textarea></body>`,
  );
  const detected = await classify(wirePage);
  const solverReg = new CaptchaSolverRegistry().register(new MockStrategy());
  const solved = await handleCaptcha(wirePage, detected.captcha!, solverReg); // mock solves + injects
  const injectedToken = await wirePage.locator("#g-recaptcha-response").inputValue().catch(() => "");
  const rotateReg = new CaptchaSolverRegistry(); // nothing configured → can't solve
  const rotates = (await handleCaptcha(wirePage, detected.captcha!, rotateReg)) === false;
  await wireBrowser.close();
  console.log(`  configured → solved + token injected: ${solved && injectedToken.startsWith("mock-") ? "✅" : "❌"}`);
  console.log(`  none configured → returns false (rotate): ${rotates ? "✅" : "❌"}`);

  const pass = allPass && mathOk && gridOk && threw && solved && rotates && injectedToken.startsWith("mock-");
  console.log(`\nRESULT: ${pass ? "✅ classifier + strategy/factory + live wiring verified" : "❌ failed"}`);
  if (!pass) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
