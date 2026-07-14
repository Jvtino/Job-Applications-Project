// src/server/profile-form.ts
//
// Bridges the flat, GUI-friendly profile form to the nested ApplicantProfile (and back). This is
// the in-app equivalent of the `setup` CLI wizard, so it follows the SAME provenance rule: any value
// the user supplies in the form is written as source:"user" (confirmed) — the gate treats those as
// auto-submittable; app defaults stay source:"default" and pause/flag. A BLANK field means "don't
// touch" (we never fabricate or downgrade a previously-confirmed answer). Voluntary self-ID supports
// "" (skip), "decline" (the explicit DECLINE marker), or a concrete value.

import {
  DECLINE,
  type Answer,
  type ApplicantProfile,
  type Decline,
  type DisabilityStatus,
  type EeoGender,
  type EeoRaceEthnicity,
  type ProtectedVeteranStatus,
  type Reference,
  type VeteranCategory,
} from "../types/applicant-profile";
import { normalizeQuestionSignature } from "../profile/dynamic-qa";
import { parseLocationList } from "../jobs/location-match";

export type YesNoBlank = "" | "yes" | "no";
export type WorkStatus = "" | "us_citizen" | "permanent_resident" | "visa_holder" | "other";
export type WorkMode = "remote" | "hybrid" | "onsite";
export type JobLevel = "" | "entry" | "mid" | "senior" | "staff" | "lead" | "manager" | "director" | "executive";
export type EmploymentType = "full_time" | "part_time" | "contract" | "temporary" | "internship";

export interface CustomAnswerForm {
  questionText: string;
  answer: string;
}

export interface ReferenceForm {
  name: string;
  relationship: string;
  company: string;
  email: string;
  phone: string;
}

/** Reserved free-text answers surfaced as their own Profile fields but persisted in dynamicAnswers
 *  (which the form-fill agent already consumes). Opt-in: blank = not provided. Criminal-history is
 *  never assumed, and since the live apply path is human-submit-only it is always reviewed before use. */
export const RESERVED_DYNAMIC_Q = {
  eligibility: "Work eligibility statement",
  criminalHistory: "Criminal history disclosure (voluntary)",
} as const;
const RESERVED_SIGNATURES = new Set(Object.values(RESERVED_DYNAMIC_Q).map(normalizeQuestionSignature));

export interface ProfileForm {
  legalFirstName: string;
  legalLastName: string;
  preferredName: string;
  email: string;
  phone: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  linkedin: string;
  github: string;
  portfolio: string;
  authorizedToWorkInUS: YesNoBlank;
  requiresSponsorship: YesNoBlank;
  currentWorkStatus: WorkStatus;
  earliestStartDate: string;
  noticePeriodDays: string;
  willingToRelocate: YesNoBlank;
  workModes: WorkMode[];
  targetRoles: string;
  targetIndustries: string;
  yearsOfExperience: string;
  companiesToAvoid: string;
  jobLevel: JobLevel;
  employmentTypes: EmploymentType[];
  desiredLocations: string;
  desiredBaseMin: string;
  desiredBaseMax: string;
  isNegotiable: boolean;
  customAnswers?: CustomAnswerForm[];
  /** Strategic positioning — the three positioning questions. All blank = leave untouched. */
  positioningWhatIDo: string;
  positioningWhoIServe: string;
  positioningWhatResult: string;
  isAtLeast18: YesNoBlank;
  canPerformEssentialFunctions: YesNoBlank;
  requiresAccommodationForProcess: YesNoBlank;
  /** "" = skip, "decline" = DECLINE, else the enum value. */
  gender: string;
  raceEthnicity: string;
  veteranStatus: string;
  disability: string;
  /** Reference contacts (provided to employers on request). */
  references: ReferenceForm[];
  /** Free-text citizenship / work-eligibility statement (optional). */
  eligibilityNote: string;
  /** Voluntary, opt-in criminal-history disclosure free text (optional; never assumed). */
  criminalHistoryDisclosure: string;
}

