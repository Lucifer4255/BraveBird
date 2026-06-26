# Bravebird — Resilient Browser-Automation Worker (built for scale)

A browser-automation worker that logs into and drives a **real, bot-protected site
(Booking.com)**, survives selector churn and anti-bot defenses, and runs as a
**fleet of asynchronous workers**. The headline concern is the one the brief calls
out: **how bot detection and CAPTCHA are handled at scale.**

**Stack:** TypeScript · Node ≥20 · Playwright (Chromium) · Inngest (orchestration)
· OpenRouter (gated AI) · Apify fingerprint-suite.

> **Design principle:** *AI decides, deterministic executes; avoid > solve.* Cheap,
> deterministic, reversible paths first; expensive/non-deterministic ones (LLMs,
> CAPTCHA services, residential proxies) only as gated last resorts.

---

## Quick start

```bash
npm install
npx playwright install chromium
cp .env.example .env            # all features run with the defaults (zero accounts)

# 1) Zero-infra: in-process worker pool (bounded concurrency + local retry)
npm run dev

# 2) Scale mode: Inngest orchestration (3 terminals)
npm run worker                                   # serves functions on :3939
npx inngest-cli@latest dev -u http://localhost:3939/api/inngest   # dev UI on :8288
npm run enqueue                                  # send sample jobs → watch in the UI

# A single Booking job, end-to-end:
npm run booking
```

Everything runs with **no paid accounts**. Optional integrations (OpenRouter,
residential proxies, 2Captcha) activate only when you set their env vars.

---

## The brief, point by point

| Hurdle in the assignment | How it's solved | Where |
|---|---|---|
| Auth + **session persistence** | Per-identity `storageState` persisted to disk; reused on next run | `evasion/identity.ts`, `core/browserManager.ts` |
| **Deep nav + dynamic forms** | Booking destination autocomplete (lazy XHR dropdown), dependent date picker, occupancy stepper | `workflows/booking.ts` |
| **Stealth / fingerprinting** | `navigator.webdriver`/WebGL/etc. patches + real coherent fingerprints injected at every layer | `core/stealth.ts`, `evasion/fingerprint.ts` |
| **Proxy abstraction** | Pool of proxies, sticky-per-identity, geo-coherent, ban/cooldown | `evasion/proxyPool.ts` |
| **Self-healing locators** | role → label → placeholder → text → css → (gated) AI, heal-once-then-cache | `core/locators.ts`, `core/aiResolver.ts` |
| **Async orchestration** | Inngest functions + flow control; zero-infra in-process pool too | `orchestration/` |
| **Browser reuse + isolation** | 1 Chromium, N isolated contexts, guaranteed teardown (no leaks) | `core/browserManager.ts` |
| **Retry on transient failure** | Inngest native retries + a local retry loop; detect-and-react rotation | `orchestration/jobRunner.ts` |
| **Telemetry on hard failure** | `error.log` + `screenshot.png` + `page.html` + Playwright **trace** | `core/telemetry.ts` |

---

## Architecture

Three layers, cleanly separated. The orchestration layer knows nothing about any
website; a workflow knows nothing about queueing; the evasion layer knows nothing
about either. **Adding a site = one file in `workflows/`.**

```
            ┌──────────────── orchestration/ (Inngest) ────────────────┐
  job event │  flow control (concurrency/throttle per site = pacing)   │
  ─────────▶│  retries → detect-and-react: block → burn id+proxy → fresh│
            └───────────────────────────┬──────────────────────────────┘
                                         │ runJob(job)
            ┌────────────────────────────▼─────────────────────────────┐
  workflows/│  Workflow.run(): open → (login) → navigate → extract      │
            │  Booking.com — find → wait → act → verify, every step     │
            └───┬──────────────┬──────────────┬───────────────┬─────────┘
         uses   │              │              │               │
            core/locators  core/stealth   evasion/*        core/telemetry
         (self-heal)     (per-context)  (identity, proxy,  (on failure:
                                         classifier,        log+shot+html
                                         captcha)           +trace)
            ┌────────────────────────────────────────────────────────┐
  core/     │  BrowserManager: 1 browser · N isolated contexts ·      │
            │  each driven by a rotated identity (+proxy) · cleanup   │
            └────────────────────────────────────────────────────────┘
```

---

## Bot detection & CAPTCHA at scale (the headline)

A single stealthed browser fools static checks. **At scale you get caught by
patterns**, and three signals give a bot farm away — each has an owner here:

**1. Identical fingerprints → coherent identity rotation** (`evasion/identity.ts`, `fingerprint.ts`)
Real, statistically-distributed fingerprints (Apify `fingerprint-generator` +
`fingerprint-injector`) — UA + screen + WebGL + fonts + hardware that actually
co-occur, **quality-gated** to the plausible middle (no Chrome 91, 800×600, or
384-core junk from the dataset's tail). Identities are **durable personas**:
sticky-per-session, a **daily quota**, **health-graded** (success/captcha/block),
**auto-retired** when burned, and **persisted to disk** so they accumulate history.

**2. One IP → proxy pool** (`evasion/proxyPool.ts`)
Rotating proxies, **sticky-per-identity**, **geo-coherent** (a US-timezone persona
uses a US IP), with **cooldown + retire** on blocks. Empty pool → runs direct.

**3. Bursts → pacing** (`orchestration/inngest.ts`)
Inngest `concurrency` + `throttle` keyed **per site**, so 1k workers never burst a
single target.

**When you still get caught → detect-and-react** (`evasion/classifier.ts`, `jobRunner.ts`)
A classifier reads each response → `ok | challenge | captcha | blocked`. A block
**burns the identity + proxy** and the retry runs on a **fresh persona + IP**.

**CAPTCHA — avoid > solve** (`evasion/captcha/`)
Most challenges never appear given the above. For the rest, a **Strategy + Factory**
solver: `MathStrategy` (compute), `VisionGridStrategy` (image grids via an LLM),
`TokenServiceStrategy` (2Captcha for reCAPTCHA/hCaptcha/Turnstile), `MockStrategy`
(tests). New captcha type = one new strategy. Solving is the costly last resort, off
by default.

---

## Self-healing locators

An element has many identities; bet on the stable ones first. The cascade tries
`role → label → placeholder → text → css → (gated) AI`, first hit wins, and **waits**
on dynamic pages (most automation bugs live in *wait*). The AI tier (a11y-tree →
OpenRouter → selector) is **off by default**; when it fires it **heals once** and
caches a deterministic selector, so it never runs twice for the same element.

---

## Telemetry

Inngest's dashboard shows *orchestration* (what ran, retries, durations). This
captures what it can't — **the page at the moment of failure**: `error.log`,
`screenshot.png`, `page.html`, and a Playwright **`trace.zip`** under
`telemetry/failures/<job>/`. Replay a trace frame-by-frame:

```bash
npx playwright show-trace telemetry/failures/<job>/trace.zip
```

A `TelemetrySink` interface (console-JSON by default) is the seam where Sentry /
Datadog plug in for aggregation and alerting — no code changes to capture.

---

## Verify it (no accounts needed)

```bash
npm run stealth:check        # webdriver hidden; screenshot vs bot.sannysoft
npm run locators:check       # mutate markup → locator survives via a stabler tier
npm run identity:check       # rotation, stickiness, retire-on-block, persistence, coherence
npm run fingerprint:check    # real coherent fingerprints + quality gate + round-trip
npm run proxy:check          # rotation, geo-coherence, cooldown→retire + a real proxy is applied
npm run captcha:check        # classifier on 7 response types + strategy/factory resolution
npm run orchestration:check  # detect-and-react: block → burn identity → retry fresh → success
npm run telemetry:check      # hard failure → error.log + screenshot + html + trace captured
npm run ai:check             # (needs OPENROUTER_API_KEY) live Tier-4 resolve + cache
```

---

## Tradeoffs & honest limits

- **Stealth has a ceiling.** JS patches beat JS checks, not **network-layer**
  fingerprints (TLS/JA3, **IP reputation**). Booking (DataDome-class) scores the IP
  heavily — from one un-proxied IP, ~30% of runs get a degraded variant. The fix is
  **residential proxies + pacing**, which the architecture is built for; verifying it
  *live* needs a paid proxy account.
- **CAPTCHA: avoid > solve.** Solving the puzzle ≠ passing — modern systems
  (Turnstile, reCAPTCHA v3, DataDome) score behavior, not pictures. So we invest in
  *not being challenged*; the solver is a gated fallback.
- **Booking is the showcase, and it's flaky by design.** A sign-in modal that steals
  focus is handled (dismiss + retype); a genuinely degraded variant is treated as a
  soft block → identity rotation. Single-IP rapid runs are the worst case.
- **Right-sized infra.** Zero-infra in-process mode for review; Inngest for scale —
  same lower layers, swappable top.

### Built vs. needs an account to verify live
| Area | Built & verified | Needs a paid account |
|---|---|---|
| Stealth, fingerprint rotation, locators, classifier, orchestration, telemetry | ✅ fully, offline | — |
| AI locator (Tier 4) / Vision CAPTCHA | ✅ code + typecheck | OpenRouter key (cheap) |
| Proxy pool logic + wiring | ✅ (bogus-proxy proves it's applied) | residential proxy for a real IP swap |
| CAPTCHA token solving | ✅ client + mock | 2Captcha credits |

---

## Project layout

```
src/
├── core/         browserManager · stealth · locators · aiResolver · telemetry
├── evasion/      identity · fingerprint · profiles · proxyPool · classifier · captcha/
├── workflows/    base (Workflow ABC) · booking
├── orchestration/ inngest · serve · jobRunner · registry
├── scripts/      runnable verifications + recon + live demo
├── config.ts     env (zod-validated), single source of truth
└── main.ts       zero-infra direct worker
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design narrative and the
component-by-component rationale.
