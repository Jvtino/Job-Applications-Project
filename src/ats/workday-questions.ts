// src/ats/workday-questions.ts
//
// Workday question model — decides, for every enumerated Workday field, WHERE its answer comes from
// and, crucially, WHICH questions the app must ASK the user so it "knows what to click." A Workday
// application mixes three kinds of field:
//
//   1. Data-derivable — standard fields with stable `name` hooks (legalName--firstName, phoneNumber,
//      jobTitle, gender, veteranStatus, work-auth questions). Filled from the profile / approved
//      ledger, or routed through the existing risk gate (self-ID / work-auth / knockout).
//   2. Tenant-specific questions — opaque hex `name` ids (73a5111f…, de76965…) whose answers live in
//      NO profile (TD's previous-employment / relatives / PEP / gov-agency / employment-type /
//      language-proficiency / compensation questions). These the app must ASK, then REMEMBER: stored
//      as a DynamicQA keyed by normalized question text, so the same question auto-fills next time —
//      cross-tenant (src/profile/dynamic-qa.ts + the matcher's fallback already do the reuse).
//   3. Legal / documents — a Terms acceptance checkbox and a resume upload, NEVER auto-answered.
//
// This module is PURE: no DOM, no network, no PII. It classifies FormFields and produces the
// ask-the-user list. The live DOM enumeration (WorkdayAdapter.getFields) feeds it; the review gate /
// a proactive "Workday questions" screen consume the list; the answer bank stores the replies.

import type { FormField } from "./adapter";
import type { DynamicQA } from "../types/applicant-profile";
import { findDynamicAnswer, normalizeQuestionSignature } from "../profile/dynamic-qa";

export type WorkdayFieldSource =
  | "profile" // structured profile: identity, contact, address, links
  | "experience" // approved FactsLedger: work history, education, skills, spoken languages (Phase 3 bridge)
  | "self_id" // EEO: sex / race / veteran / disability — existing gate, user-confirmed only
  | "work_auth" // work authorization / sponsorship — existing gate
  | "knockout" // gating screening the profile wizard already models (18+, accommodation, non-compete)
  | "document" // file upload (resume / CV)
  | "terms" // legal acceptance checkbox — NEVER auto-checked
  | "ask_user"; // tenant-specific question with no mapping — ask + remember (cross-tenant by text)

/** Map an ATS control type onto the DynamicQA answer-bank field type. */
export function toDynamicFieldType(controlType: FormField["controlType"]): DynamicQA["fieldType"] {
  switch (controlType) {
    case "checkbox":
      return "boolean";
    case "multi_checkbox":
      return "multi_select";
    case "native_select":
    case "custom_select":
    case "radio_group":
    case "typeahead":
      return "single_select";
    case "number":
      return "number";
    default:
      return "text";
  }
}

// Workday refs look like `name`, `section--field`, `section-<index>--field` (repeating rows), or
// `prefix--<hexQuestionId>`. Split into the leading SECTION and trailing FIELD stem so classification
// is robust to the row index and to greedy label substrings.
function refSegments(ref: string): { section: string; stem: string } {
  const noIndex = ref.toLowerCase().replace(/-\d+--/g, "--"); // "workexperience-48--startdate" -> "workexperience--startdate"
  const segs = noIndex.split("--").filter(Boolean);
  return { section: segs[0] ?? noIndex, stem: segs[segs.length - 1] ?? noIndex };
}

const EXPERIENCE_SECTIONS = new Set(["workexperience", "education", "skills"]);
const EXPERIENCE_STEMS = new Set([
  "jobtitle", "companyname", "location", "currentlyworkhere", "roledescription",
  "school", "degree", "fieldofstudy", "language", "native", "skills",
]);
const PROFILE_STEMS = new Set([
  "firstname", "lastname", "name", "country", "countryregion", "addressline1",
  "city", "postalcode", "phonenumber", "countryphonecode", "extension",
  "preferredcheck", "linkedinaccount", "email",
]);

/**
 * Classify a single enumerated Workday field. Order matters: the safety-critical categories
 * (document, terms, self_id, work_auth) are decided FIRST so a broadly-worded tenant question can
 * never be mistaken for one — and vice versa. Ref segments are preferred over labels because a
 * tenant question's text can incidentally mention "company", "language", etc.
 */
