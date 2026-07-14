# Build Brief — Personal Job-Application Co-Pilot

> Single source of truth for this project. Follow it **one milestone at a time** (see §6).
> Do not attempt to build all modules at once. Implement the current milestone, then stop
> so the user can run and verify it.

---

## 0. What you are building

A local-first app, **single-user per install** (each person runs their own copy), that:

1. ingests a master resume and a structured applicant profile,
2. discovers **US** job postings matching the user by browsing **company career pages / ATS boards**
   (Greenhouse, Lever, Ashby — not aggregators),
3. generates **strictly truthful** tailored resumes and cover letters,
4. navigates the **employer's own career-page** application flow,
5. auto-fills fields (including standardized self-identification) under a **risk-weighted
   policy**, and
6. **pauses for one-click human submit** — the user reviews the pre-filled form and clicks Submit
   in the headed browser. Unattended auto-submit is out of scope for the product surface.

No interview preparation features. No applying through aggregators. US roles only.

---

## 1. Hard constraints (non-negotiable; if a task requires violating one, STOP and ask)

1. **US-based roles only.**
2. **Submit ONLY through the employer's own career page / their ATS instance.** Never submit
   through an aggregator. Skip "Easy Apply" / "Apply on [aggregator]" flows; follow only
   "apply on company website" paths. Discard listings with no off-aggregator apply route.
3. **No CAPTCHA solving and no bot-detection evasion** — no fingerprint spoofing, no proxy
   rotation to dodge blocks. On any CAPTCHA / human-verification / login wall, surface the
   live headed browser to the user and pause.
4. **Never fabricate.** Generated resumes/cover letters may reorder, reweight, and rephrase
   ONLY facts present in the facts ledger (Module 2). No invented employers, titles, dates,
   degrees, certifications, metrics, or skills. Enforce with the automated ledger verifier;
   anything that fails the check may not be submitted.
