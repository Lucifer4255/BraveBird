# Build Plan — Bravebird Browser Automation Worker

## Context

This is a take-home assignment: build a **resilient browser-automation worker** (TypeScript ·
Node · Playwright) that demonstrates explicit, working solutions for six hurdles — auth + session
persistence, deep navigation + dynamic forms, stealth/fingerprinting + proxy layer, self-healing
locators, async orchestration, and robustness + telemetry. It does **not** need to be production-
polished, but every hurdle needs real, runnable code and a README explaining the tradeoffs.

The design already exists in [ARCHITECTURE.md](ARCHITECTURE.md) (stack already converted to TS).
This plan turns that design into an ordered set of small, individually-verifiable steps. The repo
is currently greenfield — only `ARCHITECTURE.md` and the assignment PDF exist.

**Locked decisions (from this session):**
- **Stack:** TypeScript · Node · Playwright (plain `playwright` library, not `@playwright/test`).
- **Target:** Booking.com (real, bot-protected). *SauceDemo fallback dropped per the scale pivot.*
- **Orchestration:** **Inngest-native** (flow control = pacing). *BullMQ dropped.* Tiny local
  direct-runner kept for zero-infra runs.
- **Anti-bot/CAPTCHA (`src/evasion/`):** built as much as possible — durable identities + real
  fingerprints (done), proxy pool (M5), block classifier + CAPTCHA solver (M6), detect-and-react.
- **AI Tier-4 locator resolver:** a11y-tree → LLM → selector, cached, **gated off by default**.
  Routed via **OpenRouter** (`@openrouter/sdk`), model `google/gemini-2.5-flash-lite`.

**Design principle (keep visible in code + README):** *AI decides, deterministic executes.* Three
deterministic locator tiers first; LLM only as a gated last resort that heals once, then caches.

---

## Target file layout (from ARCHITECTURE.md §4)

```
bravebird-automation/
├── src/
│   ├── core/      browserManager · stealth · locators · retry · telemetry
│   ├── queue/     base (interface) · memoryQueue · bullQueue
│   ├── worker/    worker (site-agnostic loop)
│   ├── workflows/ base (interface) · booking · saucedemo
│   ├── config.ts  proxies, creds (env), UA pool, feature flags
│   └── main.ts    enqueue jobs, start workers
├── package.json · tsconfig.json · .env.example · docker-compose.yml · README.md
```

---

## Milestones & Todos

Each milestone is independently verifiable. Order follows ARCHITECTURE.md §8, broken finer.

### M0 — Project scaffold ✅ DONE
- [x] `package.json` (deps: `playwright`, `bullmq`, `ioredis`, `openai` (for OpenRouter), `dotenv`,
      `zod`; dev: `typescript`, `tsx`, `@types/node`). Scripts: `dev`, `build`, `start`.
- [x] `tsconfig.json` (NodeNext modules, strict, `src/` → `dist/`).
- [x] `npx playwright install chromium`.
- [x] `.env.example` (creds, proxy, `QUEUE_DRIVER`, `AI_LOCATOR_ENABLED=false`, `OPENROUTER_API_KEY`).
- [x] `src/config.ts` — typed config loader (zod-validated) reading env: creds, proxy URL, UA pool,
      feature flags. Single source of truth; nothing else reads `process.env` directly.

### M1 — BrowserManager + Stealth (ARCH §8.1) ✅ DONE
- [x] `core/browserManager.ts` — launch **one** Chromium; `acquireContext()` returns a fresh
      isolated context; `releaseContext()`/`stop()` guarantee teardown; `openContextCount` proves
      no leaks. Contexts always closed in `finally` (no leaks across runs).
- [x] `core/stealth.ts` — applied to a context **before** navigation: UA pool, locale, viewport,
      timezone; init script (as a STRING — avoids esbuild `__name` corruption) patches
      `navigator.webdriver`, plugins, languages, window.chrome, WebGL vendor, permissions. Plus the
      **proxy abstraction** (`buildProxy` parses `PROXY_URL`; direct by default) and
      `STEALTH_LAUNCH_ARGS` (`--disable-blink-features=AutomationControlled`).
