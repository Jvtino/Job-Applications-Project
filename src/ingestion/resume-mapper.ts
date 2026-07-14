// Maps structured resume JSON into ApplyPilot's editable profile form.
//
// The mapper keeps existing user data unless the field is blank. Conflicts are surfaced as
// uncertain fields so the review screen can ask the user to make an explicit choice.

import { EMPTY_FORM, type ProfileForm } from "../server/profile-form";
import type { ParsedResumeData } from "./structured-resume";

export interface ResumeFieldIssue {
  field: string;
  label: string;
  message: string;
}

export interface ResumeMappingResult {
  mappedData: ProfileForm;
  missingFields: ResumeFieldIssue[];
  uncertainFields: ResumeFieldIssue[];
  validationErrors: ResumeFieldIssue[];
}

type StringField = Exclude<keyof ProfileForm, "workModes" | "employmentTypes" | "customAnswers" | "isNegotiable" | "references">;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const APP_FIELD_LABELS: Record<keyof ProfileForm, string> = {
  legalFirstName: "Legal first name",
  legalLastName: "Legal last name",
  preferredName: "Preferred name",
  email: "Email",
  phone: "Phone",
  addressLine1: "Address line 1",
  addressLine2: "Address line 2",
  city: "City",
  state: "State",
  postalCode: "ZIP / postal code",
  linkedin: "LinkedIn URL",
  github: "GitHub URL",
  portfolio: "Portfolio URL",
  authorizedToWorkInUS: "Authorized to work in the US",
  requiresSponsorship: "Requires sponsorship",
  currentWorkStatus: "Current work status",
  earliestStartDate: "Earliest start",
  noticePeriodDays: "Notice period",
  willingToRelocate: "Willing to relocate",
  workModes: "Work mode",
  targetRoles: "Target roles",
  targetIndustries: "Target industries",
  yearsOfExperience: "Years of experience",
  companiesToAvoid: "Companies to avoid",
  jobLevel: "Job level",
  employmentTypes: "Employment type",
  desiredLocations: "Desired locations",
  desiredBaseMin: "Desired base minimum",
  desiredBaseMax: "Desired base maximum",
  isNegotiable: "Compensation negotiable",
  customAnswers: "Custom answers",
  positioningWhatIDo: "Positioning: what I do",
  positioningWhoIServe: "Positioning: who I serve",
  positioningWhatResult: "Positioning: result",
  isAtLeast18: "At least 18 years old",
  canPerformEssentialFunctions: "Can perform essential functions",
  requiresAccommodationForProcess: "Needs accommodation",
  gender: "Gender",
  raceEthnicity: "Race / ethnicity",
  veteranStatus: "Veteran status",
  disability: "Disability",
  references: "Reference contacts",
  eligibilityNote: "Work eligibility statement",
  criminalHistoryDisclosure: "Criminal history disclosure",
};

const REQUIRED_PROFILE_FIELDS: StringField[] = ["legalFirstName", "legalLastName", "email", "phone"];
const URL_FIELDS: StringField[] = ["linkedin", "github", "portfolio"];
const CHECKED_FIELDS = Object.keys(APP_FIELD_LABELS) as (keyof ProfileForm)[];