export const EMPTY_FORM: ProfileForm = {
  legalFirstName: "", legalLastName: "", preferredName: "", email: "", phone: "",
  addressLine1: "", addressLine2: "", city: "", state: "", postalCode: "",
  linkedin: "", github: "", portfolio: "",
  authorizedToWorkInUS: "", requiresSponsorship: "", currentWorkStatus: "",
  earliestStartDate: "", noticePeriodDays: "", willingToRelocate: "", workModes: [],
  targetRoles: "", targetIndustries: "", yearsOfExperience: "", companiesToAvoid: "", jobLevel: "", employmentTypes: [],
  desiredLocations: "", desiredBaseMin: "", desiredBaseMax: "", isNegotiable: true,
  customAnswers: [],
  positioningWhatIDo: "", positioningWhoIServe: "", positioningWhatResult: "",
  isAtLeast18: "", canPerformEssentialFunctions: "", requiresAccommodationForProcess: "",
  gender: "", raceEthnicity: "", veteranStatus: "", disability: "",
  references: [], eligibilityNote: "", criminalHistoryDisclosure: "",
};

const now = () => new Date().toISOString();
function userAnswer<T>(value: T | Decline | null): Answer<T> {
  return { value, source: "user", updatedAt: now() };
}
function boolFrom(v: YesNoBlank): boolean | undefined {
  return v === "yes" ? true : v === "no" ? false : undefined;
}

const WORK_MODES: WorkMode[] = ["remote", "hybrid", "onsite"];
const EMPLOYMENT_TYPES: EmploymentType[] = ["full_time", "part_time", "contract", "temporary", "internship"];
const JOB_LEVELS: JobLevel[] = ["", "entry", "mid", "senior", "staff", "lead", "manager", "director", "executive"];

/** Build a complete ProfileForm from arbitrary JSON (defensive: missing fields default to blank). */
export function coerceForm(raw: Record<string, unknown>): ProfileForm {
  const s = (k: keyof ProfileForm): string => (typeof raw[k] === "string" ? (raw[k] as string) : "");
  const modes = Array.isArray(raw.workModes)
    ? (raw.workModes.filter((m): m is WorkMode => WORK_MODES.includes(m as WorkMode)))
    : [];
  const employmentTypes = Array.isArray(raw.employmentTypes)
    ? (raw.employmentTypes.filter((m): m is EmploymentType => EMPLOYMENT_TYPES.includes(m as EmploymentType)))
    : [];
  const customAnswers = Array.isArray(raw.customAnswers)
    ? raw.customAnswers
        .map((item): CustomAnswerForm | null => {
          if (!item || typeof item !== "object") return null;
          const row = item as Record<string, unknown>;
          const questionText = typeof row.questionText === "string" ? row.questionText.trim() : "";
          const answer = typeof row.answer === "string" ? row.answer.trim() : "";
          return questionText || answer ? { questionText, answer } : null;
        })
        .filter((item): item is CustomAnswerForm => Boolean(item))
    : undefined;
  return {
    ...EMPTY_FORM,
    legalFirstName: s("legalFirstName"), legalLastName: s("legalLastName"), preferredName: s("preferredName"),
    email: s("email"), phone: s("phone"),
    addressLine1: s("addressLine1"), addressLine2: s("addressLine2"), city: s("city"), state: s("state"), postalCode: s("postalCode"),
    linkedin: s("linkedin"), github: s("github"), portfolio: s("portfolio"),
    authorizedToWorkInUS: s("authorizedToWorkInUS") as YesNoBlank,
    requiresSponsorship: s("requiresSponsorship") as YesNoBlank,
    currentWorkStatus: s("currentWorkStatus") as WorkStatus,
    earliestStartDate: s("earliestStartDate"), noticePeriodDays: s("noticePeriodDays"),
    willingToRelocate: s("willingToRelocate") as YesNoBlank,
    workModes: modes,
    targetRoles: s("targetRoles"),
    targetIndustries: s("targetIndustries"),
    yearsOfExperience: s("yearsOfExperience"),
    companiesToAvoid: s("companiesToAvoid"),
    jobLevel: JOB_LEVELS.includes(s("jobLevel") as JobLevel) ? (s("jobLevel") as JobLevel) : "",
    employmentTypes,
    desiredLocations: s("desiredLocations"), desiredBaseMin: s("desiredBaseMin"), desiredBaseMax: s("desiredBaseMax"),
    isNegotiable: typeof raw.isNegotiable === "boolean" ? raw.isNegotiable : true,
    ...(customAnswers !== undefined ? { customAnswers } : {}),
    positioningWhatIDo: s("positioningWhatIDo"), positioningWhoIServe: s("positioningWhoIServe"), positioningWhatResult: s("positioningWhatResult"),
    isAtLeast18: s("isAtLeast18") as YesNoBlank,
    canPerformEssentialFunctions: s("canPerformEssentialFunctions") as YesNoBlank,
    requiresAccommodationForProcess: s("requiresAccommodationForProcess") as YesNoBlank,
    gender: s("gender"), raceEthnicity: s("raceEthnicity"), veteranStatus: s("veteranStatus"), disability: s("disability"),
    references: Array.isArray(raw.references)
      ? raw.references
          .map((item): ReferenceForm | null => {
            if (!item || typeof item !== "object") return null;
            const r = item as Record<string, unknown>;
            const str = (k: string) => (typeof r[k] === "string" ? (r[k] as string).trim() : "");
            const ref: ReferenceForm = { name: str("name"), relationship: str("relationship"), company: str("company"), email: str("email"), phone: str("phone") };
            return ref.name || ref.relationship || ref.company || ref.email || ref.phone ? ref : null;
          })
          .filter((r): r is ReferenceForm => Boolean(r))
      : [],
    eligibilityNote: s("eligibilityNote"),
    criminalHistoryDisclosure: s("criminalHistoryDisclosure"),
  };
}