- [x] **Verify:** `npm run stealth:check` → bot.sannysoft core tests green; webdriver=false,
      plugins=5, languages=2, UA realistic; screenshot at `telemetry/stealth-check.png`; 0 contexts
      after teardown.
  - Note (honest ceiling): deeper headless fingerprints still flag orange under headless+no-GPU —
      documented as the stealth ceiling the proxy layer addresses.

### M2 — Self-healing locators (ARCH §8.2, §6) ✅ DONE
- [x] `core/locators.ts` — `resolve`/`resolveWithMeta(page, spec)` cascade: Tier 0 cache → Tier 1
      role/aria → Tier 2 text → Tier 3 css → Tier 4 AI (gated). First hit wins; reports winning tier.
- [x] Caching: a resolved Tier-4 selector is cached back to Tier 0 (heal once, then deterministic).
      In-memory `healedCache` keyed by `spec.id`.
- [x] `core/aiResolver.ts` (Tier 4) — `body.ariaSnapshot()` → OpenRouter via **`@openrouter/sdk`**
      (`client.chat.send`) → cleaned CSS selector; **off unless `AI_LOCATOR_ENABLED=true`**. Feeds
      the a11y tree, not raw HTML. Typecheck confirms API correctness; live call needs a key.
- [x] **Verify:** `npm run locators:check` — V1 resolves via ROLE; mutate id+class → brittle CSS
      hits 0 but cascade still resolves via ROLE (SURVIVED); css-only spec → CSS tier; all-miss +
      AI-off → clean throw; heal-cache 0 (no LLM ran).

### M3 — Workflow interface + Booking happy path (ARCH §8.3, §5) ✅ DONE
- [x] `workflows/base.ts` — `Workflow` ABC (Template Method): `open` → `isLoggedIn`/`login` →
      save `storageState` → `navigate` → `extract`, driven by `run(context, job)`. Plus `BotWallError`
      (first-class anti-bot failure) and the `Job` type. Knows the page, nothing about queueing.