5. **Credential vault + assisted login** *(owner-approved amendment 2026-07-06 — supersedes the
   original "never store credentials / never auto-enter passwords" rule; this is a single-user,
   local-first app and the credentials are the user's own).* ApplyPilot MAY save the user's own
   career-site logins in the encrypted credential vault and auto-enter them; and for a site with no
   account it MAY generate a strong password, save it, fill the signup form, and click "Create
   Account". **These security requirements remain non-negotiable:** passwords are encrypted at rest
   (OS keychain via `safeStorage` when packaged, AES-256-GCM otherwise), **never** stored in
   plaintext, **never** logged, **never** committed; the app still **never solves a CAPTCHA** (#3)
   and still **hands off to the user at email verification** (and any CAPTCHA) during signup.
6. **Operating modes:** The product surface is **discovery + assisted apply** — ApplyPilot finds
   matching roles on company career pages, pre-fills applications, and **pauses for you to click
   Submit**. Regardless of mode: no self-identification or work-authorization value may be
   auto-submitted unless it is user-confirmed (`source === "user"`). Unconfirmed high-stakes
   values pause for the human. Nothing may bypass CAPTCHA or submit unattended from the UI.
7. **PII stays local.** Never transmit resume / self-ID / PII anywhere except the target
   career site being applied to and the LLM provider used for generation/matching. Never
   commit it to the repo.

---

## 2. Recommended stack (confirm what's installed; adapt if needed)

- TypeScript + Node
- Playwright (Chromium), running **headed by default** so the user can watch and intervene
- SQLite (Prisma or better-sqlite3) for the local datastore
- Minimal local web dashboard (Vite + React) for profile setup, reviewing matches,
  reviewing generated docs, and the review/submit gate
- LLM calls via the Anthropic API for matching, document generation, and field-mapping
- Secrets in a local `.env` / OS keychain; never commit them

**Generate the Zod validators and the Prisma schema FROM the TypeScript types in Modules 1,
2, and 4 — do not hand-write the shapes twice.**

---

## 3. Repository & data hygiene (do this first)

- Initialize the project inside the cloned **private** repo:
  `https://github.com/Jvtino/Job-Applications-Project.git`
- **Distribution = local single-user instances.** Each person runs their own copy, with
  their own profile, own session logins, and own LLM API key. No shared backend, no central
  datastore. **Do not build a multi-tenant version.**
- Commit ONLY source code and config **templates**. Provide a `.env.example` with
  placeholder keys only.
- Use exactly this `.gitignore`:

```gitignore
.env
.env.*
!.env.example
node_modules/
dist/
build/
*.sqlite
*.sqlite3
*.db
/data/
/uploads/
/resumes/
/generated/
/output/
/.auth/
/browser-profile/
playwright/.auth/
*.log
.DS_Store
```

- Before the first commit, run `git status` and verify nothing in the ignore list is staged.
  If a secret is ever committed, treat it as compromised and rotate it (history is
  permanent).

---

## 4. Operating modes (user-selectable; overridable per application)

- **manual** — discover, score, and generate tailored docs; fill nothing. The user applies
  themselves with the documents in hand.
- **semi_auto (default)** — fill the entire career-page form per the risk policy, then PAUSE
  at the review gate for one-click human submit.
- **auto** — only for a per-employer allowlist of CAPTCHA-free forms the user has explicitly
  pre-approved; submit without pausing **only if** `canAutoSubmit(report, mode)` is true;
  otherwise fall back to the review gate. Still pauses on any CAPTCHA, login, unmapped
  required field, readback mismatch, or failed ledger check.

No mode may bypass CAPTCHA or submit an unconfirmed self-ID / work-authorization value.

---

## 5. Modules

### Module 1 — Profile & Answer Store ("the brain")

Create `src/types/applicant-profile.ts` with **exactly** this content:

```typescript
// src/types/applicant-profile.ts
//
// Applicant profile / answer store — the "brain" that drives every auto-fill.
//
// DESIGN RULES (do not violate):
//  1. Store SEMANTIC values (enums / booleans), NEVER the legal display text of any
//     self-identification form. Self-ID forms (EEO, VEVRAA veteran, OFCCP disability) are
//     revised periodically and every ATS phrases the options slightly differently. The
//     ATS field-mapping layer matches THESE values to whatever option text a given career
//     page renders at fill time. Never hardcode form wording.
//  2. "Decline to answer" is a real value, carried by the universal DECLINE marker in the
//     Answer<T> wrapper. It maps to each form's explicit "I don't wish to answer" option.
//     A value of `null` means "not provided yet" -> the setup wizard must ask. These are
//     different states.
//  3. This data is sensitive PII (especially disability and veteran status). It lives ONLY
//     in the local, gitignored datastore, never committed to the repo, ideally encrypted
//     at rest.
//  4. The parsed-resume FACTS LEDGER is a SEPARATE store. Document generation reads the
//     ledger; auto-fill reads THIS profile. Keep them decoupled.

// ----------------------------------------------------------------------------------------
// Shared primitives
// ----------------------------------------------------------------------------------------

/** A real "I choose not to answer", distinct from "not filled in yet" (null). */
export type Decline = "decline_to_answer";
export const DECLINE: Decline = "decline_to_answer";

/**
 * Wraps any answer with provenance so the orchestrator knows whether to trust it or pause.
 *  - value === null      -> wizard has not collected this yet; ask the user.
 *  - value === DECLINE   -> user explicitly declined; select the form's "decline" option.
 *  - source === "user"   -> confirmed by the user (required before AUTO-submit of self-ID
 *                           and work-authorization fields; see brief guardrail).
 *  - source === "default"-> app-seeded default the user has NOT yet confirmed.
 *  - source === "inferred" -> derived from the resume/ledger; treat as low confidence.
 */
export interface Answer<T> {
  value: T | Decline | null;
  source: "user" | "inferred" | "default";
  updatedAt: string; // ISO 8601
}

// ----------------------------------------------------------------------------------------
// Identity & contact
// ----------------------------------------------------------------------------------------

export interface ContactInfo {
  legalFirstName: string;
  legalLastName: string;
  preferredName?: string;
  email: string;
  phone: string;
  address: {
    line1: string;
    line2?: string;
    city: string;
    state: string; // US state/territory code
    postalCode: string;
    country: "US";
  };
  links: {
    linkedin?: string;
    portfolio?: string;
    github?: string;
    other?: { label: string; url: string }[];
  };
}

// ----------------------------------------------------------------------------------------
// Work authorization (two DISTINCT questions ATS routinely conflate)
// ----------------------------------------------------------------------------------------

export interface WorkAuthorization {
  authorizedToWorkInUS: Answer<boolean>;
  requiresSponsorshipNowOrFuture: Answer<boolean>;
  currentWorkStatus?: Answer<
    "us_citizen" | "permanent_resident" | "visa_holder" | "other"
  >;
}

// ----------------------------------------------------------------------------------------
// Logistics & preferences
// ----------------------------------------------------------------------------------------

export interface JobPreferences {
  earliestStartDate: Answer<string>; // ISO date or "immediate"
  noticePeriodDays: Answer<number>;
  willingToRelocate: Answer<boolean>;
  workModePreference: Answer<("remote" | "hybrid" | "onsite")[]>;
  desiredLocations: string[];
  compensation: {
    currency: "USD";
    desiredBaseMin?: number;
    desiredBaseMax?: number;
    /** If true, answer "negotiable" wherever the field is free-text. */
    isNegotiable: boolean;
  };
}

// ----------------------------------------------------------------------------------------
// Standard knockout / screening questions
// (Common ones modeled explicitly; everything else lives in DynamicQA below.)
// ----------------------------------------------------------------------------------------

export interface ScreeningAnswers {
  isAtLeast18: Answer<boolean>;
  /** "Can you, with or without reasonable accommodation, perform the essential functions?" */
  canPerformEssentialFunctions: Answer<boolean>;
  requiresAccommodationForProcess: Answer<boolean>;
  /**
   * "Have you previously worked for [company]?" — defaults false but MUST be resolved per
   * target employer at apply time (cross-reference the work history in the facts ledger).
   */
  previouslyEmployedHere: Answer<boolean>;
  hearAboutSource?: Answer<string>; // "How did you hear about us?"
  hasNonCompete?: Answer<boolean>;
  willingToTravelPercent?: Answer<number>;
}

// ----------------------------------------------------------------------------------------
// Voluntary self-identification
//   NOTE: DECLINE (via Answer<T>) maps to each form's explicit "do not wish to answer"
//   option. That is why these enums contain no separate "decline" member.
// ----------------------------------------------------------------------------------------

// EEO gender. Some forms offer only male/female; others add non-binary. DECLINE covers
// "decline to self-identify".
export type EeoGender = "male" | "female" | "non_binary";

// EEO-1 race/ethnicity. Typically SINGLE-select on application forms, with
// "two_or_more_races" as the catch-all. DECLINE covers "decline to self-identify".
export type EeoRaceEthnicity =
  | "hispanic_or_latino"
  | "white"
  | "black_or_african_american"
  | "native_hawaiian_or_other_pacific_islander"
  | "asian"
  | "american_indian_or_alaska_native"
  | "two_or_more_races";

// VEVRAA protected-veteran self-identification.
//  - `status` answers the simple yes/no form.
//  - `categories` answers the detailed multi-select form (some ATS render this instead).
// Populate both so either form variant can be satisfied. DECLINE covers
// "I don't wish to answer" / "I am a protected veteran but decline to specify classification".
export type ProtectedVeteranStatus =
  | "protected_veteran"
  | "not_protected_veteran";

export type VeteranCategory =
  | "disabled_veteran"
  | "recently_separated_veteran"
  | "active_duty_wartime_or_campaign_badge_veteran"
  | "armed_forces_service_medal_veteran";

export interface VeteranSelfId {
  status: Answer<ProtectedVeteranStatus>;
  categories: Answer<VeteranCategory[]>;
}

// Federal voluntary self-identification of disability (OFCCP Form CC-305).
// Two affirmative semantic choices; DECLINE maps to the form's "I do not want to answer"
// option. The form's printed text and OMB expiration change over time — read the LIVE
// rendered options and match to these values; never store the legal paragraph.
export type DisabilityStatus =
  | "yes_has_disability" // "Yes, I have a disability (or previously had one)"
  | "no_disability"; // "No, I do not have a disability and have not had one"

export interface SelfIdentification {
  gender: Answer<EeoGender>;
  raceEthnicity: Answer<EeoRaceEthnicity>;
  veteran: VeteranSelfId;
  disability: Answer<DisabilityStatus>;
}

// ----------------------------------------------------------------------------------------
// References
// ----------------------------------------------------------------------------------------

export interface Reference {
  name: string;
  relationship: string;
  company?: string;
  email?: string;
  phone?: string;
}

// ----------------------------------------------------------------------------------------
// Dynamic Q&A memory — "ask once, reuse forever"
// Any question NOT modeled above: ask the user once, store keyed by a normalized signature,
// and reuse on the next form that asks the same thing. Keep the original text for audit.
// ----------------------------------------------------------------------------------------

export interface DynamicQA {
  /** Normalized signature: lowercased, punctuation-stripped, whitespace-collapsed, etc. */
  key: string;
  /** Original phrasing exactly as rendered, for audit and debugging. */
  questionText: string;
  fieldType: "text" | "boolean" | "number" | "single_select" | "multi_select";
  answer: string | boolean | number | string[] | Decline | null;
  /** For selects, the options as rendered when the answer was captured. */
  options?: string[];
  updatedAt: string;
}

// ----------------------------------------------------------------------------------------
// Top-level profile
// ----------------------------------------------------------------------------------------

export interface ApplicantProfile {
  id: string;
  /** Bump when the shape changes; run migrations against stored profiles. */
  schemaVersion: number;

  contact: ContactInfo;
  workAuthorization: WorkAuthorization;
  preferences: JobPreferences;
  screening: ScreeningAnswers;
  selfId: SelfIdentification;
  references: Reference[];

  /** Grows over time as new, unmodeled questions appear. */
  dynamicAnswers: DynamicQA[];

  /** Optional pointer to the master resume file (parsing populates the SEPARATE ledger). */
  masterResumePath?: string;

  createdAt: string;
  updatedAt: string;
}

// ----------------------------------------------------------------------------------------
// Seed defaults
// Universal, app-wide defaults the wizard pre-fills but the user MUST confirm. Do not bake
// any single person's identity here — this app is also used by other people locally.
// ----------------------------------------------------------------------------------------

const now = () => new Date().toISOString();

export function seededWorkAuthorization(): WorkAuthorization {
  // US-jobs-only app: authorized-to-work defaults true, sponsorship defaults false.
  // source: "default" => unconfirmed; wizard asks the user to confirm before first use.
  return {
    authorizedToWorkInUS: { value: true, source: "default", updatedAt: now() },
    requiresSponsorshipNowOrFuture: { value: false, source: "default", updatedAt: now() },
  };
}

export function blankAnswer<T>(): Answer<T> {
  return { value: null, source: "default", updatedAt: now() };
}
```

On first run, run an **interactive setup wizard** that collects every mandatory field and
explicitly asks the veteran / disability / EEO questions, making clear they are voluntary and
that "decline to answer" (the `DECLINE` marker) is always valid. Seed the universal defaults
via `seededWorkAuthorization()` but require user confirmation before first use. Implement the
"ask once, reuse" `DynamicQA` memory keyed by a normalized question signature.

---

### Module 2 — Master Resume Ingestion + Facts Ledger (the anti-fabrication core)

- Parse the uploaded master resume (PDF/DOCX) into structured data. Provide a resume-upload
  control in the dashboard (drag-and-drop). Each user uploads their own.
- Build an **immutable facts ledger**: the closed set of atomic, true claims the user has
  approved. The ledger is the ONLY source of substance for generated documents. Tailoring may
  select, reorder, reweight, and rephrase facts; it may never assert anything outside the
  ledger.
- After ingestion, **show the user the parsed ledger for review/correction/approval** —
  parsing errors are common, and only `approved` facts are usable. The user can also add
  facts manually.
- Run an automated **ledger-conformance check** after any document is generated: decompose
  the document into claims and verify each claim is supported by a ledger fact. Any
  unsupported claim **blocks** the document from becoming submission-eligible and is surfaced
  to the user with the offending sentence highlighted. Be deterministic where possible
  (employers, titles, dates, numbers must match a fact exactly); an LLM may judge paraphrase
  fidelity, but an LLM "looks fine" never overrides a failed deterministic check. Err toward
  flagging — a false positive is cheap; a fabricated credential is not.

Create `src/types/facts-ledger.ts` with **exactly** this content:

```typescript
// src/types/facts-ledger.ts
//
// The closed set of TRUE, user-approved claims. Document generation may not exceed it.

export type FactType =
  | "employment"
  | "education"
  | "certification"
  | "skill"
  | "achievement"
  | "metric"
  | "language"
  | "summary_point"
  | "contact";

export interface BaseFact {
  id: string;
  type: FactType;
  /** User-confirmed. Only approved facts may be used in generated documents. */
  approved: boolean;
  /** The resume span this came from, for audit. */
  sourceText?: string;
}

export interface EmploymentFact extends BaseFact {
  type: "employment";
  employer: string;
  title: string;
  startDate: string; // ISO or "YYYY-MM"
  endDate: string | "present";
  location?: string;
  /** Approved accomplishment statements. */
  bullets: string[];
}

export interface EducationFact extends BaseFact {
  type: "education";
  institution: string;
  degree: string;
  field?: string;
  graduationDate?: string;
}

export interface CertificationFact extends BaseFact {
  type: "certification";
  name: string;
  issuer?: string;
  /** Omit if in progress; never imply completion of an unfinished certification. */
  dateEarned?: string;
  inProgress?: boolean;
}

export interface MetricFact extends BaseFact {
  type: "metric";
  statement: string; // e.g. "reviewed ~120 EDD cases per quarter"
  value?: number;
  unit?: string;
}

export interface GenericFact extends BaseFact {
  type: "skill" | "achievement" | "language" | "summary_point" | "contact";
  statement: string;
}

export type Fact =
  | EmploymentFact
  | EducationFact
  | CertificationFact
  | MetricFact
  | GenericFact;

export interface FactsLedger {
  profileId: string;
  /** Closed set; generation may not exceed it. */
  facts: Fact[];
  approvedAt?: string;
}
```

Create `src/generation/ledger-check.ts` with **exactly** this content:

```typescript
// src/generation/ledger-check.ts
//
// Verifies a generated document asserts nothing outside the approved facts ledger.

import type { FactsLedger } from "../types/facts-ledger";

export interface Claim {
  text: string;
}

export interface ClaimCheck {
  claim: Claim;
  supported: boolean;
  supportingFactId?: string;
  reason: string;
}

export interface LedgerCheckResult {
  /** false if ANY claim is unsupported. */
  passed: boolean;
  checks: ClaimCheck[];
}

export interface LedgerVerifier {
  /**
   * Deterministic gate first: every named entity, date, and number in the document must
   * match an approved fact. An LLM may then judge paraphrase fidelity for prose claims, but
   * MUST NOT override a failed deterministic check. Unmatched -> supported:false -> blocks.
   */
  verify(documentText: string, ledger: FactsLedger): Promise<LedgerCheckResult>;
}
```

---

### Module 3 — Job Discovery & Matching

- **Sources:** job boards/aggregators (LinkedIn, Indeed, etc.) and employer career pages.
- **Method:** run discovery in a **headed browser using the user's OWN persistent, manually
  logged-in session** (a saved Playwright browser profile the user signs into once). The app
  reads pages the user is authenticated to see. It MUST NOT rotate proxies, spoof device
  fingerprints, or otherwise evade anti-bot systems. On any block, rate-limit, or CAPTCHA:
  stop that source for the session, notify the user, and pause.
- **Throttling / account safety:** pace all browsing like a human — randomized multi-second
  delays between actions, no parallel tabs hitting one site, a hard cap on pages/searches per
  site per hour, and a daily ceiling. In setup, warn the user that automating a personal
  account risks that account being rate-limited or restricted by the platform, and let them
  choose which account to use. Never retry aggressively after a block.
- **Per posting:** extract requirements; score fit against the profile and the ledger (rules
  + LLM); explain the match; flag knockout mismatches (clearance required,
  sponsorship-ineligible, wrong location).
- **Resolve each match to the employer's OWN career-page apply URL.** Skip
  "Easy Apply"/"Apply on [aggregator]" (those apply through the aggregator and violate
  constraint #2). Discard listings with no off-aggregator apply route.
- Isolate each aggregator's selectors in its own small, easily-replaceable adapter, since
  their layouts change frequently. Treat discovery as best-effort, never guaranteed.

---

### Module 4 — ATS Adapter Layer

Create `src/ats/adapter.ts` with **exactly** this content:

```typescript
// src/ats/adapter.ts
//
// ATS field-mapping layer: binds the clean profile enums to a live career-page form.
// This is the brittle, site-specific core of the app. Three concerns live here:
//   1. AtsAdapter      - per-ATS DOM knowledge: detect, enumerate fields, set/read a value,
//                        find the submit control, detect a human-verification challenge.
//   2. FieldMatcher    - resolve a rendered field to a profile value, with confidence +
//                        provenance. Layered: deterministic -> fuzzy -> LLM (last resort).
//   3. decideFillAction- risk-weighted gate that turns (match, mode, confidence) into an
//                        action. This is where "pause vs fill" is wired in.
//
// HARD RULES (enforced in decideFillAction):
//   - self_id and authorization values are NEVER auto-submitted unless user-confirmed
//     (source === "user"). Otherwise they pause, regardless of confidence or mode.
//   - An LLM-proposed match never clears a high-stakes or knockout field unattended.
//   - A required field with no resolved value always pauses. Never guess.
//   - manual mode never fills anything.

import type { ApplicantProfile, Answer, DynamicQA } from "../types/applicant-profile";

// ----------------------------------------------------------------------------------------
// Enums
// ----------------------------------------------------------------------------------------

export type OperatingMode = "manual" | "semi_auto" | "auto";

export type MatchMethod =
  | "exact" // deterministic exact key/label/option match -> confidence 1.0
  | "synonym" // per-ATS curated synonym map
  | "fuzzy" // string-similarity match
  | "llm" // model-proposed mapping (lowest trust)
  | "unmapped"; // no value found

/** The consequence tier of getting a field wrong — drives the gate, not raw confidence. */
export type FieldRisk =
  | "self_id" // EEO / veteran / disability -> wrong value = misrepresentation
  | "authorization" // work auth / sponsorship -> misrepresentation / wasted application
  | "knockout" // gating screening Q (18+, essential functions, clearance, prior employment)
  | "identity" // name/email/phone/address -> low ambiguity, must be exact
  | "compensation"
  | "low_stakes"; // "how did you hear about us", optional free-text

/** Control types the setter must handle differently. */
export type ControlType =
  | "text"
  | "textarea"
  | "number"
  | "email"
  | "phone"
  | "native_select" // real <select>
  | "custom_select" // div/role=listbox fake dropdown
  | "typeahead" // async dropdown: type, await results, click the match
  | "radio_group"
  | "checkbox"
  | "multi_checkbox"
  | "date"
  | "file_upload"
  | "url"
  | "unknown";

export type FillAction =
  | "fill" // set the value, then verify via readback
  | "fill_then_flag" // set it, but mark for human attention at the review gate
  | "pause_for_confirmation" // do NOT set; surface to the human and ask
  | "skip"; // leave blank (optional field, no value)

// ----------------------------------------------------------------------------------------
// Field + match descriptors
// ----------------------------------------------------------------------------------------

export interface FormField {
  /** Stable handle the adapter uses to act on the control (selector, a11y ref, etc.). */
  ref: string;
  /** Visible label / aria-label, exactly as rendered. */
  label: string;
  controlType: ControlType;
  required: boolean;
  /** For selects/radios/checkboxes: the options exactly as rendered (for matching). */
  options?: string[];
  /** Current on-page value, used for readback verification. */
  currentValue?: string | string[] | null;
  /** Which wizard step/section this field belongs to (multi-step forms). */
  step?: number;
}

export interface MatchResult {
  field: FormField;
  risk: FieldRisk;
  /** Value to enter, already mapped to the rendered option string(s) for selects. */
  resolvedValue: string | string[] | null;
  /** Provenance of the underlying profile answer, carried through to the gate. */
  source: Answer<unknown>["source"] | "dynamic_qa" | "none";
  method: MatchMethod;
  /** 0..1. Deterministic exact match = 1.0. */
  confidence: number;
  /** Human-readable reason, for the audit log and the review-gate UI. */
  rationale: string;
}

// ----------------------------------------------------------------------------------------
// Adapter + page abstraction
// ----------------------------------------------------------------------------------------

/** Thin wrapper over the live Playwright page/frame, so adapters stay testable. */
export interface PageContext {
  url: string;
  // Implementation wraps Playwright (query, click, type, selectOption, frames, etc.).
}

export interface AtsAdapter {
  /** Stable id, e.g. "greenhouse", "lever", "workday", "icims", "generic_fallback". */
  readonly name: string;

  /** True if this adapter recognizes the current page (URL patterns + DOM signatures). */
  detect(ctx: PageContext): Promise<boolean>;

  /** Enumerate the form's fields as a normalized list. Handles multi-step wizards. */
  getFields(ctx: PageContext): Promise<FormField[]>;

  /**
   * Set a value on a control. MUST dispatch whatever framework events the control needs
   * (a React-controlled input ignores a raw value assignment), and MUST handle typeaheads
   * by typing, awaiting the async list, and clicking the matching option.
   */
  setField(ctx: PageContext, field: FormField, value: string | string[]): Promise<void>;

  /** Re-read a control's value, for readback verification after setField. */
  readField(ctx: PageContext, field: FormField): Promise<string | string[] | null>;

  /** Locate the final submit control. Do NOT click it — the orchestrator gates submission. */
  findSubmitControl(ctx: PageContext): Promise<{ ref: string } | null>;

  /** Detect a CAPTCHA / human-verification challenge -> orchestrator surfaces the browser. */
  hasHumanChallenge(ctx: PageContext): Promise<boolean>;
}

// ----------------------------------------------------------------------------------------
// Matcher
// ----------------------------------------------------------------------------------------

/**
 * Resolves a rendered FormField to a profile value with confidence + provenance.
 *
 * Implement as a LAYERED matcher to control both error rate and LLM cost:
 *   1. deterministic synonym/exact map per ATS (confidence ~1.0, no model call)
 *   2. fuzzy string similarity against options/labels
 *   3. LLM proposal as a LAST resort
 * The LLM layer must never report confidence in the high band for self_id / authorization /
 * knockout fields — those should pause unless step 1 matched AND the value is user-confirmed.
 */
export interface FieldMatcher {
  classifyRisk(field: FormField): FieldRisk;
  match(
    field: FormField,
    profile: ApplicantProfile,
    dynamicAnswers: DynamicQA[]
  ): Promise<MatchResult>;
}

// ----------------------------------------------------------------------------------------
// Risk-weighted fill policy  (the "pause vs fill" decision, wired in)
// ----------------------------------------------------------------------------------------

export interface FillPolicyConfig {
  /** Tune to taste; these are conservative starting points. */
  highConfidence: number; // e.g. 0.90
  mediumConfidence: number; // e.g. 0.70
}

export const DEFAULT_POLICY: FillPolicyConfig = {
  highConfidence: 0.9,
  mediumConfidence: 0.7,
};

export function decideFillAction(
  m: MatchResult,
  mode: OperatingMode,
  cfg: FillPolicyConfig = DEFAULT_POLICY
): FillAction {
  if (mode === "manual") return "skip";

  const hasValue =
    m.resolvedValue !== null &&
    !(Array.isArray(m.resolvedValue) && m.resolvedValue.length === 0);

  // Never guess a required field we couldn't map; never fill an empty optional.
  if (m.field.required && !hasValue) return "pause_for_confirmation";
  if (!hasValue) return "skip";

  const userConfirmed = m.source === "user";
  const highStakes = m.risk === "self_id" || m.risk === "authorization";
  const gating = m.risk === "knockout";

  // Misrepresentation guard: unconfirmed high-stakes values never go in unattended.
  if (highStakes && !userConfirmed) {
    // auto: pause for the human. semi_auto: don't silently fill it from a default/inference —
    // flag so the human sets/confirms it at the gate.
    return mode === "auto" ? "pause_for_confirmation" : "fill_then_flag";
  }

  if (mode === "auto") {
    if (m.confidence < cfg.highConfidence) return "pause_for_confirmation";
    // Extra bar on stakes: no LLM-proposed match, must be user-confirmed.
    if ((highStakes || gating) && !userConfirmed) return "pause_for_confirmation";
    if ((highStakes || gating) && m.method === "llm") return "pause_for_confirmation";
    return "fill";
  }

  // semi_auto: fill confidently, flag the shaky ones; the review gate catches everything.
  if (m.confidence >= cfg.highConfidence) return "fill";
  if (m.confidence >= cfg.mediumConfidence) return "fill_then_flag";
  return "pause_for_confirmation";
}

// ----------------------------------------------------------------------------------------
// Fill loop  (match -> decide -> fill + verify readback -> escalate)
// ----------------------------------------------------------------------------------------

export interface FillReport {
  filled: MatchResult[];
  flaggedForReview: MatchResult[]; // fill_then_flag
  needsConfirmation: MatchResult[]; // pause_for_confirmation
  challengeDetected: boolean;
}

export async function fillApplication(
  adapter: AtsAdapter,
  matcher: FieldMatcher,
  ctx: PageContext,
  profile: ApplicantProfile,
  mode: OperatingMode,
  cfg: FillPolicyConfig = DEFAULT_POLICY
): Promise<FillReport> {
  const report: FillReport = {
    filled: [],
    flaggedForReview: [],
    needsConfirmation: [],
    challengeDetected: false,
  };

  // A challenge at any point means: stop, surface the live browser to the human.
  if (await adapter.hasHumanChallenge(ctx)) {
    report.challengeDetected = true;
    return report;
  }

  const fields = await adapter.getFields(ctx);

  for (const field of fields) {
    const m = await matcher.match(field, profile, profile.dynamicAnswers);
    const action = decideFillAction(m, mode, cfg);

    if (action === "skip") continue;
    if (action === "pause_for_confirmation") {
      report.needsConfirmation.push(m);
      continue;
    }

    // fill or fill_then_flag: set the value, then confirm it actually took.
    await adapter.setField(ctx, field, m.resolvedValue as string | string[]);
    const readback = await adapter.readField(ctx, field);

    if (!valuesEqual(readback, m.resolvedValue)) {
      // Event/controlled-component issue, or the wrong option was selected. Don't trust it.
      report.needsConfirmation.push({
        ...m,
        rationale: m.rationale + " | readback mismatch",
      });
      continue;
    }

    if (action === "fill_then_flag") report.flaggedForReview.push(m);
    else report.filled.push(m);

    // A challenge can appear mid-fill (e.g., after an email field).
    if (await adapter.hasHumanChallenge(ctx)) {
      report.challengeDetected = true;
      return report;
    }
  }

  return report;
}

/** AUTO may submit only if nothing needs a human and no challenge appeared. */
export function canAutoSubmit(report: FillReport, mode: OperatingMode): boolean {
  return (
    mode === "auto" &&
    !report.challengeDetected &&
    report.needsConfirmation.length === 0 &&
    report.flaggedForReview.length === 0
  );
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x) => b.includes(x));
  }
  return a === b;
}
```

Implementation notes:
- Implement the `AtsAdapter` for each ATS keyed by detection: **Greenhouse, Lever, Ashby,
  Workday, iCIMS, SmartRecruiters, SAP SuccessFactors, Taleo, Workable.**
- Implement the layered `FieldMatcher` (deterministic synonym/exact → fuzzy → LLM last
  resort). Keep the LLM path rarely-hit; on high-stakes/knockout fields the policy already
  refuses to trust it.
- Implement a `generic_fallback` adapter (accessibility tree + LLM field-mapping) for unknown
  ATS — inherently lower confidence, forces human review.
- `setField` must dispatch framework events and handle typeaheads, custom dropdowns, date
  pickers, and file uploads. `fillApplication` already verifies readback.
- **Build the Greenhouse adapter FIRST, end-to-end, before generalizing.**

---

### Module 5 — Document Generation

- Per job: from the **approved ledger only**, generate a tailored resume + cover letter
  optimized for the posting's requirements/keywords, in the user's voice (formal, clean,
  **no em-dashes**), output to ATS-friendly **PDF + DOCX** (single-column, parseable, no
  tables or text-boxes that break ATS parsers).
- Run the `LedgerVerifier` (Module 2) before a document becomes submission-eligible. A failed
  check blocks submission and surfaces the offending sentence to the user.

---

### Module 6 — Application Orchestrator + Review/Submit Gate

- Pipeline per job: discover → score → (if above threshold) generate docs → ledger-check →
  open career page → detect ATS → `fillApplication(mode)` → then:
  - **manual:** docs only, no fill.
  - **semi_auto (default):** everything filled per policy → PAUSE at the review gate →
    one-click human submit.
  - **auto:** submit only if `canAutoSubmit(report, mode)` is true; otherwise fall back to the
    review gate.
- **Review gate (dashboard):** show the filled form state, the generated resume/cover letter,
  the match rationale, the `LedgerCheckResult`, and every `needsConfirmation` /
  `flaggedForReview` field. The user edits/confirms, then submits.
- On `challengeDetected` at any point: surface the headed browser, notify the user, wait.
- Per-company rate limiting; **hard dedup** (never apply to the same job twice); cap
  applications per company per time window.

---

### Module 7 — Tracker & Audit

- Local pipeline view: discovered / matched / generated / submitted / needs-action, with
  timestamps, the exact documents sent, and the answers used. Export to CSV.
- Full audit log of every automated action (each `setField`, each pause, each submit), with
  the `MatchResult` rationale.

---

## 6. Build order (build and verify against ONE real posting before advancing)

1. **Module 1** (profile + wizard) and **Module 2** (ingestion + ledger + verifier).
   Validate parsing/approval, and validate the verifier on a known-good document AND a
   deliberately-fabricated one.
2. **Module 5** (generation) wired to the ledger + verifier. Validate document quality and
   that fabrications are caught — no browser yet.
3. **Module 4 Greenhouse adapter** end-to-end + **Module 6 review gate**, in `semi_auto`,
   against ONE real Greenhouse posting.
4. **Module 3** (discovery + matching) + **Module 7** (tracker).
5. Remaining ATS adapters + the generic fallback.
6. `auto` mode (allowlist, CAPTCHA-free), behind an explicit per-employer toggle.

---

## 7. Before you start, confirm with me

- The stack (or proceed with the recommended one).
- The app name.
- My target roles, locations, and compensation range (or extract defaults from my resume and
  confirm them with me).

**Stop and ask whenever** a required field isn't in my profile, a document fails the ledger
check, or a hard constraint would be violated. **Do not build all modules at once** —
implement the current milestone, then stop for me to run and verify it.