export function mapResumeDataToAppFields(
  parsedResumeData: ParsedResumeData,
  opts: { existingForm?: ProfileForm } = {}
): ResumeMappingResult {
  const mappedData = cloneForm(opts.existingForm ?? EMPTY_FORM);
  const uncertainFields: ResumeFieldIssue[] = [];

  const personal = parsedResumeData.personal_information;
  const name = splitName(personal.full_name);
  setStringIfBlank(mappedData, uncertainFields, "legalFirstName", name.first, "resume full name");
  setStringIfBlank(mappedData, uncertainFields, "legalLastName", name.last, "resume full name");
  setStringIfBlank(mappedData, uncertainFields, "preferredName", name.preferred, "resume full name");
  setStringIfBlank(mappedData, uncertainFields, "email", personal.email, "resume contact");
  setStringIfBlank(mappedData, uncertainFields, "phone", personal.phone, "resume contact");

  const loc = splitLocation(personal.location);
  setStringIfBlank(mappedData, uncertainFields, "city", loc.city, "resume location");
  setStringIfBlank(mappedData, uncertainFields, "state", loc.state, "resume location");
  setStringIfBlank(mappedData, uncertainFields, "linkedin", cleanUrl(personal.linkedin), "resume contact");
  setStringIfBlank(mappedData, uncertainFields, "github", cleanUrl(personal.github), "resume contact");
  setStringIfBlank(mappedData, uncertainFields, "portfolio", cleanUrl(personal.portfolio), "resume contact");
  for (const link of personal.other_links.map(cleanUrl)) {
    if (/linkedin\.com/i.test(link)) setStringIfBlank(mappedData, uncertainFields, "linkedin", link, "resume contact");
    else if (/github\.com/i.test(link)) setStringIfBlank(mappedData, uncertainFields, "github", link, "resume contact");
    else setStringIfBlank(mappedData, uncertainFields, "portfolio", link, "resume contact");
  }

  const roles = uniqueStrings(parsedResumeData.work_experience.map((job) => job.job_title).filter(Boolean));
  if (roles.length) setStringIfBlank(mappedData, uncertainFields, "targetRoles", roles.slice(0, 6).join(", "), "work history");
  if (parsedResumeData.professional_summary.trim()) {
    setStringIfBlank(
      mappedData,
      uncertainFields,
      "positioningWhatIDo",
      firstSentence(parsedResumeData.professional_summary),
      "professional summary"
    );
  }

  for (const item of parsedResumeData.missing_or_uncertain_information) {
    uncertainFields.push({
      field: "resume.missing_or_uncertain_information",
      label: "Resume uncertainty",
      message: item,
    });
  }

  const missingFields = missingProfileFields(mappedData);
  const validationErrors = validateMappedResume(parsedResumeData, mappedData);
  return { mappedData, missingFields, uncertainFields, validationErrors };
}

function setStringIfBlank(
  form: ProfileForm,
  uncertain: ResumeFieldIssue[],
  field: StringField,
  rawValue: string | undefined,
  source: string
): void {
  const value = (rawValue ?? "").trim();
  if (!value) return;
  const current = String(form[field] ?? "").trim();
  if (!current) {
    (form as Record<StringField, string>)[field] = value;
    return;
  }
  if (norm(current) !== norm(value)) {
    uncertain.push({
      field,
      label: APP_FIELD_LABELS[field],
      message: `${source} says "${value}", but the saved profile already has "${current}". Saved value kept until you confirm a change.`,
    });
  }
}

function missingProfileFields(form: ProfileForm): ResumeFieldIssue[] {
  const out: ResumeFieldIssue[] = [];
  for (const field of CHECKED_FIELDS) {
    if (field === "isNegotiable") continue;
    const value = form[field];
    const missing = Array.isArray(value) ? value.length === 0 : String(value ?? "").trim() === "";
    if (missing) {
      out.push({
        field,
        label: APP_FIELD_LABELS[field],
        message: "Not found in the resume or still blank after mapping.",
      });
    }
  }
  return out;
}

export function validateMappedResume(
  parsed: ParsedResumeData,
  form: ProfileForm
): ResumeFieldIssue[] {
  const errors: ResumeFieldIssue[] = [];
  for (const field of REQUIRED_PROFILE_FIELDS) {
    if (!String(form[field] ?? "").trim()) {
      errors.push({ field, label: APP_FIELD_LABELS[field], message: "Required before import." });
    }
  }
  if (form.email.trim() && !EMAIL.test(form.email.trim())) {
    errors.push({ field: "email", label: APP_FIELD_LABELS.email, message: "Email does not look valid." });
  }
  if (form.phone.trim() && form.phone.replace(/\D/g, "").length < 10) {
    errors.push({ field: "phone", label: APP_FIELD_LABELS.phone, message: "Phone number does not look complete." });
  }
  for (const field of URL_FIELDS) {
    const value = String(form[field] ?? "").trim();
    if (value && !isUrl(value)) {
      errors.push({ field, label: APP_FIELD_LABELS[field], message: "URL must include a valid domain." });
    }
  }
  const min = Number(form.desiredBaseMin);
  const max = Number(form.desiredBaseMax);
  if (form.desiredBaseMin.trim() && form.desiredBaseMax.trim() && Number.isFinite(min) && Number.isFinite(max) && min > max) {
    errors.push({ field: "desiredBaseMin", label: APP_FIELD_LABELS.desiredBaseMin, message: "Minimum compensation is above maximum." });
  }

  validateResumeDates(parsed, errors);
  validateDuplicateEntries(parsed, errors);
  return errors;
}

