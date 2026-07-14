# ApplyPilot

A **local-first, single-user** job-application co-pilot. Each person runs their own copy with
their own profile, their own logins, and their own LLM key. There is no shared backend and no
central datastore — your data never leaves this machine except (later) the career site you
apply to and your LLM provider.

> **Build status: single-user refocus.** ApplyPilot is a **local-first, single-user** build; the old
> commercial/hosted layer (paid backend, Stripe, the metered "ApplyPilot Cloud" LLM proxy, the
> Vercel-hosted web copy, Firebase/Google cloud sync) has been **removed**. This repo implements
> **Module 1** (profile + setup wizard), **Module 2** (master-resume ingestion, the facts ledger, and
> the anti-fabrication verifier), **Module 5** (document generation: tailored resume + cover letter
> from the approved ledger, verifier-gated, rendered to ATS-friendly PDF + DOCX), the **Greenhouse /
> Lever / Ashby ATS apply adapters** (Playwright, headed by default) with the **review/submit gate**
> where the human clicks Submit (the app never submits), and **discovery** — score matches against the
> profile/ledger with US-only/clearance/sponsorship knockouts, list them in the dashboard, and prepare
> applications for your review. Hard dedup and CSV export are included.
>
> **Discovery draws from exactly two sources — no scraping:**
> 1. **Employer ATS JSON feeds** — the public, no-auth board APIs of employers you target:
>    **Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Workday**. You seed the employer list by hand in
>    `config/targets.json` (see "Job sources & crawl posture" below). Workable roles are surfaced for
>    manual apply (fill adapters remain Greenhouse/Lever/Ashby); Workday roles support an experimental
>    multi-step fill and are scanned via its public CXS search (a read-only POST — see below).
> 2. **Job-alert emails you export** — LinkedIn / Indeed alert emails you save to a local folder
>    (`.eml`/`.mbox`). No Gmail login, no OAuth, no IMAP, no stored tokens; only messages from known
>    LinkedIn/Indeed alert senders are read, and only the job metadata + links are kept (never the
>    email body).
>
> The same role seen via both an ATS feed and an alert email is collapsed into one record. The network
> layer (NetGuard) **hard-denies** linkedin.com / indeed.com / glassdoor.com — there is no browser
> scraping of job boards. `npm run discover` runs both sources in one read-only pass: it records apply
> URLs but **never applies or submits**.
>
> **Discovery is broad; form filling is narrow — and the app says so.** Every discovered job is
> classified by its **apply capability** (`src/jobs/apply-capability.ts`): only
> **Greenhouse / Lever / Ashby** postings support **automated prefill** ("Prefill application");
> everything else is **manual-only** ("Open manually" — the app opens the posting and prepares
> tailored documents, you fill and submit by hand) or **unsupported** (board/search pages, dead
> links — no action offered). Unsupported and manual-only jobs are refused by the apply pipeline
> and autopilot with a plain-language reason; they are never silently routed into the generic
> fallback.

## Non-negotiable guarantees (from the brief)

- **US roles only**, with review-first submission — you always click Submit on the employer's page.
- **Never fabricate.** Generated documents may reorder, reweight, and rephrase ONLY facts in
  the approved ledger. The automated **ledger verifier** (Module 2, built here) blocks anything
  it can't trace to an approved fact.
- **PII stays local.** The profile (including sensitive EEO / veteran / disability self-ID)
  lives only in the local, gitignored SQLite store, optionally **encrypted at rest**. It is
  never committed.
- **No CAPTCHA solving / no bot-detection evasion.** A detected human-verification challenge
  always pauses the run and hands you the live browser — the app never attempts to solve or
  bypass it.

## Job sources & crawl posture

Discovery draws from **exactly two sources**, and neither scrapes a job board:

1. **Employer ATS JSON feeds** — the public, no-auth board APIs of **Greenhouse, Lever, Ashby,
   SmartRecruiters, Workable, and Workday**. These are ordinary REST calls to a feed the employer publishes for its own
   careers page (self-identifying user agent); there is no HTML scraping. You choose which employers
   to scan by hand — see the `config/targets.json` setup under "Commands" below. Workday is the one
   exception to "GET only": its careers page fetches the job list with a **read-only search POST** (the
   CXS endpoint has no GET form), so NetGuard permits that single read-only POST to Workday hosts —
   PUT/PATCH/DELETE stay refused, the LinkedIn/Indeed denylist still wins, and an application is still
   never submitted through this HTTP client (that's Playwright + your Submit click).
2. **Job-alert emails you export** — LinkedIn / Indeed job-alert emails you save to a local folder as
   `.eml`/`.mbox` and point `APPLYPILOT_ALERT_MAIL_DIR` at. ApplyPilot reads only messages from known
   LinkedIn/Indeed alert senders (`src/email/`); anything else in the folder is ignored. Only the
   **job metadata + links** are kept — never the email body. There is **no Gmail login, no OAuth, no
   IMAP, and no stored tokens**; you do the exporting.

The same role that appears via both an ATS feed and an alert email is **de-duplicated into a single
record**.

**No scraping, and the boards are blocked at the network layer.** There is no aggregator/LinkedIn/
Indeed scraping engine. The network guard (NetGuard) **hard-denies** requests to `linkedin.com`,
`indeed.com`, and `glassdoor.com`; a LinkedIn/Indeed URL you paste is **open-in-your-browser only**,
never fetched or crawled by the app.

**Market search: USAJOBS on (opt-in), paid aggregators off.** The free, public **USAJOBS** federal
search is available and OFF until you add its no-cost key (`APPLYPILOT_USAJOBS_KEY` +
`APPLYPILOT_USAJOBS_EMAIL` from developer.usajobs.gov, or via Settings) — a public identifier, not a
private paid secret. Once set, discovery also queries USAJOBS by your target titles (federal
compliance/investigator/analyst roles). **Adzuna and Jooble stay off** — those require a private paid
API key, which the single-user refocus forbids. (The old `APPLYPILOT_SOURCE_POLICY` escape hatch is
retired.)

**Starter employer list.** `config/targets.aml-starter.json` is a ready-made set of AML/financial-
crime employers (Coinbase, Chime, Anchorage, Chainalysis, Ramp, …). Copy it to `config/targets.json`
to point discovery at boards that actually post AML/KYC/sanctions roles.

## Stack

TypeScript + Node (≥22), SQLite via `better-sqlite3`, Zod for validation, `unpdf` + `mammoth`
for resume text extraction, and the Anthropic API for the **optional** LLM paths. Playwright
drives the review-first form filling and a Vite/React dashboard (`dashboard/`) is the UI.

The Zod validators in `src/validation` are **derived from and compile-time pinned to** the
canonical TypeScript types in `src/types` (the brief's exact files) — a drift between a schema
and its type is a build error, so the shapes are never hand-written twice.

## Setup

```bash
npm install
cp .env.example .env     # then edit .env
```

### Exceptional matching, totally free (bundled local models)

ApplyPilot's résumé analysis and job matching run entirely on **free, bundled** models —
in-process via node-llama-cpp (Metal on macOS), no external installs, no daemon, no cloud, no
API keys. Fetch the model weights once:

```bash
npm run models:download  # qwen2.5-1.5b-instruct (chat, Apache-2.0) + nomic-embed-text-v1.5 (embeddings, Apache-2.0)
```

- **`qwen2.5-1.5b-instruct`** — résumé extraction, document generation, and the batched
  evidence-only job-fit reranker.
- **`nomic-embed-text-v1.5`** — semantic résumé↔job-description matching (cosine similarity), so
  conceptually similar roles match even without shared keywords.

Everything degrades gracefully: with no embedding model, matching falls back to lexical scoring;
with no chat model, the heuristic parser and deterministic scoring still run. Power users can
point `APPLYPILOT_LLM_PROVIDER=ollama` (or any OpenAI-compatible server) at their own models, and
Anthropic Claude remains available (paid, cloud) — neither is required.

How matching ranks a role (all local, all explainable):

1. **Knockouts** — US-only, clearance, sponsorship, work-mode, salary floor (hard disqualifiers).
2. **Lexical fit** — title/skill overlap, role families, requirement-weighted keyword relevance.
3. **Semantic fit** — embedding cosine between your résumé and the job description.
4. **Alignment** — graded seniority, domain, and years-of-experience vs. the posting.
5. **Freshness** — a small boost for recently posted roles.
6. **AI rerank** — one batched LLM pass calibrates the strongest candidates against each other (cached).

Inferred signals (years of experience, seniority, domains) live in a **separate insights layer** —
never mixed into the literal facts ledger, so generated documents still cannot fabricate.

`.env` keys (all local; the Anthropic key is OPTIONAL for Milestone 1):

| key | purpose |
| --- | --- |
| `APPLYPILOT_LLM_PROVIDER` | `embedded` (default — bundled in-process model), `ollama`, `openai-compatible`, or `anthropic`. |
| `APPLYPILOT_LLM_MODEL` | chat model for résumé extraction, generation, and job reranking (default: the bundled `qwen2.5-1.5b-instruct`). |
| `APPLYPILOT_EMBED_MODEL` | set (with `APPLYPILOT_EMBED_BASE_URL`) to use an external embedding endpoint instead of the bundled `nomic-embed-text-v1.5`. |
| `ANTHROPIC_API_KEY` | optional cloud (paid) LLM instead of the bundled model; the deterministic anti-fabrication gate runs **without** any LLM. |
| `APPLYPILOT_DB_PATH` | SQLite file (default `./data/applypilot.sqlite`, gitignored). |
| `APPLYPILOT_ENCRYPTION_KEY` | 32-byte hex/base64 key. If set, the profile + ledger are encrypted at rest (AES-256-GCM). Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. To encrypt data that was already written in plaintext, set the key then run `npm run encrypt-at-rest` (it backs up the DB and re-encrypts only plaintext rows). Keep the key safe — without it the encrypted data can't be read. The key lives in `.env` on this machine, so it protects a stolen DB file, not a fully compromised host. |

## Commands

```bash
# Module 1 — first-run profile wizard (re-run any time to edit).
# Explicitly asks the VOLUNTARY EEO/veteran/disability questions; "decline to answer"
# is always valid and is stored distinctly from "not answered yet".
npm run setup

# Module 2 — ingest a master resume: extract -> parse to candidate facts ->
# confirm role/location/comp defaults -> review/approve the facts ledger.
npm run ingest -- path/to/resume.pdf          # or .docx / .txt / .md
npm run ingest -- path/to/resume.pdf --llm    # use the LLM parser if a key is configured

# Module 2 — view the stored facts ledger and its approval state.
npm run ledger

# Module 2 — run the anti-fabrication verifier against a document. Exits non-zero on FAIL,
# so it can gate a generation pipeline. --allow whitelists legitimate non-ledger names
# (e.g. the target employer in a cover letter).
npm run verify-doc -- path/to/document.txt
npm run verify-doc -- path/to/cover-letter.txt --allow "Acme Corp"

# Module 5 — generate a tailored resume + cover letter from the APPROVED ledger, gated by the
# verifier, rendered to ATS-friendly PDF + DOCX in ./generated. Exits non-zero if any document
# is blocked as not submission-eligible. Add --llm to use the LLM generator (needs a key);
# otherwise a deterministic, always-truthful template generator is used.
npm run generate -- --posting path/to/posting.txt --company "Acme Corp" --title "Operations Analyst"
npm run generate -- --posting path/to/posting.txt --company "Acme Corp" --title "Operations Analyst" --llm

# Manage target companies/sources. Add by company homepage (resolved to its ATS board) or by
# pasting an ATS board/posting URL directly. A pasted LinkedIn/Indeed URL is manual-open-only —
# it is recognized but never scanned or fetched (see "Job sources & crawl posture").
npm run companies -- add "https://1password.com"                      # homepage -> Ashby board
npm run companies -- add "https://job-boards.greenhouse.io/<slug>"    # board URL directly
npm run companies -- list
npm run companies -- approve <id>

# Discovery — ONE command, BOTH sources. Seeds target employers from config/targets.json, scans
# those ATS boards (Greenhouse/Lever/Ashby/SmartRecruiters/Workable/Workday) plus the exported job-alert emails in
# APPLYPILOT_ALERT_MAIL_DIR, de-dupes across sources, scores vs your profile/ledger, and prints
# ranked matches with apply URLs. Read-only: it records apply URLs but NEVER applies or submits.
#
# First-time setup: copy the example targets file and fill in real employers. A board id must be
# OBSERVED from the employer's own careers page — never guessed.
cp config/targets.example.json config/targets.json
#   then edit config/targets.json: [{ "name": ..., "vendor": "greenhouse|lever|ashby|smartrecruiters", "boardId": ... }]
export APPLYPILOT_ALERT_MAIL_DIR=~/ApplyPilot/alert-mail   # optional: folder of exported .eml/.mbox alerts
npm run discover                                           # both sources, default target file + min-score
npm run discover -- --targets config/targets.json --min-score 0.3

# Module 4 + 6 — open a Greenhouse application page in a HEADED browser, fill it per the risk
# policy, and PAUSE at the review gate. ApplyPilot never submits in semi_auto; you review the
# filled form (and any flagged/needed fields), then click submit yourself. On a CAPTCHA/login
# wall it stops and hands you the browser. Attach generated docs with --resume / --cover.
npm run apply -- --url "https://job-boards.greenhouse.io/<company>/jobs/<id>" --company "Acme Corp" --title "Operations Analyst" --resume ./generated/acme-corp-operations-analyst-resume.pdf

# Quality gates
npm run typecheck
npm test
```

## Autopilot — batch fill-and-queue (CLI)

One pass over your enabled companies: take each company's ready, high-scoring discovered jobs and
run the apply pipeline per job (per-company caps + a total ceiling + human pacing). The product
flow is **review-first**: autopilot fills and queues; you review and click Submit on the
employer's page.

```bash
npm run autopilot                                   # SAFE default: fills everything, queues for your click
#   optional: --min-score 0.5  --max 10  --headless
```

Apply supports **Greenhouse**, **Lever**, **Ashby**, and a **generic fallback** for unrecognized
forms — all four verified end-to-end against local form fixtures (never a real site). They share the
same labeled-field engine; only detection differs. The generic fallback always **queues, never
submits** — an unknown form is never sent automatically. And since the apply-capability contract,
the fill pipeline only accepts URLs that classify as **form-fill-supported** (Greenhouse/Lever/Ashby
postings or local fixtures) — the generic fallback is a safety net for unexpected DOM on those
pages, **not** a universal filler for LinkedIn/Indeed/Workday/company sites, which are surfaced as
manual-only instead.

> **Legacy auto-mode flags are inert.** Continuous auto-submit was removed from the engine, not
> just the UI: `runApplication` refuses `--mode auto` outright (it records
> `application.auto_rejected` and returns `submitted: false`), and the submit click
> (`clickSubmit`) has no callers anywhere in the codebase. The `--mode auto` / `--live-submit`
> flags still *parse* in the legacy `autopilot`/`schedule` CLIs (with a typed-SUBMIT confirmation
> and a per-employer allowlist as historical belt-and-braces), but the engine underneath cannot
> submit no matter what is passed. The dead flags and gate code are slated for removal.

## Scheduler (CLI, review-first)

Run the fill-and-queue pass on a loop while you work — each pass prepares applications for your
one-click review; nothing is submitted by the app. (The scheduler shares the legacy
`--mode auto` / `--live-submit` flags described above — they parse but the engine refuses to
submit regardless.)

```bash
npm run schedule -- --every 60m                                  # fill + queue every hour
#   optional: --daily 30  --max 10  --max-per-company 3  --min-score 0.5  --jitter 25%  --headless
```

Guardrails: a **daily ceiling** (`--daily`, default 30 applications processed per rolling 24h), a
**per-company cap** and **per-pass cap**, and **jittered pacing** between passes. Hard dedup
independently guarantees a **submitted job is never sent twice**, even across restarts. Press
Ctrl-C to stop after the current pass.

## Accounts on career sites (compliant handling)

Many sites require an account before you can apply. ApplyPilot **never creates the account,
enters a password, or stores credentials** (hard constraint #5). Instead, when it detects a
registration/login wall it:

- pre-fills the **non-secret** fields (email, name, phone) — never a password field, never
  clicking create/submit,
- (for a new account) generates a strong password and copies it to your **clipboard** for you
  to paste and **save in your password manager** — the app never stores or types it,
- records **metadata only** in a local `accounts` table (domain, the email/username you use,
  "account exists", and a free-text label like `1Password`) — there is no password column,
- pauses and hands you the live browser to set the password and finish.

Control it on `apply`: `--account-mode prefill|handoff|off` and `--password-store "1Password"`.

**Log in once, then it's automatic.** ApplyPilot uses a persistent browser profile, so after you
log in once in the headed browser, the session **persists across runs** — no stored password.
On a later run, when the login wall is gone, the app records the session as live (`session.active`)
so auto mode can reuse it. See which sites are logged-in vs need a first login:

```bash
npm run accounts
```

Hard dedup means "never **submit** the same job twice" — a paused attempt (login required,
CAPTCHA, needs-review) can always be retried; only a submitted application is blocked.

## Dashboard (Sunrise UI)

The local web dashboard lives in `dashboard/` (Vite + React) and uses the **Sunrise** design
system (`dashboard/src/styles/shared.css`, copied verbatim from the design handoff in
`design-reference/`). It is the automation command center: Automated / One-click / Applied /
Rules, with the detail drawer and one-click review modal.

Run it as the private browser web app:

```bash
npm run web:build
npm run web:start              # serves dashboard + API at http://127.0.0.1:5179
```

The web app keeps the local-first architecture: SQLite, generated documents, Playwright automation,
and browser sessions stay on this machine. Generated résumé/cover-letter files download through
authenticated `/api/generated` links instead of exposing local filesystem paths.

To reach it from your own devices, use Tailscale and a bearer token:

```bash
APPLYPILOT_BIND_HOST=tailscale
APPLYPILOT_AUTH_TOKEN=<long-random-token>
npm run web:start
```

Open the printed `http://100.x.y.z:5179/` URL from another device. The dashboard prompts for the
token and stores it only in that browser. Application filling still opens/runs Playwright on the
host machine; mobile/tablet views remain monitor-first.

For frontend development, run it with the engine wired (two terminals):

```bash
# terminal 1 — the local API over your datastore (binds 127.0.0.1 only; PII stays local).
# Serves /api only in this mode; Vite serves the React app.
npm run dashboard:api          # http://127.0.0.1:5179

# terminal 2 — the dashboard (Vite dev proxies /api -> 127.0.0.1:5179)
cd dashboard && npm install && npm run dev     # http://localhost:5174
```

It shows your **real pipeline**: pilot/profile, the one-click queue (ready discovered jobs),
the Applied tracker (from the applications store), automation coverage (every company board
searched), fit scores, and the audit log. Metrics we don't track yet (reply rate, interviews)
render as honest zeros. If the API isn't running, the dashboard falls back to a labelled sample
so it's still demonstrable; if there's no profile yet, it shows a setup checklist.

To populate a representative local datastore for a quick look:

```bash
npm run seed:demo              # profile + ledger + companies + discovered jobs + applications
```

**Run automation** in the header triggers a real `POST /api/autopilot`, which runs **one semi-auto
pass**: it discovers, scores, and prepares the top **form-fill-supported** match, pausing at the
review gate — it **submits nothing**, and manual-only/unsupported matches are skipped with their
reason (they stay visible for a manual apply). That is hard-locked server-side (`mode = semi_auto`,
`liveSubmit = false`) — the dashboard can never auto-submit, no matter what the request says. Only
one pass runs at a time. The card under the hero shows your career-site logins (logged-in vs
needs-login — metadata only, never passwords) and what the last pass did. The legacy CLI
auto-mode flags are **inert** — the engine refuses to submit regardless (see "Legacy auto-mode
flags are inert" above).

### The review-first apply flow (dashboard)

Clicking **Prefill application** on a supported job opens the REAL employer page where you can see
it and fills it in front of you:

1. **Desktop app** — the page appears in an **embedded review panel inside the app** (an Electron
   view the engine drives over a local CDP endpoint). You watch the fill happen, then take over the
   same page: fix fields, log in, pass any human-verification step, and **click the employer's
   Submit button yourself**.
2. **Plain browser (dev mode)** — the engine opens a **visible headed browser window** instead;
   same rules.

The app **never clicks submit** — `/api/apply/submit` is gone (it returns `410`), and the review
rail's button is **"I submitted it"** (`POST /api/apply/mark-submitted`), which only records what
you already did on the employer's site. Manual-only jobs get **"Open manually"**: the posting opens
in your regular browser and tailored documents are generated for you to attach by hand. Set
`APPLYPILOT_DISABLE_EMBEDDED=1` before `npm run app` to turn the embedded panel off (the engine
then always uses a separate visible window).

## Desktop app (ApplyPilot.app)

ApplyPilot runs as a native macOS app — an Electron window that loads the dashboard, with the local
engine running behind it. (Setting up a brand-new Mac from scratch? See
[`SETUP-NEW-MAC.md`](./SETUP-NEW-MAC.md) — a Desktop launcher that clones, installs, and updates
from GitHub on its own.)

```bash
npm run app:install     # creates ~/Desktop/ApplyPilot.app (one time)
npm run app             # auto-pulls main when behind, installs/rebuilds when the code changed, opens the window
npm run app:build       # rebuild the dashboard after code changes (the app picks it up next launch)
```

**One-click "update from GitHub, then run"** — a second, explicit shortcut. Where **ApplyPilot**
self-updates passively (only when it notices it's behind on `main`), **Update ApplyPilot** always
pulls the latest release, rebuilds if anything changed, and launches — a deliberate "get me the
newest version and run it" button:

```bash
npm run app:install:update   # creates ~/Desktop/Update ApplyPilot.app (one time)
npm run app:update-launch    # what that shortcut runs: git pull main → install/rebuild if changed → launch
```

You end up with two Desktop icons: **ApplyPilot** (everyday launch) and **Update ApplyPilot**
(force-refresh from GitHub, then launch). Both are safe on a clean `main` checkout — the update is
fast-forward-only and is skipped (with the current copy launched anyway) if the folder has local
changes or is on another branch.

**After `git pull`** (get latest code + rebuild the dashboard):

```bash
npm run app:refresh     # stop stale engine, git pull, app:update, refresh Desktop shortcut
```

Or step by step:

```bash
npm run app:update      # npm install, dashboard deps, playwright, app:sync
npm run app:install     # refresh Desktop shortcut if the repo path changed
```

Double-click **ApplyPilot** on your Desktop to launch. (If macOS blocks the first launch:
right-click → Open, then Open once.)

**How it's wired (and why):** Electron is a thin shell. It spawns the existing Node engine
(`src/cli/dashboard-api.ts`) as a **child process** using your local Node, and the engine serves both
the API and the built dashboard at `http://127.0.0.1:5179` (one origin). This keeps `better-sqlite3`
and Playwright under regular Node — **no Electron native rebuild / ABI mismatch** — and Playwright
still drives its own Chromium for form-filling, separate from the app window. Each launch rebuilds the
dashboard, so your changes flow in automatically.

This is a **local, single-user** build that uses your machine's Node + installed Chromium; it is not
yet a portable/notarized installer (a self-contained signed `.app` via `electron-builder`, bundling
Node + Chromium, is a further step). Your data, `.env`, and `browser-profile/` never leave this
machine.

### Building a distributable (signed + notarized .dmg)

`npm run app:install` is the quickest way to run ApplyPilot locally. To produce a **self-contained,
signed, notarized** `.dmg` you can hand to another Mac, the electron-builder pipeline is wired:

```bash
npm run dist:dir    # unsigned, unpacked build into release/ (for testing the packaging)
npm run dist        # full build -> signed + (if creds set) notarized .dmg + .zip in release/
```

`dist` runs: build the dashboard → bundle the engine (`scripts/build-engine.mjs`: esbuild → one
file, no `tsx` needed at runtime) → electron-builder packages it with the hardened runtime +
entitlements, then the `afterSign` hook (`build/notarize.cjs`) submits it to Apple.

**What you must provide — I can't, it needs your Apple account:**
- A paid **Apple Developer Program** membership and a **Developer ID Application** certificate in your
  keychain (electron-builder signs with it automatically). *There are 0 signing identities on this
  machine, so a build done here can only be unsigned.*
- For the notarize step, set these before `npm run dist`:
  ```bash
  export APPLE_ID="you@example.com"
  export APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"   # from appleid.apple.com
  export APPLE_TEAM_ID="XXXXXXXXXX"
  ```
  Without them the notarize hook skips cleanly (you get a signed-but-not-notarized app).

**One portability caveat:** form-filling uses Playwright's Chromium. The packaged app uses the
Chromium in your Playwright cache; on a *clean* Mac, run `npx playwright install chromium` once (or
bundle the browser — a further step). Everything else is self-contained in the bundle.

## Mobile companion — reaching the engine over Tailscale

The engine binds to **`127.0.0.1` only by default** — nothing is reachable off the machine. To use a
phone as a monitor/control surface, expose the API **only to your private [Tailscale](https://tailscale.com)
network** (a WireGuard mesh of your own devices — no public exposure, no port-forwarding, not on the
LAN). This is the engine-side foundation; the Android app is a later milestone.

On the machine running the engine (e.g. a Mac mini), in `.env`:

```bash
APPLYPILOT_BIND_HOST=tailscale   # auto-detect this machine's 100.x tailnet IP (loopback kept too)
# APPLYPILOT_AUTH_TOKEN=...       # optional in v1; set to also require Authorization: Bearer <token>
```

Then `npm run dashboard:api` (or the desktop app) prints the bind it chose, e.g.
`… on http://127.0.0.1:5179 — tailscale [127.0.0.1, 100.115.92.7] — no token (Tailscale-gated)`.
A device on the same tailnet reaches it at `http://100.115.92.7:5179`.

**Access model / threat notes** (full version in [`src/server/access.ts`](src/server/access.ts)):
- **Tailscale is the access control in v1** — only your own enrolled devices can route to the engine;
  device identity is enforced by WireGuard keys. Transport is already encrypted, so v1 adds no TLS.
- **Token-ready auth seam.** v1 needs no token, but setting `APPLYPILOT_AUTH_TOKEN` immediately
  requires `Authorization: Bearer <token>` on every `/api/*` route — a drop-in pairing/bearer path
  with no code changes. Recommended once your tailnet has shared or other-user devices.
- **No blanket CORS.** Cross-origin browser calls are reflected only for localhost, tailnet (`100.x`),
  or an explicit `APPLYPILOT_ALLOWED_ORIGINS` allowlist. The API is JSON-only with **no cookie auth**,
  so it can't be ridden by CSRF.
- **Binding all interfaces (`0.0.0.0`) is refused** unless you set `APPLYPILOT_ALLOW_ALL_INTERFACES=1`
  (and you should then also set a token + TLS). The default stays loopback-only.
- **Submission safety is unchanged.** This layer only governs *reachability*. A phone-triggered apply
  still goes through the same gated, confirm-before-submit path — nothing is ever sent silently.

## How the anti-fabrication verifier works

1. **Deterministic gate (always, offline):** the document is decomposed into claims; every
   number, year, and proper-noun/organization entity in each claim must trace to an **approved**
   fact. Anything that doesn't makes the claim unsupported, which fails the whole document.
   Unapproved facts provide no support.
2. **Optional LLM judge:** runs only on claims that already passed the gate and can only
   **downgrade** them (flag an unfaithful paraphrase). It can never rescue a claim the gate
   rejected — an LLM "looks fine" never overrides a failed deterministic check.

It errs toward flagging: a false positive is cheap; a fabricated credential is not.

## What Milestone 1 was verified against (`npm test`)

- Heuristic resume parsing extracts employment/education/skills/metrics/contact, all
  **unapproved** until reviewed.
- The ledger approval flow: only approved facts are usable; add/remove/approve-all work.
- The datastore round-trips the profile and ledger, **encrypts at rest** when a key is set, and
  rejects structurally-invalid data via Zod.
- The verifier **PASSES** a document built only from approved facts and **FAILS** a deliberately
  fabricated one (fake employer, inflated metrics, fake credential, fake degree), naming each
  fabrication.
- DynamicQA "ask once, reuse" normalizes phrasings and reuses stored answers.

**Milestone 2 (Module 5):**
- The template generator produces a **submission-eligible** resume + cover letter from approved
  facts, tailored toward the posting's keywords, with the most recent role first.
- Output contains **no em-dashes** and renders to valid PDF (`%PDF`) and DOCX (zip) that extract
  back to clean, parseable text (ATS-friendly).
- A deliberately **fabricating generator is blocked** by the verifier gate (resume marked not
  submission-eligible, the offending sentence surfaced) — generation can never emit a document
  asserting something outside the approved ledger.

**Milestone 3 (Modules 4 + 6):** verified end-to-end in a real (headless, for tests) browser
against a high-fidelity local Greenhouse form fixture:
- The Greenhouse adapter **detects** the form (by DOM signature, not just URL), **enumerates**
  text/native-select/radio/custom-dropdown/file fields, **sets** values (dispatching framework
  events), and **reads them back**.
- The layered matcher maps profile values to rendered options (Yes/No, EEO option text), filling
  identity and user-confirmed work-auth/screening fields.
- An **unconfirmed self-id** value (`source !== "user"`) is **filled-then-flagged**, never
  silently submitted; an **unmapped required** field **pauses for the human**; the resume is
  **attached**; the **submit control is located but never clicked**.
- In `semi_auto` ApplyPilot **never submits** (proven via a form submit-guard), **hard dedup**
  refuses a second application to the same job, and a **CAPTCHA/login wall** surfaces the headed
  browser and pauses.

Additionally validated **read-only against a live Greenhouse posting** (an NPR role): the adapter
detected it, enumerated 31 real fields, filled identity + mapped Country and visa-sponsorship,
flagged the unconfirmed self-id, and paused the rest — typing nothing and submitting nothing. The
page embeds **reCAPTCHA**, so a real `semi_auto` run pauses immediately and hands off the browser
(hard constraint #3), never attempting to solve it. The adapter is hardened for new-Greenhouse
`react-select` markup (de-duplicates the hidden backing input behind each combobox).

## Project layout

```
src/
  types/        applicant-profile.ts, facts-ledger.ts   (brief's exact types — source of truth)
  validation/   Zod schemas, compile-time pinned to the types
  db/           SQLite store, encryption-at-rest, profile + ledger repos, audit log
  config.ts     local .env config (LLM key optional)
  profile/      blank-profile factory, setup wizard, DynamicQA memory
  ingestion/    resume text extraction, parser, default extraction, ledger ops + review
  generation/   ledger-check + verifier + claim extraction; posting parser, document model,
                template/LLM generators, verifier-gated pipeline, PDF/DOCX renderer
  ats/          adapter.ts (brief interface) + Playwright browser/session manager, Greenhouse
                adapter, layered field matcher + synonyms, page-context
  finder/       source connectors (Greenhouse/Lever/Ashby/SmartRecruiters/Workable/Workday), normalization,
                cross-source dedupe, and the fit-scoring pipeline (+ NetGuard in net/)
  jobs/         URL recognition, apply-capability, US-eligibility, and the source catalog
  email/        job-alert email ingestion (LinkedIn/Indeed .eml/.mbox parsing, alert-sender allowlist)
  insights/     inferred signals (years/seniority/domains), kept separate from the facts ledger
  orchestrator/ semi_auto apply orchestrator + review/submit gate
  server/       local API bind + access control (loopback/Tailscale)
  llm/          optional Anthropic wrapper
  cli/          setup, ingest, ledger, verify-doc, generate, apply, companies, discover + prompts
test/           vitest suites + fixtures (sample resume, good/fabricated docs, posting,
                Greenhouse application form)
```
