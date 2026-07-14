# ApplyPilot — project instructions for Codex

This is a local-first, single-user job-application co-pilot. The authoritative product spec is
[`BUILD_BRIEF.md`](./BUILD_BRIEF.md); build status and run commands are in [`README.md`](./README.md).
Hard constraints from the brief still apply (US roles only; submit only through the employer's own
career page/ATS; never solve or bypass CAPTCHAs; never fabricate resume/cover-letter claims; no
self-ID / work-auth value auto-submitted unless user-confirmed; PII stays local). **Credential
policy (owner amendment 2026-07-06, superseding the original "never store credentials / never
auto-enter passwords" rule):** the app MAY save the user's own career-site logins in the encrypted
credential vault (`src/db/credentials-vault.ts`) and auto-enter them, and MAY fill + click "Create
Account" for a new signup — but it ALWAYS hands off at email verification / CAPTCHA, NEVER solves a
CAPTCHA, and NEVER stores a password in plaintext, logs it, or commits it. Treat anything touching
the vault / auto-login / account creation as **max** effort (security + auth).

## Effort Selection Rule

Before starting **any coding task**, classify it and explain the choice in 2-4 sentences. **Do not
begin editing files** until you provide:

1. **Recommended effort level:** low / medium / high / xhigh / max
2. **Reason** for that effort level
3. **Risk level:** low / medium / high
4. **Whether this task touches:** architecture, authentication, database schema, personal data,
   browser automation, payments, deployment, or application-submission logic

Use these rules:

- **low** — tiny, isolated edits with no meaningful logic change.
- **medium** — routine implementation, cleanup, tests, formatting, and simple UI work.
- **high** — normal feature work, moderate debugging, or changes across a few files.
- **xhigh** — multi-file features, unclear requirements, complex debugging, agentic/browser
  automation, integrations, or anything where a mistake could break core behavior.
- **max** — architecture decisions, security/privacy-sensitive work, database design/migrations,
  job-application submission logic, final pre-merge review, or situations where xhigh is likely
  insufficient.

If **max** is recommended, first explain why **xhigh is not enough**.

When tokens are limited, **prefer high by default** and escalate only when the risk or uncertainty
justifies it.

## Mode Selection Rule

End **every** reply with a one-line recommendation of the cheapest model/mode that can still do the
job well (token economy). Map from the effort level:

- **low** -> **Haiku 4.5**
- **medium / high** -> **Sonnet 4.6**
- **xhigh / max** -> **Opus 4.8** (use `/fast` for faster Opus output)

Example footer: `🧭 Optimal mode: Sonnet 4.6 — Opus is overkill here.` Also keep replies concise.

> Note for ApplyPilot specifically: anything touching `src/ats/**` (browser automation),
> `src/orchestrator/**` (apply/submit), the discovery apply paths, or the profile/PII stores is at
> least **xhigh**, and live application-submission wiring is **max**.

## Local desktop app parity (required)

ApplyPilot's primary UI is the **local desktop app** (`npm run app` / `~/Desktop/ApplyPilot.app`),
not just the two-terminal Vite dev setup. Every feature change MUST keep the desktop app working.

After **any** change that touches the engine (`src/**`) or dashboard (`dashboard/**`):

1. **Engine/API** — the Electron shell spawns `src/cli/dashboard-api.ts` in dev and
   `app-build/engine.cjs` when packaged. If you changed server/orchestrator/CLI code, run
   `npm run build:engine` before testing a packaged build.
2. **Dashboard UI** — Electron serves `dashboard/dist/` (not the Vite dev server). Run
   `npm run app:build` (or `npm run app:sync` for both) so `ApplyPilot.app` / `npm run app`
   picks up UI changes on next launch.
3. **Verify in the app** — confirm the feature works at `http://127.0.0.1:5179` inside the
   Electron window (Find jobs, profile, targets, etc.), not only via `cd dashboard && npm run dev`.
4. **Electron shell** — if you add API routes or change ports/bind behavior, update
   `electron/main.cjs` and `scripts/install-desktop.mjs` as needed.

Quick sync before handing off: `npm run app:sync` then `npm run app` (or relaunch the Desktop app).