- [x] `workflows/booking.ts` implementing the §5 beats (`find → wait → act → verify`):
  - [x] `open`: goto + bot-wall heuristic (`assertNoBotWall`) + defensive consent dismiss +
        persist `sessions/booking.json`. (Booking login is email-OTP → out of scope; `isLoggedIn`
        returns true so the search flow needs no auth. Clean login demo is SauceDemo/M4.)
  - [x] Destination autocomplete: fill → **wait for `autocomplete-result` options** (never sleep) →
        click option → verify value with a settle-poll. **Proven working** (`dest_id=4127` in URL).
  - [~] Date picker + occupancy stepper: **best-effort & non-fatal** — Booking serves variant /
        finicky DOM to suspected automation (calendar doesn't open headless in some variants), so
        these degrade gracefully and the search still completes. Documented limitation; the clean
        dependent-form flow is demonstrated deterministically in M4.
  - [x] Submit + extract: wait for `searchresults` URL, read `property-card` titles.
- [x] **Verify:** `npx tsx src/scripts/runBooking.ts` → 25 real Goa properties returned, 0 leaked
      contexts. Recon tool kept at `src/scripts/reconBooking.ts`.
- Learnings baked into code: init scripts must be STRINGS (esbuild `__name`); resolver must WAIT on
  dynamic pages (added `ResolveOptions.timeout`); locator cascade gained `label`/`placeholder` tiers.

> **Scale pivot (2026-06-25):** the founder asked to **build for scale** and make
> **bot-detection + CAPTCHA at scale** the headline, allowing complex parts to be *designed*
> not built. SauceDemo dropped; orchestration is **Inngest-native** (BullMQ dropped); the
> anti-bot/CAPTCHA layer is **built as much as possible** (live proxy/CAPTCHA verification needs
> paid accounts). See [[bravebird-scale-direction]]. The orchestration-agnostic lower layers
> (browser/stealth/locators/workflow) are unchanged — only the top layer swaps.

### M4 — Identity design: real fingerprints + health + session ✅ DONE
Upgraded from "rotate fingerprints" to "design durable identities" (per research:
[[bravebird-scale-direction]], ScrapingAnt/Apify).
- [x] `src/evasion/fingerprint.ts` — real fingerprints via **`fingerprint-generator` + `fingerprint-injector`**
      (coherent UA+screen+WebGL+fonts+hardware, real distribution), with a **quality gate**
      (`isPlausible`: modern Chrome, real desktop res, sane cores, OS-coherent UA, no in-app webviews)
      and **curated profiles fallback** (`profiles.ts`). `Fingerprint.createContext()` + `toJSON()`.
- [x] `src/evasion/identity.ts` — **durable `Identity`** (fingerprint + own session + health) and
      `IdentityPool`: sticky-per-key, **daily quota**, **graded health** (success/captcha/block) with
      **auto-retire** (≥maxBlocks or high captcha rate), **persistence** to `sessions/identities.json`
      (personas survive restarts).
- [x] `browserManager.ts` — drives contexts from rotated identities; loads each identity's own
      session; `recordSuccess/Captcha/Block`, `banIdentity`, `persistSession`, `healthyIdentityCount`.
- [x] `base.ts`/`booking.ts` — session ownership moved to the identity (workflow no longer manages it).
- [x] **Verify:** `identityCheck.ts` (rotation, stickiness, retire-after-2-blocks 3/4 healthy,
      persistence across reload, coherence), `fingerprintCheck.ts` (plausible generated fps + round-trip),
      stealth essentials pass, `runBooking.ts` still returns 25 real Goa hotels (no regression).
- Lesson: the generator's real-world data has a junk tail (Chrome 91, 800x600, 384 cores, in-app
  webviews, OS mismatches) → must filter to the plausible middle.

### M5 — Proxy pool + rotation + ban tracking ✅ DONE
- [x] `src/evasion/proxyPool.ts` — pool from `PROXY_URLS` (csv, optional `|COUNTRY|TZ` geo tags);
      `acquire(key, preferTimezone)` = sticky-per-identity + **geo-coherence**; `reportBlocked`
      (cooldown + retire after maxBlocks), `reportSuccess`, `healthyCount`. Empty pool → undefined → direct.
- [x] `config.ts`/`.env.example` — `PROXY_URLS`. `browserManager` pairs each identity with a
      geo-coherent proxy (sticky), reports block/captcha/success to BOTH identity and proxy health.
- [x] **Verify:** `proxyCheck.ts` — rotation, stickiness, geo-coherence, cooldown→retire,
      empty→direct, and **wiring proof** (bogus proxy → `ERR_PROXY_CONNECTION_FAILED`, i.e. the proxy
      is genuinely applied). No regression (stealth still passes direct). Live IP swap needs a paid
      residential proxy.

### M6 — Block classifier + CAPTCHA solver ✅ DONE
- [x] `src/evasion/classifier.ts` — `classify(page, response)` → `ok | challenge | captcha | blocked`
      from status (403/429), body markers ("Access Denied", "Just a moment…"), `server` header
      (DataDome), and locator-based CAPTCHA detection (reCAPTCHA/hCaptcha/Turnstile/DataDome) with
      sitekey extraction. (Locators, not `page.evaluate` — dodges the esbuild `__name` trap.)
