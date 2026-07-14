# Workday integration — plan & spec

> Status: **Proposal / not yet built.** This document scopes how ApplyPilot would add
> Workday (`*.myworkdayjobs.com` / `*.myworkdaysite.com`) to the automated apply pipeline.
> File/line references are anchors as of writing and may drift as code changes.

Workday is the single most complex ATS we would support: it requires a per-employer account,
runs a 5–8 page wizard, uses dynamic React widgets keyed on `data-automation-id`, and times out
mid-flow. This doc records the decisions we've made, the roadblocks (ranked), how each of the
project's hard constraints is honored, and a phased build plan.

---

## 1. The reframe that governs everything

**Workday can never be "one-click apply to a new company" — and that is by design, not a gap.**

Workday gates every application behind a **candidate account (email + password), created
per-tenant**, and emails a **verification link/code** before the form opens. Hard constraint #5
("never auto-create accounts, never auto-enter passwords") is already enforced in code:

- `src/ats/account.ts:167-194` (`prefillRegistration`) fills only non-secret fields (email / name /
  phone), **never a password**, and **never clicks submit**.
- `src/orchestrator/apply.ts:196-238` detects the wall, optionally copies a generated password to
  the clipboard for the user, records status `account_required`, and returns
  `{ accountRequired: true, submitted: false }` — it pauses.
- Email verification happens in the user's inbox, entirely outside the automated browser.

**Therefore the value proposition is: fast *repeat* applications to a tenant the user already has an
account with.** The first application to any new employer always requires a manual human step
(create account → verify email → log in). After that, the persistent-context session cookie
(`src/ats/browser.ts:117-152`) plus `markLoggedIn` (`src/orchestrator/apply.ts:240-249`) let
automation resume with **no stored credential**.

---

## 2. Decisions (made)

| # | Decision | Choice | Rationale / implication |
|---|----------|--------|-------------------------|
| D1 | Adapter scope | **Generic best-effort** across all Workday tenants | One adapter detecting by host + `data-automation-id`. Widest coverage; per-tenant field-mapping breakage is expected and must be caught by the confidence gate (see §5). |
| D2 | "My Experience" data source | **Approved `FactsLedger` only**, surfaced via a new **"Summarized" tab** | The ledger stays the source of truth; the paragraph is a *faithful rephrasing* of approved bullets, gated by ledger-check. We do **not** trust Workday's own resume-autofill as a source. See §6. |
| D3 | Review cadence | **Final review only**, with a confidence-gated advance | Auto-advance while every page is clean; stop the moment a page has an unmapped required field or low-confidence match. Human still clicks the final Submit (see §5). |
| D4 | Workday's tenant-specific questions | **Ask the user (proactive + reactive), remember cross-tenant by question text** | The opaque hex-named TD questions (previous-employment, relatives, PEP, employment-type, language proficiency, comp) have no profile mapping — the app asks them (up front and/or when a fill reaches one), stores the answer keyed by normalized question text, and reuses it at any tenant that asks the same thing. Self-ID / work-auth / knockout stay under the existing confirmation gate. See §6a. |

---

## 3. What already exists in our favor

- **Discovery is done.** `WorkdayBoard` (`src/discovery/workday-board.ts`) scrapes postings today;
  `src/discovery/target-catalog.ts:107-142` lists ~dozens of Workday employers (Wells Fargo,
  Capital One, PayPal, Intuit, Visa, Salesforce, Adobe, CVS, Booz Allen…). The `AtsType` union
  already includes `'workday'` (`src/discovery/types.ts:13`).
- **Guardrail machinery Workday needs already exists:** account-wall handoff (`account.ts`),
  challenge-pause (`src/ats/challenge.ts`), the risk gate that refuses to auto-fill
  self-ID / work-auth unless user-confirmed (`decideFillAction`, `src/ats/adapter.ts:175-215`),
  persistent-cookie session reuse, and the US-only filter (`src/discovery/hard-filters.ts:67-81`).
- **The matcher and risk gate are ATS-agnostic.** A Workday adapter reuses `LayeredFieldMatcher`,
  `src/ats/synonyms.ts`, and `decideFillAction` unchanged. Only DOM enumeration and value-setting
  are Workday-specific.