export function classifyWorkdayField(field: FormField): WorkdayFieldSource {
  const label = (field.label || "").toLowerCase().trim();
  const ref = (field.ref || "").toLowerCase();
  const { section, stem } = refSegments(ref);

  // Documents — never auto-answered.
  if (field.controlType === "file_upload" || /\bupload (a )?file\b|attach (your )?(resume|cv)\b/.test(label)) {
    return "document";
  }

  // Legal acceptance — never auto-checked; the human accepts.
  if (/terms and conditions|i willingly accept|certification and agreement/.test(label) || /acceptterms|termsandagreement/.test(ref)) {
    return "terms";
  }

  // Self-ID / EEO — existing risk gate (fills only from a user-confirmed profile value).
  if (
    /\b(gender|sex)\b|race\s*\/?\s*ethnic|ethnicity|veteran|disab/.test(label) ||
    /(disabilitystatus|disabilityform|veteranstatus)/.test(ref) ||
    /(^|[-_])(gender|ethnicity)([-_]|$)/.test(ref)
  ) {
    return "self_id";
  }

  // Work authorization / sponsorship — existing gate.
  if (/authoriz(ed|ation)[^.]*(work|employ)|require sponsorship|sponsorship for[^.]*employment|work (visa|permit)|h-?1b/.test(label)) {
    return "work_auth";
  }

  // Gating screening the profile WIZARD already models -> existing knockout gate (else it pauses).
  if (/age of majority|at least 18|18 years old|reached the federal age/.test(label)) return "knockout";
  if (/reasonable accommodation/.test(label)) return "knockout";
  if (/\bpreviously (employed|worked)\b|currently employed by/.test(label)) return "knockout";
  if (/non-?compete/.test(label)) return "knockout";

  // Structured work history / education / skills / spoken language -> approved ledger (Phase 3).
  if (EXPERIENCE_SECTIONS.has(section) || EXPERIENCE_STEMS.has(stem)) return "experience";
  if (/^(job title|company|location|degree|field of study|role description|school or university)\*?$/.test(label)) return "experience";
  if (/^i (currently work here|am fluent)/.test(label) || /type to add skills/.test(label)) return "experience";

  // Identity / contact / links — structured profile.
  if (section === "phonenumber" || section === "legalname" || PROFILE_STEMS.has(stem)) return "profile";
  if (/datesignedon/.test(ref)) return "profile"; // CC-305 signature date (today)
  if (/^(first name|last name|preferred name|address line|city|state|postal code|country|country phone code|phone number|phone extension|name)\*?$/.test(label) || /linkedin/.test(label)) {
    return "profile";
  }

  // Everything else — a tenant-specific question with no mapping: ask the user, remember the answer.
  return "ask_user";
}

export interface WorkdayQuestion {
  field: FormField;
  source: WorkdayFieldSource;
  /** Normalized answer-bank key (DynamicQA convention) — cross-tenant reuse by question text. */
  key: string;
  /** Original phrasing, exactly as rendered (retained for audit + display). */
  questionText: string;
  fieldType: DynamicQA["fieldType"];
  required: boolean;
  step?: number;
  /** True when the answer bank already holds an answer for this question (reused, not re-asked). */
  remembered: boolean;
}

/**
 * The tenant-specific questions (source === "ask_user") on a Workday form, each with its answer-bank
 * key and whether a remembered answer already exists. Serves BOTH flows:
 *   - proactive: render the full list as a "Workday questions" form to answer up front;
 *   - reactive: filter to !remembered to see only what still needs asking during a fill.
 * (Self-ID / work-auth / knockout are handled by the profile wizard + risk gate, not re-asked here.)
 */
export function workdayQuestions(fields: FormField[], dynamicAnswers: DynamicQA[] = []): WorkdayQuestion[] {
  const out: WorkdayQuestion[] = [];
  for (const field of fields) {
    if (classifyWorkdayField(field) !== "ask_user") continue;
    const key = normalizeQuestionSignature(field.label);
    out.push({
      field,
      source: "ask_user",
      key,
      questionText: field.label,
      fieldType: toDynamicFieldType(field.controlType),
      required: field.required,
      ...(field.step !== undefined ? { step: field.step } : {}),
      remembered: Boolean(findDynamicAnswer(dynamicAnswers, field.label)),
    });
  }
  return out;
}

/** Just the ask_user questions that still need an answer (nothing remembered yet). */
export function workdayQuestionsToAsk(fields: FormField[], dynamicAnswers: DynamicQA[] = []): WorkdayQuestion[] {
  return workdayQuestions(fields, dynamicAnswers).filter((q) => !q.remembered);
}