- [x] `src/evasion/captcha/` — **Strategy + Factory** design: `CaptchaStrategy` interface
      (`canHandle`/`solve`), strategies `MathStrategy` (compute), `VisionGridStrategy` (image-grid via
      OpenRouter vision), `TokenServiceStrategy` (+ `TwoCaptchaService`, real createTask/poll),
      `MockStrategy` (catch-all); `CaptchaSolverRegistry` + `createCaptchaRegistry()` factory (assembles
      from config, cheapest-first). Solution shapes: `token`/`text`/`tiles`. New captcha type = new
      strategy + one `register()`. `CAPTCHA_PROVIDER`/`CAPTCHA_API_KEY`; default `none` (avoid > solve).
- [x] Wired into `booking.open()` — classify the landing response, throw `BotWallError` on
      blocked/captcha (first-class failure the worker reacts to).
- [x] **Verify:** `captchaCheck.ts` — classifier correct on all 7 cases (ok/4 captchas+sitekeys/
      blocked/challenge); mock solver returns a token; `createSolver()` → undefined when disabled.
      No regression (Booking still returns 25 hotels).

### M7 — Inngest-native orchestration ✅ DONE
- [x] `src/orchestration/` — `registry.ts` (site→Workflow), `jobRunner.ts` (`runJob` =
      acquire→run→record→persist→release; `runJobWithRetries` local loop), `inngest.ts` (client +
      `runAutomationJob` function: `concurrency`+`throttle` keyed per `event.data.site` = pacing,
      `retries: 3`; auto dev-mode), `serve.ts` (Node HTTP serve for the dev server).
- [x] **Detect-and-react:** `runJob` catches `BotWallError` → `recordBlock` burns identity + proxy →
      retry (Inngest's or the local loop's) acquires a FRESH persona+IP. (Identity retirement persists
      to disk, so it survives across distributed workers too.)
- [x] Zero-infra **direct runner** `src/main.ts` (`npm run dev`) — bounded-concurrency in-process pool.
      `npm run worker` serves Inngest; `npm run enqueue` sends events. BullMQ/ioredis deps removed.
- [x] **Verify:** `orchestrationCheck.ts` — bot wall → identity burned → retried fresh → success
      (healthy 3→2), function defined with flow control; `serve.ts` boots and `/api/inngest` → HTTP 200.

### M8 — Telemetry + README + scale design writeup
- [ ] `core/telemetry.ts` — on hard failure: `error.log` (exception + step + job id),
      `screenshot.png`, `page.html`, Playwright **trace**. Context still closed in `finally`.
- [ ] README + **the headline doc: "Bot detection & CAPTCHA at scale"** — architecture, the
      pacing/proxy/fingerprint/CAPTCHA/detect-and-react design, what's built vs what needs paid
      accounts, and tradeoffs (avoid > solve; stealth's JS-vs-TLS ceiling; cost per solve).
- [ ] Init git, push to GitHub.

---

## Verification (end-to-end)

1. **Stealth proof:** `npm run stealth:check` → sannysoft core tests green; screenshot in telemetry.
2. **Self-healing proof:** `npm run locators:check` — mutate markup, watch tier fallthrough.
3. **Identity rotation:** `identityCheck.ts` — rotation/stickiness/ban + coherent fingerprint.
4. **Real-site flow:** `runBooking.ts` → real Goa properties; sticky identity + session persisted.
5. **Scale orchestration:** Inngest dev server + N events → capped concurrency, isolated sessions,
   no leaked contexts; simulated block → identity/proxy rotation + retry.
6. **Failure path:** induce a hard failure → telemetry artifacts written; run continues.

---

## Notes / risks
- **Booking bot wall (DataDome-class) is flaky/variant** — first-class failure; the scale layer
  (residential proxies + fingerprint rotation + pacing + CAPTCHA solving) is the real answer.
- **Live proxy/CAPTCHA verification needs paid accounts** — built runnable-with-a-key + mockable;
  flagged clearly in the README.
- **Stealth has a ceiling** — JS patches beat static checks, not network fingerprints (TLS/JA3);
  residential proxies via the proxy pool are the next rung.
- **CAPTCHA philosophy: avoid > solve** — good identity + proxy + pacing prevents most challenges;
  solving services are the costly fallback.
