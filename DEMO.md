# Demo & Walkthrough — 5 worker jobs via Inngest

A guided script for recording a demo: **5 "find the best hotel" jobs** run through the
Inngest worker fleet, with a narration that maps each on-screen moment to the code.

> The jobs **fetch & compare prices** for a good-rated, under-budget hotel (3-night stays,
> per-city criteria) — they do **not** book.

---

## 0. Setup (3 terminals + a browser tab)

```bash
# Terminal 1 — the worker (serves the Inngest function; one Chromium, N contexts)
npm run worker

# Terminal 2 — the Inngest dev server (orchestrator + UI)
npx inngest-cli@latest dev -u http://localhost:3939/api/inngest

# Terminal 3 — send the 5 jobs
npm run enqueue
```

Open **http://localhost:8288** (the Inngest UI). Optional: set `WORKER_CONCURRENCY=2` so the
**per-site throttle** is visible (jobs run in batches, not all at once).

---

## 1. What's on screen

- **Terminal 3** prints the 5 enqueued jobs (Goa, Mumbai, Jaipur, Manali, Udaipur — each with
  adults / budget / rating).
- **Inngest UI → Runs**: 5 runs of `run-automation-job`, some *Running*, some *Queued* (throttle),
  finishing with a **best hotel** result each.
- **Terminal 1** (worker) prints, per job: `· [booking:goa] identity <id> (Windows · Chrome 145 · …)`
  then `✅ best hotel …`.

---

## 2. Narration — follow the flow (file · function)

Walk through it in execution order; each beat is one place in the code.

### A job arrives → orchestration
- **`src/orchestration/inngest.ts` · `runAutomationJob`** — the Inngest function. Point out the
  **flow control**: `concurrency` + `throttle` keyed `event.data.site`. *"All 5 jobs are `booking`,
  so they share one pace — the fleet never bursts a single target. This is the pacing that keeps us
  off the radar at scale."* `retries: 3`.
- **`src/orchestration/jobRunner.ts` · `runJob`** — the seam everything flows through:
  `acquire → run → record → persist → release`. The console line `identity <id> (<fingerprint>)`
  prints here. *"Notice each job gets a different OS/browser — that's identity rotation."*

### Acquire a disguised browser → core + evasion
- **`src/core/browserManager.ts` · `acquireContext`** — *"One Chromium, a fresh isolated context per
  job."* It pulls a rotated identity and pairs it with a (geo-coherent) proxy, and **starts a trace**.
- **`src/evasion/identity.ts` · `IdentityPool.acquire`** — a **durable persona**: sticky-per-job,
  daily quota, health-graded, retired when burned, persisted to disk.
- **`src/evasion/fingerprint.ts`** — the persona's **coherent** fingerprint (UA + screen + WebGL +
  fonts + hardware that actually co-occur), quality-gated. *"A Windows UA never gets a Mac platform —
  incoherence is a worse tell than no disguise."*
- **`src/evasion/proxyPool.ts`** — if `PROXY_URLS` is set, a geo-matched IP; empty → direct.
- **`src/core/stealth.ts`** — the `navigator.webdriver` / WebGL patches injected before page JS.

### Run the workflow → workflows
- **`src/workflows/base.ts` · `Workflow.run`** — the fixed skeleton: `open → (login) → navigate → extract`.
- **`booking.ts · open`** — lands on Booking, then **`classifier.ts · classify`** reads the response
  (`ok / challenge / captcha / blocked`). A block throws `BotWallError`. *"We notice the wall — you
  can't react to what you don't detect."*
- **`booking.ts · fillDestination`** — the **dynamic form**: type with real keystrokes → wait for the
  lazy autocomplete dropdown → click the match. Uses **`core/locators.ts · resolve`** (self-healing:
  role → label → placeholder → text → css → gated AI). Also `dismissModals` — *"the sign-in modal
  steals focus mid-type; we close it and retype."*
- **`booking.ts · reconcileResultsUrl`** — *"Booking's own UI just builds a results URL, so we set the
  exact dates / 3 adults / INR via search params — deterministic, instead of fighting the flaky
  calendar."* (Show the `dest_id` guard: trust it only if it resolved to our city, else the datacenter
  IP defaults it.)
- **`booking.ts · extract`** — *our business logic*: parse each card's **name + rating + price**,
  **filter** (rating ≥ 8, total ≤ budget), **rank** (rating desc, price asc), return the **best** + runners-up.

### Outcome → detect-and-react + telemetry
- **`jobRunner.ts`** — success → `recordSuccess` + `persistSession`. A `BotWallError` → `recordBlock`
  **burns the identity + proxy**, and Inngest's retry runs the job on a **fresh persona + IP**
  (show this in the UI if a run retries).
- **`core/telemetry.ts · captureFailure`** — on a hard failure: `error.log` + `screenshot.png` +
  `page.html` + a Playwright **trace.zip**. *(See §3.)*

---

## 3. Money shots to show

- **Inngest UI → a run → Trace tab**: the attempt timeline; if one retried, the rotation is visible.
- **A telemetry trace replay** (force/await a failure, then):
  ```bash
  npx playwright show-trace telemetry/failures/<job>/trace.zip
  ```
  *"This is the page at the moment it broke — frame by frame. It's how we found the modal bug."*
- **The result**: e.g. `Goa → Perfectstayz Premium Carnival Suites Near Candolim — 9.9/10 · ₹13,804`.

---

## 4. One-liners (the "why")

- *Avoid > solve* — good identity + proxy + pacing means we rarely see a CAPTCHA.
- *Heal once, then deterministic* — the AI locator runs at most once per element, then caches.
- *Detect-and-react* — a block isn't a crash; it's a signal to rotate and retry fresh.
- *Honest ceiling* — JS stealth beats JS checks, not IP reputation; residential proxies are the next rung.

---

## Zero-infra alternative (no dev server)

```bash
npm run dev          # same 5 jobs, in-process bounded-concurrency pool
```

Same lower layers; only the orchestration on top changes — that's the seam.
