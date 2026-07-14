// src/ats/synonyms.ts
//
// Curated, per-ATS-agnostic synonym maps used by the layered FieldMatcher to bind clean
// profile enums to whatever option text a live form renders. We store SEMANTIC values in the
// profile and match them to rendered options here; we never hardcode a form's legal wording.

import {
  DECLINE,
  type DisabilityStatus,
  type EeoGender,
  type EeoRaceEthnicity,
  type ProtectedVeteranStatus,
} from "../types/applicant-profile";

export const YES = ["yes", "y", "true"];
export const NO = ["no", "n", "false"];

/** The DECLINE marker maps to each form's explicit "do not wish to answer" option. */
export const DECLINE_SYNONYMS = [
  "decline to answer",
  "decline to self identify",
  "decline to self-identify",
  "i do not wish to answer",
  "i don't wish to answer",
  "i do not wish to disclose",
  "prefer not to answer",
  "prefer not to say",
  "do not wish to provide",
  "decline",
];

export const GENDER_SYNONYMS: Record<EeoGender, string[]> = {
  male: ["male", "man"],
  female: ["female", "woman"],
  non_binary: ["non-binary", "nonbinary", "non binary", "genderqueer"],
};

export const RACE_SYNONYMS: Record<EeoRaceEthnicity, string[]> = {
  hispanic_or_latino: ["hispanic or latino", "hispanic", "latino", "latinx"],
  white: ["white", "white (not hispanic or latino)", "caucasian"],
  black_or_african_american: ["black or african american", "black", "african american"],
  native_hawaiian_or_other_pacific_islander: [
    "native hawaiian or other pacific islander",
    "native hawaiian",
    "pacific islander",
  ],
  asian: ["asian"],
  american_indian_or_alaska_native: [
    "american indian or alaska native",
    "american indian",
    "alaska native",
    "native american",
  ],
  two_or_more_races: ["two or more races", "two or more", "multiracial", "multiple"],
};

export const VETERAN_SYNONYMS: Record<ProtectedVeteranStatus, string[]> = {
  protected_veteran: [
    "i identify as one or more of the classifications of protected veteran",
    "i am a protected veteran",
    "protected veteran",
    "yes",
  ],
  not_protected_veteran: [
    "i am not a protected veteran",
    "not a protected veteran",
    "i am not a veteran",
    "no",
  ],
};

export const DISABILITY_SYNONYMS: Record<DisabilityStatus, string[]> = {
  yes_has_disability: [
    "yes, i have a disability, or have had one in the past",
    "yes i have a disability",
    "yes, i have a disability",
    "i have a disability",
    "yes",
  ],
  no_disability: [
    "no, i do not have a disability and have not had one in the past",
    "no i do not have a disability",
    "no, i do not have a disability",
    "i do not have a disability",
    "no",
  ],
};

/** Build the list of candidate option texts for a semantic value (incl. the DECLINE marker). */
export function genderTargets(v: EeoGender | typeof DECLINE): string[] {
  return v === DECLINE ? DECLINE_SYNONYMS : GENDER_SYNONYMS[v];
}
export function raceTargets(v: EeoRaceEthnicity | typeof DECLINE): string[] {
  return v === DECLINE ? DECLINE_SYNONYMS : RACE_SYNONYMS[v];
}
export function veteranTargets(v: ProtectedVeteranStatus | typeof DECLINE): string[] {
  return v === DECLINE ? DECLINE_SYNONYMS : VETERAN_SYNONYMS[v];
}
export function disabilityTargets(v: DisabilityStatus | typeof DECLINE): string[] {
  return v === DECLINE ? DECLINE_SYNONYMS : DISABILITY_SYNONYMS[v];
}
export function boolTargets(v: boolean): string[] {
  return v ? YES : NO;
}

// Risk classification keyword groups (checked against the rendered label).
export const RISK_KEYWORDS = {
  self_id: [
    "gender",
    "race",
    "ethnicity",
    "hispanic",
    "veteran",
    "disability",
    "self-identification",
    "self identification",
  ],
  authorization: [
    "authorized to work",
    "work authorization",
    "legally authorized",
    "right to work",
    "require sponsorship",
    "sponsorship",
    "visa",
    "work permit",
  ],
  knockout: [
    "18 years",
    "at least 18",
    "essential functions",
    "security clearance",
    "clearance",
    "previously employed",
    "previously worked",
    "currently employed by",
    "non-compete",
    "noncompete",
    "convicted",
    "felony",
  ],
  identity: [
    "first name",
    "last name",
    "surname",
    "family name",
    "full name",
    "preferred name",
    "email",
    "phone",
    "mobile",
    "telephone",
    "address",
    "street",
    "city",
    "state",
    "province",
    "zip",
    "postal",
    "country",
    "linkedin",
    "github",
    "website",
    "portfolio",
  ],
  // Multiword phrases only: a bare "salary"/"rate" substring also matches acknowledgement and
  // self-rating questions ("The salary range is...", "rate your knowledge of..."), which must
  // NOT be auto-answered with a compensation value. Require language that asks for the
  // candidate's OWN desired pay.
  compensation: [
    "desired salary",
    "salary expectation",
    "salary requirement",
    "expected salary",
    "desired compensation",
    "compensation expectation",
    "expected compensation",
    "desired pay",
    "pay expectation",
  ],
} as const;

// Minimal US state code -> name map (for state selects that render full names).
export const US_STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
  CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho",
  IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina",
  ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas",
  UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia",
  WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia",
};
