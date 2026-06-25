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
- **Target:** Booking.com is the showcase; **SauceDemo** is a fallback wired into the *same*
  `Workflow` interface, so the engine is provable even when the bot wall is up.
- **Queue:** dual driver behind a `Queue` interface — in-process default (zero infra), BullMQ
  adapter via `QUEUE_DRIVER=redis`.
- **AI Tier-4 locator resolver:** fully implemented (a11y-tree → LLM → selector, cached),
  **gated off by default** behind a config flag. Routed via **OpenRouter** (OpenAI-compatible,
  `openai` SDK), cheap default model `google/gemini-2.0-flash-001`.

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

### M1 — BrowserManager + Stealth (ARCH §8.1)
- [ ] `core/browserManager.ts` — launch **one** Chromium; `acquireContext()` returns a fresh
      isolated context; `release()`/`closeAll()` guarantee teardown. Contexts always closed in
      `finally` (no leaks across runs).
- [ ] `core/stealth.ts` — applied to a context **before** navigation: UA, locale, viewport,
      timezone; `addInitScript` patches `navigator.webdriver → undefined`, plugins, WebGL vendor.
      Plus the **proxy abstraction**: takes a proxy config, passes through to context launch options
      (direct by default).
- [ ] **Verify:** launch a stealthed context, hit a `navigator.webdriver` detector page
      (e.g. bot.sannysoft / arh.antoinevastel) → screenshot shows webdriver hidden, realistic UA.

### M2 — Self-healing locators (ARCH §8.2, §6)
- [ ] `core/locators.ts` — `resolve(page, spec)` cascade: Tier 1 role/aria → Tier 2 text/label →
      Tier 3 css/xpath → Tier 4 AI (gated). First hit wins; returns a Playwright `Locator`.
- [ ] Caching: a resolved Tier-4 selector is cached back to the deterministic tiers (heal once,
      then deterministic). In-memory cache keyed by logical element id.
- [ ] `core/aiResolver.ts` (Tier 4) — `ariaSnapshot()` → OpenRouter via `openai` SDK (structured
      output) → candidate selector; **off unless `AI_LOCATOR_ENABLED=true`**. Feed a11y tree, not
      raw HTML.
- [ ] **Verify:** unit-style harness on a local HTML fixture — Tier 1 hits; mutate class names →
      falls through to text/css; flip the flag → Tier 4 resolves and the result is cached.

### M3 — Workflow interface + Booking happy path (ARCH §8.3, §5)
- [ ] `workflows/base.ts` — `Workflow` interface: `login(ctx)` → `navigate(ctx)` →
      `extract(ctx)`, plus a `run(ctx)` driver. Knows the page, nothing about queueing.
- [ ] `workflows/booking.ts` implementing the §5 beats (`find → wait → act → verify` each):
  - [ ] Session check: load `storageState.json` if present, verify account menu; else login,
        follow post-login redirect, snapshot `storageState` for next run.
  - [ ] Navigate + **dismiss consent banner**; detect bot wall → fail path.
  - [ ] Destination autocomplete: type → **wait for listbox options** (never `sleep`) → click →
        verify input text.
  - [ ] Date picker: check-in then check-out (dependent field) → verify both.
  - [ ] Occupancy stepper: increment adults → verify count.
  - [ ] Submit + extract: prefer reading the results XHR JSON over scraping DOM cards.
- [ ] **Verify:** run a single Booking job end-to-end; on a clean run it returns structured results;
      session reused on the 2nd run (login skipped).

### M4 — SauceDemo fallback workflow
- [ ] `workflows/saucedemo.ts` — same `Workflow` interface: login (`standard_user`), persist
      session, navigate inventory, "fill a form"/filter + extract items. Always runnable, no bot wall.
- [ ] **Verify:** SauceDemo job runs green with zero external dependencies — the guaranteed-pass
      demo path for a grader.

### M5 — Queue + Worker (ARCH §8.4, §3)
- [ ] `queue/base.ts` — `Queue` interface (`enqueue`, `process(handler)`), job type.
- [ ] `queue/memoryQueue.ts` — in-process async queue (default driver).
- [ ] `queue/bullQueue.ts` — BullMQ adapter (`QUEUE_DRIVER=redis`); same interface, untouched
      workflow/worker code. `docker-compose.yml` for Redis.
- [ ] `worker/worker.ts` — **site-agnostic** async loop: dequeue job → `browserManager.acquireContext`
      → look up workflow by `job.site` → `workflow.run(ctx)` → close ctx in `finally` → next job.
      Supports N concurrent workers (capped — contexts cost ~50–100MB).
- [ ] `main.ts` — build config, pick queue driver, enqueue sample jobs, start worker pool.
- [ ] **Verify:** `npm run dev` enqueues 2–3 jobs (booking + saucedemo), workers process them
      concurrently with isolated sessions; flip `QUEUE_DRIVER=redis` (+ `docker compose up`) → same
      run on BullMQ. No leaked browser/context after completion.

### M6 — Retry + Telemetry (ARCH §8.5, §5 failure path)
- [ ] `core/retry.ts` — async retry wrapper (configurable attempts + backoff) for transient
      network/render lag; calls a telemetry hook on final failure. (Note: BullMQ has native retries
      in distributed mode — app-level retry covers the in-proc path; documented tradeoff.)
- [ ] `core/telemetry.ts` — on hard failure capture, on the way out: `error.log` (exception + step
      + job id), `screenshot.png`, `page.html`, and a Playwright **trace**. Context still closed in
      `finally` — telemetry never leaks a browser.
- [ ] Wire retry around the §5 interaction beats; wire telemetry into the worker's failure path.
- [ ] **Verify:** force a failure (bad selector / simulate bot wall) → telemetry artifacts written
      to a per-job dir; worker survives and continues to the next job.

### M7 — README + tradeoff write-up (ARCH §8.6)
- [ ] README: setup/run (both drivers), architecture summary, and the **tradeoff section** the
      rubric grades — stealth's ceiling (JS patches vs TLS/JA3), deterministic-vs-AI locator
      reasoning ("LLM once, behind a flag, then cached"), in-proc-vs-BullMQ, one-browser-many-
      contexts, prefer XHR JSON over DOM scraping, anti-bot wall as first-class failure.
- [ ] Init git repo, push to GitHub for submission.

---

## Verification (end-to-end)

1. **Stealth proof:** stealthed context vs a webdriver-detection page → screenshot in telemetry dir.
2. **Self-healing proof:** locator harness on a fixture — mutate markup, watch tier fallthrough;
   flip AI flag, watch Tier-4 resolve + cache.
3. **Happy path:** `npm run dev` → SauceDemo job green (always); Booking job green when reachable;
   2nd Booking run skips login (session persisted).
4. **Async + isolation:** multiple jobs processed concurrently, sessions isolated, no leaked
   contexts (check process/handle count before/after).
5. **Queue swap:** `QUEUE_DRIVER=redis` + `docker compose up` → identical behavior on BullMQ.
6. **Failure path:** induce a hard failure → `error.log` + `screenshot.png` + `page.html` + trace
   written; worker continues.

---

## Notes / risks
- **Booking.com bot wall (DataDome/Akamai-class) is flaky** — treated as a first-class failure, not
  brute-forced. SauceDemo guarantees a runnable demo regardless (M4 is the safety net).
- **Booking login needs a real account** — credentials via `.env`; if none, the grader still runs
  the SauceDemo path. Document this clearly in the README.
- **Stealth has a ceiling** — JS patches beat static checks, not network fingerprints; proxy layer
  is the abstraction for going further (residential proxies), run direct by default.
