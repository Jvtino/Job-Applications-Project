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
// Strategic positioning
//   The candidate's own one-sentence answers to the three positioning questions: "What do I do?",
//   "Who do I do it for?", "What result do I produce?". This is GENERATION GUIDANCE, not a résumé
//   claim. It steers WHICH approved facts the LLM generator emphasizes and HOW it angles them; it
//   is never inserted verbatim as document content and never added to the verifier allowlist, so
//   the anti-fabrication gate still verifies every generated claim against the approved ledger.
//   Empty strings mean "unset". Stored in the (encrypted) profile blob like the rest of the answers.
// ----------------------------------------------------------------------------------------

export interface PositioningStatement {
  /** "What do I do?" — specific, e.g. "I catch financial-crime risks before they become regulatory problems". */
  whatIDo: string;
  /** "Who do I do it for?" — employer type / industry, e.g. "mid-to-large financial institutions". */
  whoIServe: string;
  /** "What result do I produce?" — the outcome they care about, not the task you perform. */
  whatResult: string;
  updatedAt: string; // ISO 8601
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
  /** Roles the user is actively targeting (from wizard, résumé ingest, or manual edit). */
  targetRoles: string[];
  /** Industries the user wants the matcher to favor, e.g. fintech, healthcare, climate. */
  targetIndustries: string[];
  /** Confirmed years of experience for quick filters and application questions. */
  yearsOfExperience?: number;
  /** Desired seniority band for matching and dashboard filtering. */
  jobLevel?: "entry" | "mid" | "senior" | "staff" | "lead" | "manager" | "director" | "executive";
  /** Preferred job arrangement. */
  employmentTypes: ("full_time" | "part_time" | "contract" | "temporary" | "internship")[];
  /** Company names/domains the user does not want surfaced or pursued. */
  companiesToAvoid: string[];
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

  /**
   * Optional strategic positioning (the three positioning questions). Drives document-generation
   * emphasis/voice; absent until the user fills it in. See PositioningStatement above.
   */
  positioning?: PositioningStatement;

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