---

## 4. Roadblocks (ranked)

### 🔴 Blocker 1 — No multi-step wizard architecture

The entire apply model is single-page. `fillApplication` enumerates fields **once** and fills in one
pass (`src/ats/adapter.ts:234-299`); `runApplication` is one linear pass; `findSubmitControl`
returns a single terminal control (`adapter.ts:131`). `FormField.step` is declared (`adapter.ts:83`)
but **never populated by any adapter**. Workday is a 5–8 page wizard
(My Information → My Experience → Application Questions → Voluntary Disclosures → Self-Identify →
Review → Submit). **This is the largest build.** See §5 for the proposed contract.

### 🔴 Blocker 2 — Account creation + email verification cannot be automated

Covered in §1. A product ceiling, not a bug. Every *new* tenant = a mandatory manual step.

### 🟠 Major 3 — Login-first pages and mid-wizard session timeouts

The challenge detector treats any `input[type=password]` or "sign in to continue/apply" text as a
human challenge → hard pause (`src/ats/greenhouse.ts:242-255`). Workday shows login first, **and**
sessions time out mid-wizard (multi-day "Save for later"), so a login/timeout wall can reappear at
**any** step. Today we check for walls only once, at the top of `runApplication`. The step loop must
re-run `inspectAccountWall` + `hasHumanChallenge` at **every** step boundary and resume without
losing entered data (reusing `ApplySession.refresh()` semantics, `src/orchestrator/apply-session.ts`).

### 🟠 Major 4 — "My Experience" needs data auto-fill cannot see

