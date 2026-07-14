// src/ingestion/profile-from-resume.ts
//
// Best-effort extraction of profile/contact fields from parsed résumé text + facts.
// Used after in-app upload to pre-fill the profile form. Only fills EMPTY fields — never
// overwrites values the user already saved (source:"user" on Answer fields).

import type { ApplicantProfile } from "../types/applicant-profile";
import type { Fact } from "../types/facts-ledger";
import { extractDefaults } from "./extract-defaults";

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE = /(\+?\d[\d().\-\s]{8,}\d)/;
const URL = /\bhttps?:\/\/[^\s)]+|(?:linkedin\.com|github\.com)\/[^\s)]+/i;
const CITY_STATE = /([A-Za-z][A-Za-z.\- ]+),\s*([A-Z]{2})\b/;

export interface ExtractedProfileFields {
  legalFirstName?: string;
  legalLastName?: string;
  preferredName?: string;
  email?: string;
  phone?: string;
  city?: string;
  state?: string;
  linkedin?: string;
  github?: string;
  portfolio?: string;
  desiredLocations?: string[];
  desiredBaseMin?: number;
  desiredBaseMax?: number;
  targetRoles?: string[];
  workModes?: ("remote" | "hybrid" | "onsite")[];
}

/** Pull contact + preference hints from parsed facts and raw résumé text. */
export function extractProfileFromResume(facts: Fact[], rawText: string): ExtractedProfileFields {
  const out: ExtractedProfileFields = {};
  const head = rawText.split("\n").slice(0, 14);

  for (const line of head) {
    const t = line.trim();
    if (!t || t.length > 80) continue;
    if (EMAIL.test(t) || PHONE.test(t) || URL.test(t)) continue;
    if (/^(summary|experience|education|skills|certifications?)\b/i.test(t)) break;
    const name = parseNameLine(t);
    if (name) {
      out.legalFirstName = name.first;
      out.legalLastName = name.last;
      if (name.preferred) out.preferredName = name.preferred;
      break;
    }
  }

  for (const line of head) {
    const cs = line.match(CITY_STATE);
    if (cs) {
      out.city = cs[1]!.trim();
      out.state = cs[2]!;
      break;
    }
  }

  const blob = head.join("\n");
  const email = blob.match(EMAIL)?.[0] ?? contactValue(facts, EMAIL);
  const phone = blob.match(PHONE)?.[0]?.trim() ?? contactValue(facts, PHONE);
  if (email) out.email = email;
  if (phone) out.phone = normalizePhone(phone);

  for (const url of blob.match(new RegExp(URL, "gi")) ?? []) {
    const u = url.startsWith("http") ? url : `https://${url}`;
    if (/linkedin\.com/i.test(u) && !out.linkedin) out.linkedin = u;
    else if (/github\.com/i.test(u) && !out.github) out.github = u;
    else if (!out.portfolio && !/linkedin|github/i.test(u)) out.portfolio = u;
  }

  const defaults = extractDefaults(facts, rawText);
  if (defaults.locations.length) out.desiredLocations = defaults.locations;
  if (defaults.compensation?.min !== undefined) out.desiredBaseMin = defaults.compensation.min;
  if (defaults.compensation?.max !== undefined) out.desiredBaseMax = defaults.compensation.max;
  if (defaults.targetRoles.length) out.targetRoles = defaults.targetRoles;
  if (defaults.workModes?.length) out.workModes = defaults.workModes;

  return out;
}

function contactValue(facts: Fact[], re: RegExp): string | undefined {
  for (const f of facts) {
    if (f.type !== "contact") continue;
    const src = f.sourceText ?? f.statement;
    const m = src.match(re) ?? f.statement.match(re);
    if (m) return m[0]?.trim();
  }
  return undefined;
}

function parseNameLine(line: string): { first: string; last: string; preferred?: string } | null {
  const t = line.replace(/\s{2,}/g, " ").trim();
  if (!t || t.length < 3) return null;
  if (/\d/.test(t)) return null;
  const parts = t.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  if (parts.length === 2) return { first: parts[0]!, last: parts[1]! };
  return {
    first: parts[0]!,
    preferred: parts.slice(1, -1).join(" "),
    last: parts[parts.length - 1]!,
  };
}

function normalizePhone(raw: string): string {
  return raw.replace(/\s{2,}/g, " ").trim();
}

function isBlank(s: string | undefined): boolean {
  return !s || s.trim() === "";
}

/** Merge extracted résumé fields into a profile without clobbering existing user data. */
export function mergeResumeIntoProfile(profile: ApplicantProfile, extracted: ExtractedProfileFields): ApplicantProfile {
  const p = profile;
  const c = p.contact;

  if (isBlank(c.legalFirstName) && extracted.legalFirstName) c.legalFirstName = extracted.legalFirstName;
  if (isBlank(c.legalLastName) && extracted.legalLastName) c.legalLastName = extracted.legalLastName;
  if (isBlank(c.preferredName) && extracted.preferredName) c.preferredName = extracted.preferredName;
  if (isBlank(c.email) && extracted.email) c.email = extracted.email;
  if (isBlank(c.phone) && extracted.phone) c.phone = extracted.phone;
  if (isBlank(c.address.city) && extracted.city) c.address.city = extracted.city;
  if (isBlank(c.address.state) && extracted.state) c.address.state = extracted.state;

  if (isBlank(c.links.linkedin) && extracted.linkedin) c.links.linkedin = extracted.linkedin;
  if (isBlank(c.links.github) && extracted.github) c.links.github = extracted.github;
  if (isBlank(c.links.portfolio) && extracted.portfolio) c.links.portfolio = extracted.portfolio;

  if (p.preferences.desiredLocations.length === 0 && extracted.desiredLocations?.length) {
    p.preferences.desiredLocations = extracted.desiredLocations;
  }
  if (!p.preferences.compensation.desiredBaseMin && extracted.desiredBaseMin !== undefined) {
    p.preferences.compensation.desiredBaseMin = extracted.desiredBaseMin;
  }
  if (!p.preferences.compensation.desiredBaseMax && extracted.desiredBaseMax !== undefined) {
    p.preferences.compensation.desiredBaseMax = extracted.desiredBaseMax;
  }
  if (p.preferences.targetRoles.length === 0 && extracted.targetRoles?.length) {
    p.preferences.targetRoles = extracted.targetRoles;
  }
  if (
    (!Array.isArray(p.preferences.workModePreference.value) ||
      (p.preferences.workModePreference.value as unknown[]).length === 0) &&
    extracted.workModes?.length
  ) {
    p.preferences.workModePreference = {
      value: extracted.workModes,
      source: "inferred",
      updatedAt: new Date().toISOString(),
    };
  }

  p.updatedAt = new Date().toISOString();
  return p;
}

export function countFilledFields(extracted: ExtractedProfileFields): number {
  return Object.values(extracted).filter((v) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== "")).length;
}