function setOptionalString(obj: Record<string, unknown>, key: string, value: string): void {
  const v = value.trim();
  if (v) obj[key] = v;
  else delete obj[key];
}

/** Apply form values onto a profile, marking everything the user supplied as source:"user". */
export function applyFormToProfile(base: ApplicantProfile, f: ProfileForm): ApplicantProfile {
  const p = base;

  // -- Contact (required fields are set verbatim; optionals cleared when blank) --
  const c = p.contact;
  c.legalFirstName = f.legalFirstName.trim();
  c.legalLastName = f.legalLastName.trim();
  setOptionalString(c as unknown as Record<string, unknown>, "preferredName", f.preferredName);
  c.email = f.email.trim();
  c.phone = f.phone.trim();
  c.address.line1 = f.addressLine1.trim();
  setOptionalString(c.address as unknown as Record<string, unknown>, "line2", f.addressLine2);
  c.address.city = f.city.trim();
  c.address.state = f.state.trim();
  c.address.postalCode = f.postalCode.trim();
  c.address.country = "US";
  setOptionalString(c.links as unknown as Record<string, unknown>, "linkedin", f.linkedin);
  setOptionalString(c.links as unknown as Record<string, unknown>, "github", f.github);
  setOptionalString(c.links as unknown as Record<string, unknown>, "portfolio", f.portfolio);

  // -- Work authorization -- (only overwrite when the user made a choice)
  const wa = p.workAuthorization;
  const auth = boolFrom(f.authorizedToWorkInUS);
  if (auth !== undefined) wa.authorizedToWorkInUS = userAnswer<boolean>(auth);
  const spon = boolFrom(f.requiresSponsorship);
  if (spon !== undefined) wa.requiresSponsorshipNowOrFuture = userAnswer<boolean>(spon);
  if (f.currentWorkStatus) wa.currentWorkStatus = userAnswer(f.currentWorkStatus);

  // -- Preferences --
  const pr = p.preferences;
  if (f.earliestStartDate.trim()) pr.earliestStartDate = userAnswer<string>(f.earliestStartDate.trim());
  if (f.noticePeriodDays.trim() !== "" && Number.isFinite(Number(f.noticePeriodDays))) {
    pr.noticePeriodDays = userAnswer<number>(Math.max(0, Math.round(Number(f.noticePeriodDays))));
  }
  const relo = boolFrom(f.willingToRelocate);
  if (relo !== undefined) pr.willingToRelocate = userAnswer<boolean>(relo);
  if (f.workModes.length) pr.workModePreference = userAnswer<WorkMode[]>(f.workModes);
  pr.targetRoles = f.targetRoles.split(",").map((x) => x.trim()).filter(Boolean);
  pr.targetIndustries = f.targetIndustries.split(",").map((x) => x.trim()).filter(Boolean);
  const years = Number(f.yearsOfExperience);
  if (f.yearsOfExperience.trim() && Number.isFinite(years) && years >= 0) pr.yearsOfExperience = Math.round(years);
  else delete pr.yearsOfExperience;
  if (f.jobLevel) pr.jobLevel = f.jobLevel;
  else delete pr.jobLevel;
  pr.employmentTypes = f.employmentTypes;
  pr.companiesToAvoid = f.companiesToAvoid.split(",").map((x) => x.trim()).filter(Boolean);
  pr.desiredLocations = parseLocationList(f.desiredLocations);
  pr.compensation.currency = "USD";
  const min = Number(f.desiredBaseMin);
  const max = Number(f.desiredBaseMax);
  if (f.desiredBaseMin.trim() && Number.isFinite(min) && min > 0) pr.compensation.desiredBaseMin = Math.round(min);
  else delete pr.compensation.desiredBaseMin;
  if (f.desiredBaseMax.trim() && Number.isFinite(max) && max > 0) pr.compensation.desiredBaseMax = Math.round(max);
  else delete pr.compensation.desiredBaseMax;
  pr.compensation.isNegotiable = f.isNegotiable;

  // -- Strategic positioning -- (the three fields are one unit; ALL blank = leave untouched so we
  // never wipe a previously-saved positioning the user simply didn't edit this time.)
  const whatIDo = f.positioningWhatIDo.trim();
  const whoIServe = f.positioningWhoIServe.trim();
  const whatResult = f.positioningWhatResult.trim();
  if (whatIDo || whoIServe || whatResult) {
    p.positioning = { whatIDo, whoIServe, whatResult, updatedAt: now() };
  }

  // -- Screening --
  const sc = p.screening;
  const a18 = boolFrom(f.isAtLeast18);
  if (a18 !== undefined) sc.isAtLeast18 = userAnswer<boolean>(a18);
  const cef = boolFrom(f.canPerformEssentialFunctions);
  if (cef !== undefined) sc.canPerformEssentialFunctions = userAnswer<boolean>(cef);
  const racc = boolFrom(f.requiresAccommodationForProcess);
  if (racc !== undefined) sc.requiresAccommodationForProcess = userAnswer<boolean>(racc);

  // -- Voluntary self-identification -- ("" skip, "decline" -> DECLINE, else value)
  const sid = p.selfId;
  if (f.gender) sid.gender = userAnswer<EeoGender>(f.gender === "decline" ? DECLINE : (f.gender as EeoGender));
  if (f.raceEthnicity) sid.raceEthnicity = userAnswer<EeoRaceEthnicity>(f.raceEthnicity === "decline" ? DECLINE : (f.raceEthnicity as EeoRaceEthnicity));
  if (f.disability) sid.disability = userAnswer<DisabilityStatus>(f.disability === "decline" ? DECLINE : (f.disability as DisabilityStatus));
  if (f.veteranStatus) {
    if (f.veteranStatus === "decline") {
      sid.veteran.status = userAnswer<ProtectedVeteranStatus>(DECLINE);
      sid.veteran.categories = userAnswer<VeteranCategory[]>(DECLINE);
    } else {
      const vs = f.veteranStatus as ProtectedVeteranStatus;
      sid.veteran.status = userAnswer<ProtectedVeteranStatus>(vs);
      // Simple yes/no form only here; mirror "not a veteran" into an empty category list.
      if (vs === "not_protected_veteran") sid.veteran.categories = userAnswer([]);
    }
  }

  // -- References (provided to employers on request) --
  p.references = f.references
    .map((r) => {
      const ref: Reference = { name: r.name.trim(), relationship: r.relationship.trim() };
      if (r.company.trim()) ref.company = r.company.trim();
      if (r.email.trim()) ref.email = r.email.trim();
      if (r.phone.trim()) ref.phone = r.phone.trim();
      return ref;
    })
    .filter((r) => r.name || r.relationship);

  // -- Dynamic answers: custom answers (when the form sent them) plus the reserved free-text fields
  // (eligibility, criminal history). Reserved entries live behind their own Profile fields and are
  // never duplicated into the custom-answers list; blank reserved fields are omitted (opt-in). --
  const reserved: ApplicantProfile["dynamicAnswers"] = [];
  const pushReserved = (questionText: string, value: string) => {
    const answer = value.trim();
    if (answer) reserved.push({ key: normalizeQuestionSignature(questionText), questionText, fieldType: "text", answer, updatedAt: now() });
  };
  pushReserved(RESERVED_DYNAMIC_Q.eligibility, f.eligibilityNote);
  pushReserved(RESERVED_DYNAMIC_Q.criminalHistory, f.criminalHistoryDisclosure);
  const baseDynamic =
    f.customAnswers !== undefined
      ? f.customAnswers
          .map((entry) => {
            const questionText = entry.questionText.trim();
            const answer = entry.answer.trim();
            if (!questionText || !answer) return null;
            const key = normalizeQuestionSignature(questionText);
            if (RESERVED_SIGNATURES.has(key)) return null;
            return { key, questionText, fieldType: "text" as const, answer, updatedAt: now() };
          })
          .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      : p.dynamicAnswers.filter((d) => !RESERVED_SIGNATURES.has(d.key));
  p.dynamicAnswers = [...baseDynamic, ...reserved];

  p.updatedAt = now();
  return p;
}