Workday's Experience step wants structured employment (employer / title / dates / location) and
education as repeating "Add Another" sections. That data lives **only in the decoupled
`FactsLedger`** (`src/types/facts-ledger.ts:25` `EmploymentFact`, `:36` `EducationFact`); the
auto-fill `ApplicantProfile` has none of it — by explicit design rule
(`src/types/applicant-profile.ts:18-19`; `src/db/ledger-repo.ts:3-4`: "document generation reads the
ledger; auto-fill reads the profile. Keep them decoupled"). Bridging the ledger into fill crosses
that boundary deliberately and must reconcile against **approved** facts to avoid submitting
misparsed claims (constraint #4). See §6.

### 🟠 Major 5 — Workday widgets exceed the generic field engine

`setCustomSelect` (`src/ats/greenhouse.ts:131-150`) assumes a simple open → type → click-option
dropdown. Workday uses typeahead location pickers (cascading country/state/city), multiselect chips,
3-part date inputs, required phone-device-type selects, and "Add Another" repeaters. Its DOM is
driven by `data-automation-id` (which *discovery* code already uses) but the generic engine resolves
via aria/labels (`greenhouse.ts:375-399`), not that. And the core engine has **no explicit waits**;
Workday lazy-renders each step after XHR. → A Workday adapter is **not** a thin Greenhouse subclass
like Lever/Ashby; it needs a mostly-bespoke engine keyed on `data-automation-id` with real
`waitForSelector` calls between steps.

### 🟠 Major 6 — A named adapter silently becomes auto-submit-eligible

`src/orchestrator/submit-readiness.ts` force-queues only `ats === 'generic'`; a named `'workday'`
would pass that check. Given Workday's fragility, it must be **explicitly pinned to
human-submit-only**.

### 🟠 Major 7 — Per-tenant account + resumable state is not modeled

The accounts store is domain-metadata only — no password column by design
(`src/db/database.ts` accounts DDL). There is no "email verified for tenant X" or "in-progress at
step Z." Needed to tell a first-time tenant from a returning one and to resume multi-day flows.
See §7.

### 🟡 Minor 8 — Self-ID / EEO / CC-305

Mostly handled: the risk gate (`decideFillAction`) + the semantic profile model already cover
EEO / veteran / disability, and pause unless the value is user-confirmed (`source === 'user'`,
`src/types/applicant-profile.ts:38-42`). New bits are small: CC-305 signature name/date fields, an
acknowledgement checkbox, and a few Workday-specific synonym entries.

### 🟡 Minor 9 — reCAPTCHA + test scaffolding

reCAPTCHA already pauses (no bypass; solver env keys are actively purged,
`src/server/config-store.ts:96-102`). Only Workday-specific detection selectors are new. Separately,
a single static fixture cannot represent the wizard — a **multi-page fixture harness** is required
(see §9).

---

## 5. Design — multi-step contract, confidence-gated advance, human-submit-only

### 5.1 Step loop

Add an optional multi-step contract that non-Workday adapters simply don't implement, so the
single-page path is untouched:

- `findNextControl(ctx): Promise<{ ref } | null>` — the per-page "Save and Continue" / "Next",
  distinct from `findSubmitControl` (the final Submit).
- `isFinalStep(ctx): Promise<boolean>` — true on the Review page.
- `advanceStep(ctx): Promise<void>` — click Next and wait for the next step to hydrate.

`runApplication` gains a loop: `getFields → fill → re-check wall/challenge → if final, stop for
review; else advance`. Populate `FormField.step` at last so the review gate can group fields by page.

### 5.2 Confidence-gated advance (reconciles D3 with safety)

"Final review only" (D3) means **advance automatically only while every page is clean**. A page is
*not* clean — and the loop stops and surfaces it — when `fillApplication` reports any
`needsConfirmation` (unmapped required field, low-confidence match, or readback mismatch;
`src/ats/adapter.ts:187-214`, `250-296`). This gives hands-off progress on the happy path and a hard
stop on exactly the pages a generic adapter (D1) is most likely to mis-fill.

### 5.3 Human-submit-only (non-negotiable)

- Pin `'workday'` out of the auto-submit path in `submit-readiness.ts` (Major 6).
- Self-ID and work-authorization fields still pause individually regardless of cadence
  (`adapter.ts:199`).
- The final Submit is always a human click. "Final review only" trims the *intermediate* check-ins,
  never the human-submit guarantee.

---

## 6. The "Summarized" tab (D2) — faithful rephrasing, no fabrication

Each Workday Experience entry has a free-text **"Role Description"** box that reads better as prose
than pasted bullets. The tab produces that prose **without introducing unverified claims**:

1. Read **approved** `EmploymentFact.bullets` from the ledger (`src/types/facts-ledger.ts:25`).
2. LLM-summarize each role's bullets into a paragraph (`src/llm`), PII-redacted on the way out
   (`src/llm/redaction.ts`).
3. **Run the paragraph back through the same ledger-check gate document generation already uses**
   (`src/generation/ledger-check.ts` — every named entity, date, and number must be supported by the
   ledger). If the summary invents a metric, title, or date, it fails and regenerates. This is what
   keeps the feature on the right side of constraint #4 ("never fabricate").
4. Present it in the tab for the user to edit/approve. The approved paragraph is what feeds Workday's
   Role Description field.

The tab is a **presentation + faithful-rephrasing layer over the ledger** — never a new source of
unverified claims. (Desktop parity: a dashboard change requires `npm run app:sync` + relaunch, per
`CLAUDE.md`.)

**Status: ◐ engine done, UI wiring next.** `src/generation/experience-summary.ts` implements the
summarize-and-gate core: `summarizeExperience(fact, ledger, deps)` produces a paragraph via the LLM,
runs it through the **same `DeterministicLedgerVerifier`** document generation uses, and — on a
failed check — retries with the offending sentences fed back, then falls back to the role's verbatim
bullets (faithful by construction). A fabricated paragraph is **never surfaced**. Verified with
`test/experience-summary.test.ts` (faithful passes; a summary inventing "team of 12 / 95% / $2M" is
caught and the verbatim bullets are returned instead; the repair loop accepts a corrected attempt).
**Remaining:** an API route + the dashboard "Summarized" tab UI (per-role paragraph, editable,
copy-to-Role-Description) — needs the running app to build/verify (`npm run app:sync`).

---

## 6a. Asking Workday's questions — "so it knows what to click" (D4)

Grounded in a real captured schema (TD Bank tenant), a Workday form has three kinds of field:

1. **Data-derivable** — standard fields with stable `name` hooks (`legalName--firstName`,
   `phoneNumber`, `jobTitle`, `gender`, `veteranStatus`, the work-auth questions). Filled from the
   profile / approved ledger, or routed through the existing risk gate.
2. **Tenant-specific questions** — opaque hex `name` ids (`73a5111f…`, `de76965…`) whose answers live
   in **no** profile: TD's previous-employment, relatives, PEP, government-agency, employment-type,
   language-proficiency, and compensation questions. The app must **ask** these and **remember** them.
3. **Legal / documents** — a Terms acceptance checkbox and a resume upload, **never auto-answered**.

**Status: ✅ done (the decision layer).** `src/ats/workday-questions.ts` classifies each enumerated
field (`classifyWorkdayField`) and produces the ask-the-user list (`workdayQuestions` /
`workdayQuestionsToAsk`), keyed for the answer bank. It builds directly on the existing "ask once,
reuse forever" machinery: `normalizeQuestionSignature` + `upsertDynamicAnswer`
(`src/profile/dynamic-qa.ts`), and the matcher's `fallback` (`field-matcher.ts`) already reuses a
stored `DynamicQA` answer **cross-tenant by normalized question text** — so a TD question answered
once auto-fills at any tenant that asks the same thing (D4). The list serves **both** flows: render it
whole as a proactive "Workday questions" screen, or filter to the not-yet-remembered ones during a
fill. Self-ID / work-auth / knockout are **not** re-asked here (the profile wizard + risk gate own
them). Verified with `test/workday-questions.test.ts` against the real (PII-free) TD field structure.

**No PII:** the module is pure logic; the fixture is field *structure* only (labels/`name`s, no
personal values); answers live only in the local encrypted datastore, never in the repo.

## 7. Data-model additions (metadata only — never a password)

- **Per-tenant account state**, keyed by Workday tenant host: `accountExists`, `emailVerified`,
  `lastLoggedInAt`. Extends the existing accounts store; **no password column** (preserves the
  `src/db/database.ts` invariant).
- **Resumable-application record**: tenant, requisition URL, last-completed step, status — persisted
  in the local encrypted datastore (`src/db/crypto.ts`) so a multi-day "Save for later" flow can be
  reopened at the right step.

Both surface in the review gate so the user knows whether a manual account step is needed before an
application, and whether one is resumable.

---

## 8. Phased build plan

- **Phase 0 — foundation (low risk). ✅ Done.** `WorkdayAdapter` (`src/ats/workday.ts`) with real
  detection (host + `data-automation-id` markers), registered in `pickAdapter` **before** Greenhouse,
  and **Workday explicitly pinned to human-submit-only** in `submit-readiness.ts`.
  **`'workday'` is deliberately NOT added to `FORM_FILL_SUPPORTED_ATS` yet** — exposing a single-pass
  adapter on a multi-page wizard would fill page 1 and present a "ready to submit" state with 5 pages
  blank. To make that impossible by construction, `getFields` throws until the multi-step engine
  lands, so a premature allowlist flip fails loud instead of mis-filling. The allowlist flip happens
  at the **end of Phase 2**, gated on passing multi-page fixture tests. Net effect today: the wiring
  and safety pin are in place and tested; Workday jobs still correctly report `manual_open_only`.
- **Phase 1 — the multi-step engine. ✅ Done (dormant until Phase 2).** The §5 contract
  (`MultiStepAtsAdapter` + `isMultiStep`, `src/ats/adapter.ts`), the step loop with confidence-gated
  advance and per-step challenge re-checks (`fillMultiStepApplication`, `src/ats/multi-step.ts`), and
  `FormField.step` populated per page. Wired into both `runApplication` (`apply.ts`) and the in-app
  `ApplySession` (`apply-session.ts`) as an inert ternary — no real adapter is multi-step yet, so the
  single-page path is byte-for-byte unchanged. The engine is verified end-to-end with a scripted
  adapter + fake matcher (`test/multi-step.test.ts`): fills clean steps, stops at the final step,
  never advances past a page needing a human, stops on a mid-wizard challenge, and backstops runaway
  flows with a step cap. The engine returns a plain `FillReport` (plus step telemetry) so the review
  gate and submit-readiness are unchanged.
- **Phase 2 — the Workday field engine. ◐ First cut done (EXPERIMENTAL, gated off).**
  `WorkdayAdapter` now implements the multi-step contract (`src/ats/workday.ts`): it reuses the proven
  Greenhouse enumeration/fill engine for Workday's standard inputs/labels, and adds the
  Workday-specific navigation — `findNextControl` / `isFinalStep` / `advanceStep` + a strict
  `findSubmitControl` (only "Submit", so an intermediate "Save and Continue" page yields no submit
  control and the gate blocks a premature one-click submit). The safety-critical *which-button*
  decision lives in **pure, unit-tested** helpers (`src/ats/workday-dom.ts`,
  `test/workday-dom.test.ts`); the in-page code only scrapes buttons and delegates. **Still not
  allowlisted** — the DOM enumeration/fill can't be verified without a browser, so it's experimental
  and human-submit-only + confidence-gated-advance remain in force. **Remaining before the allowlist
  flip:** name/`id`-based enumeration (so `classifyWorkdayField` runs on stable refs at fill time),
  dedicated `setField` handlers for the widgets the schema revealed (on-demand `custom_select`
  dropdowns, 2-/3-part date spinbuttons, `multi_checkbox`, typeahead skills, "Add Another" repeaters),
  a **live logged-in run** on a real tenant, and multi-page fixture tests.
- **Phase 3 — Experience data + Summarized tab + state.** Ledger→fill bridge (§4 Major 4), the
  Summarized tab (§6), and the per-tenant / resumable state model (§7).

The account-creation ceiling (§1) stands over all phases: first application to any new tenant is a
manual human step, then automation takes over.

---

## 9. Testing strategy

- **Multi-page fixture harness.** Several linked static fixture pages that simulate
  Save-and-Continue transitions (a single fixture cannot represent the wizard). Model on
  `test/smartrecruiters-apply.test.ts` + a new `test/fixtures/workday-*.html` set.
- **Confidence-gate tests.** Assert the loop stops (does not advance) when a step yields any
  `needsConfirmation`.
- **Anti-fabrication tests.** Assert a Summarized paragraph that introduces an unsupported
  entity/date/number fails ledger-check and does not reach the fill layer.
- **Human-submit-only tests.** Assert `'workday'` is never eligible for auto-submit.
- **Growing the allowlist requires a real adapter + tests** (`src/discovery/apply-capability.ts`
  comment) — gate each `FORM_FILL_SUPPORTED_ATS` change on passing fixtures.

---

## 10. Guardrail compliance matrix

| Hard constraint | How the Workday flow honors it |
|-----------------|--------------------------------|
| US roles only | Inherited from discovery-time `hard-filters.ts:67-81`; non-US Workday postings blocked, ambiguous ones capped to manual review. |
| Submit only through the employer's ATS | We drive the employer's own Workday tenant; final Submit is a human click. |
| Never solve/bypass CAPTCHAs | reCAPTCHA/challenge → pause (`challenge.ts`); solver keys purged (`config-store.ts:96-102`). No bypass added. |
| Never fabricate | Experience filled from **approved** ledger facts; Summarized paragraphs pass ledger-check (§6). Workday resume-autofill is not trusted as a source. |
| Never auto-create accounts / enter passwords | Account wall → prefill non-secrets, clipboard password hand-off, pause (`account.ts`, `apply.ts:196-238`). Verification is user-side. |
| No self-ID / work-auth auto-submitted unless user-confirmed | `decideFillAction` pauses these unless `source === 'user'` (`adapter.ts:199`). |
| PII stays local | Encrypted at rest (`db/crypto.ts`); new state is metadata-only, no password column; PII redacted before LLM calls (`redaction.ts`). |

---

## 11. Open questions / residual risk

- **Generic vs per-tenant drift (D1).** A generic adapter will mis-map some tenants' custom fields;
  the confidence gate (§5.2) turns that into a pause rather than a wrong submission, but coverage
  quality will vary by tenant. Revisit whether high-value tenants warrant tuned field maps.
- **"Autofill with Resume" interaction.** Even if we don't *trust* it as a source, some tenants
  pre-populate it automatically; the adapter may need to clear/override those fields to keep the
  approved ledger authoritative.
- **Session-timeout UX.** Multi-day resume depends on the resumable-application record (§7) and on
  Workday keeping the requisition URL stable; needs live validation against real tenants.