function validateResumeDates(parsed: ParsedResumeData, errors: ResumeFieldIssue[]): void {
  parsed.work_experience.forEach((job, i) => {
    const start = dateValue(job.start_date);
    const end = job.is_current ? Number.POSITIVE_INFINITY : dateValue(job.end_date);
    if (start !== null && end !== null && end < start) {
      errors.push({
        field: `work_experience.${i}`,
        label: "Work experience dates",
        message: `${job.job_title || "Role"} at ${job.company || "company"} ends before it starts.`,
      });
    }
  });
  parsed.education.forEach((ed, i) => {
    const start = dateValue(ed.start_date);
    const end = dateValue(ed.end_date || ed.graduation_date);
    if (start !== null && end !== null && end < start) {
      errors.push({
        field: `education.${i}`,
        label: "Education dates",
        message: `${ed.degree || "Education"} at ${ed.institution || "institution"} ends before it starts.`,
      });
    }
  });
}

function validateDuplicateEntries(parsed: ParsedResumeData, errors: ResumeFieldIssue[]): void {
  duplicateCheck(
    parsed.work_experience.map((j) => `${j.job_title}|${j.company}|${j.start_date}`),
    "work_experience",
    "Duplicate work experience",
    errors
  );
  duplicateCheck(
    parsed.education.map((e) => `${e.degree}|${e.institution}|${e.graduation_date || e.end_date}`),
    "education",
    "Duplicate education",
    errors
  );
  duplicateCheck(
    parsed.certifications.map((c) => `${c.name}|${c.issuer}`),
    "certifications",
    "Duplicate certification",
    errors
  );
  const skillValues = Object.values(parsed.skills).flat();
  duplicateCheck(skillValues, "skills", "Duplicate skill", errors);
}

function duplicateCheck(values: string[], field: string, label: string, errors: ResumeFieldIssue[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    const key = norm(value);
    if (!key) continue;
    if (seen.has(key)) {
      errors.push({ field, label, message: `Duplicate entry detected: ${value}` });
      return;
    }
    seen.add(key);
  }
}

function splitName(fullName: string): { first: string; last: string; preferred: string } {
  const parts = fullName.replace(/\s{2,}/g, " ").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { first: parts[0] ?? "", last: "", preferred: "" };
  if (parts.length === 2) return { first: parts[0]!, last: parts[1]!, preferred: "" };
  return { first: parts[0]!, preferred: parts.slice(1, -1).join(" "), last: parts[parts.length - 1]! };
}

function splitLocation(location: string): { city: string; state: string } {
  const m = location.match(/^\s*([^,]+),\s*([A-Z]{2})\b/);
  return { city: m?.[1]?.trim() ?? "", state: m?.[2] ?? "" };
}

function firstSentence(text: string): string {
  return text.split(/(?<=[.!?])\s+/)[0]?.trim() ?? text.trim();
}

function cleanUrl(raw: string): string {
  const value = raw.trim().replace(/[),.;]+$/, "");
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[\w.-]+\.[a-z]{2,}(?:\/\S*)?$/i.test(value)) return `https://${value}`;
  return value;
}

function isUrl(raw: string): boolean {
  try {
    const u = new URL(cleanUrl(raw));
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function dateValue(raw: string): number | null {
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (/present|current|now|ongoing/.test(value)) return Number.POSITIVE_INFINITY;
  const year = value.match(/\b(19|20)\d{2}\b/)?.[0];
  if (!year) return null;
  const month = monthValue(value);
  return Number(year) * 12 + month;
}

function monthValue(value: string): number {
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const idx = months.findIndex((m) => value.startsWith(m) || value.includes(` ${m}`));
  return idx >= 0 ? idx + 1 : 1;
}

function uniqueStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = norm(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item.trim());
  }
  return out;
}

function cloneForm(form: ProfileForm): ProfileForm {
  return { ...form, workModes: [...form.workModes] };
}

function norm(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