function boolToStr(a: Answer<boolean> | undefined): YesNoBlank {
  return a?.value === true ? "yes" : a?.value === false ? "no" : "";
}
function selfIdToStr(a: Answer<string> | undefined): string {
  return a?.value === DECLINE ? "decline" : a?.value == null ? "" : String(a.value);
}

/** Extract a flat, editable form from a profile (for GET /api/profile). */
export function profileToForm(p: ApplicantProfile): ProfileForm {
  const c = p.contact;
  const pr = p.preferences;
  const sc = p.screening;
  const sid = p.selfId;
  const reservedAnswer = (q: string): string => {
    const sig = normalizeQuestionSignature(q);
    const found = p.dynamicAnswers.find((d) => d.key === sig);
    return found && typeof found.answer === "string" && found.answer !== DECLINE ? found.answer : "";
  };
  return {
    legalFirstName: c.legalFirstName, legalLastName: c.legalLastName, preferredName: c.preferredName ?? "",
    email: c.email, phone: c.phone,
    addressLine1: c.address.line1, addressLine2: c.address.line2 ?? "", city: c.address.city, state: c.address.state, postalCode: c.address.postalCode,
    linkedin: c.links.linkedin ?? "", github: c.links.github ?? "", portfolio: c.links.portfolio ?? "",
    authorizedToWorkInUS: boolToStr(p.workAuthorization.authorizedToWorkInUS),
    requiresSponsorship: boolToStr(p.workAuthorization.requiresSponsorshipNowOrFuture),
    currentWorkStatus: (p.workAuthorization.currentWorkStatus?.value === DECLINE || p.workAuthorization.currentWorkStatus?.value == null
      ? ""
      : (p.workAuthorization.currentWorkStatus!.value as WorkStatus)),
    earliestStartDate: pr.earliestStartDate.value && pr.earliestStartDate.value !== DECLINE ? String(pr.earliestStartDate.value) : "",
    noticePeriodDays: typeof pr.noticePeriodDays.value === "number" ? String(pr.noticePeriodDays.value) : "",
    willingToRelocate: boolToStr(pr.willingToRelocate),
    workModes: Array.isArray(pr.workModePreference.value) ? pr.workModePreference.value : [],
    targetRoles: pr.targetRoles.join(", "),
    targetIndustries: (pr.targetIndustries ?? []).join(", "),
    yearsOfExperience: pr.yearsOfExperience !== undefined ? String(pr.yearsOfExperience) : "",
    companiesToAvoid: (pr.companiesToAvoid ?? []).join(", "),
    jobLevel: (pr.jobLevel ?? "") as JobLevel,
    employmentTypes: pr.employmentTypes ?? [],
    desiredLocations: pr.desiredLocations.join(", "),
    desiredBaseMin: pr.compensation.desiredBaseMin ? String(pr.compensation.desiredBaseMin) : "",
    desiredBaseMax: pr.compensation.desiredBaseMax ? String(pr.compensation.desiredBaseMax) : "",
    isNegotiable: pr.compensation.isNegotiable,
    positioningWhatIDo: p.positioning?.whatIDo ?? "",
    positioningWhoIServe: p.positioning?.whoIServe ?? "",
    positioningWhatResult: p.positioning?.whatResult ?? "",
    isAtLeast18: boolToStr(sc.isAtLeast18),
    canPerformEssentialFunctions: boolToStr(sc.canPerformEssentialFunctions),
    requiresAccommodationForProcess: boolToStr(sc.requiresAccommodationForProcess),
    gender: selfIdToStr(sid.gender),
    raceEthnicity: selfIdToStr(sid.raceEthnicity),
    veteranStatus: selfIdToStr(sid.veteran.status),
    disability: selfIdToStr(sid.disability),
    customAnswers: p.dynamicAnswers
      .filter((answer) => answer.answer !== null && !Array.isArray(answer.answer) && !RESERVED_SIGNATURES.has(answer.key))
      .map((answer) => ({
        questionText: answer.questionText,
        answer: answer.answer === DECLINE ? "Decline to answer" : String(answer.answer),
      })),
    references: p.references.map((r) => ({
      name: r.name,
      relationship: r.relationship,
      company: r.company ?? "",
      email: r.email ?? "",
      phone: r.phone ?? "",
    })),
    eligibilityNote: reservedAnswer(RESERVED_DYNAMIC_Q.eligibility),
    criminalHistoryDisclosure: reservedAnswer(RESERVED_DYNAMIC_Q.criminalHistory),
  };
}
