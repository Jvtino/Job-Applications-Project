// src/profile/wizard.ts
//
// First-run interactive setup wizard (Module 1). Collects every mandatory field and
// EXPLICITLY asks the voluntary EEO / veteran / disability questions, making clear that
// "decline to answer" (the DECLINE marker) is always valid and distinct from "skip" (null,
// = not collected yet). Work-authorization defaults are seeded but require explicit user
// confirmation here before first use.
//
// The wizard mutates and returns an ApplicantProfile; persistence is the caller's job.

import {
  DECLINE,
  type Answer,
  type ApplicantProfile,
  type Decline,
  type DisabilityStatus,
  type EeoGender,
  type EeoRaceEthnicity,
  type ProtectedVeteranStatus,
  type VeteranCategory,
} from "../types/applicant-profile";
import type { Prompter } from "../cli/prompt";

function userAnswer<T>(value: T | Decline | null): Answer<T> {
  return { value, source: "user", updatedAt: new Date().toISOString() };
}

const GENDER_OPTIONS: { label: string; value: EeoGender }[] = [
  { label: "Male", value: "male" },
  { label: "Female", value: "female" },
  { label: "Non-binary", value: "non_binary" },
];

const RACE_OPTIONS: { label: string; value: EeoRaceEthnicity }[] = [
  { label: "Hispanic or Latino", value: "hispanic_or_latino" },
  { label: "White", value: "white" },
  { label: "Black or African American", value: "black_or_african_american" },
  {
    label: "Native Hawaiian or Other Pacific Islander",
    value: "native_hawaiian_or_other_pacific_islander",
  },
  { label: "Asian", value: "asian" },
  { label: "American Indian or Alaska Native", value: "american_indian_or_alaska_native" },
  { label: "Two or More Races", value: "two_or_more_races" },
];

const VET_STATUS_OPTIONS: { label: string; value: ProtectedVeteranStatus }[] = [
  { label: "I am a protected veteran", value: "protected_veteran" },
  { label: "I am not a protected veteran", value: "not_protected_veteran" },
];

const VET_CATEGORY_OPTIONS: { label: string; value: VeteranCategory }[] = [
  { label: "Disabled veteran", value: "disabled_veteran" },
  { label: "Recently separated veteran", value: "recently_separated_veteran" },
  {
    label: "Active-duty wartime or campaign badge veteran",
    value: "active_duty_wartime_or_campaign_badge_veteran",
  },
  { label: "Armed Forces service medal veteran", value: "armed_forces_service_medal_veteran" },
];

const DISABILITY_OPTIONS: { label: string; value: DisabilityStatus }[] = [
  { label: "Yes, I have a disability (or previously had one)", value: "yes_has_disability" },
  {
    label: "No, I do not have a disability and have not had one",
    value: "no_disability",
  },
];

export async function runSetupWizard(
  p: Prompter,
  profile: ApplicantProfile
): Promise<ApplicantProfile> {
  p.print("\n=== ApplyPilot — first-run setup ===");
  p.print("Answers are stored locally only (optionally encrypted). Nothing is sent anywhere");
  p.print("except, later, the career site you apply to and your LLM provider.\n");

  // -- Contact -------------------------------------------------------------------------
  p.print("--- Identity & contact ---");
  const c = profile.contact;
  c.legalFirstName = await p.text("Legal first name", { required: true, default: c.legalFirstName || undefined });
  c.legalLastName = await p.text("Legal last name", { required: true, default: c.legalLastName || undefined });
  const preferred = await p.text("Preferred name (optional)", { default: c.preferredName });
  if (preferred) c.preferredName = preferred;
  c.email = await p.text("Email", { required: true, default: c.email || undefined });
  c.phone = await p.text("Phone", { required: true, default: c.phone || undefined });
  c.address.line1 = await p.text("Address line 1", { required: true, default: c.address.line1 || undefined });
  const line2 = await p.text("Address line 2 (optional)", { default: c.address.line2 });
  if (line2) c.address.line2 = line2;
  c.address.city = await p.text("City", { required: true, default: c.address.city || undefined });
  c.address.state = await p.text("State/territory code (e.g. CA)", { required: true, default: c.address.state || undefined });
  c.address.postalCode = await p.text("ZIP / postal code", { required: true, default: c.address.postalCode || undefined });
  const linkedin = await p.text("LinkedIn URL (optional)", { default: c.links.linkedin });
  if (linkedin) c.links.linkedin = linkedin;
  const github = await p.text("GitHub URL (optional)", { default: c.links.github });
  if (github) c.links.github = github;
  const portfolio = await p.text("Portfolio URL (optional)", { default: c.links.portfolio });
  if (portfolio) c.links.portfolio = portfolio;

  // -- Work authorization (seeded defaults; confirm before first use) ------------------
  p.print("\n--- Work authorization (US roles only) ---");
  const wa = profile.workAuthorization;
  const seedAuth = wa.authorizedToWorkInUS.value;
  const authConfirmed = await p.confirm(
    `Are you authorized to work in the US?${seedAuth === true ? " (default: yes)" : ""}`,
    seedAuth === true
  );
  wa.authorizedToWorkInUS = userAnswer<boolean>(authConfirmed);
  const seedSpon = wa.requiresSponsorshipNowOrFuture.value;
  const sponsorship = await p.confirm(
    `Do you now or in the future require visa sponsorship?${seedSpon === false ? " (default: no)" : ""}`,
    seedSpon === false ? false : undefined
  );
  wa.requiresSponsorshipNowOrFuture = userAnswer<boolean>(sponsorship);
  const status = await p.choice(
    "Current work status",
    [
      { label: "US citizen", value: "us_citizen" as const },
      { label: "Permanent resident (green card)", value: "permanent_resident" as const },
      { label: "Visa holder", value: "visa_holder" as const },
      { label: "Other", value: "other" as const },
    ]
  );
  wa.currentWorkStatus = userAnswer(status);

  // -- Preferences ---------------------------------------------------------------------
  p.print("\n--- Preferences ---");
  const pr = profile.preferences;
  const start = await p.text('Earliest start date (ISO date or "immediate")', { required: true, default: "immediate" });
  pr.earliestStartDate = userAnswer<string>(start);
  pr.noticePeriodDays = userAnswer<number>(await p.number("Notice period (days)", { min: 0, default: 14 }));
  pr.willingToRelocate = userAnswer<boolean>(await p.confirm("Willing to relocate?", false));
  const modes = await p.multiChoice(
    "Work mode preference",
    [
      { label: "Remote", value: "remote" as const },
      { label: "Hybrid", value: "hybrid" as const },
      { label: "Onsite", value: "onsite" as const },
    ]
  );
  pr.workModePreference = userAnswer<("remote" | "hybrid" | "onsite")[]>(modes);
  const locs = await p.text("Desired locations (comma-separated, optional)");
  pr.desiredLocations = locs ? locs.split(",").map((s) => s.trim()).filter(Boolean) : pr.desiredLocations;
  const minComp = await p.number("Desired base salary MIN (USD, 0 to skip)", { min: 0, default: 0 });
  const maxComp = await p.number("Desired base salary MAX (USD, 0 to skip)", { min: 0, default: 0 });
  if (minComp > 0) pr.compensation.desiredBaseMin = minComp;
  if (maxComp > 0) pr.compensation.desiredBaseMax = maxComp;
  pr.compensation.isNegotiable = await p.confirm("Is compensation negotiable?", true);

  // -- Screening -----------------------------------------------------------------------
  p.print("\n--- Standard screening questions ---");
  const sc = profile.screening;
  sc.isAtLeast18 = userAnswer<boolean>(await p.confirm("Are you at least 18 years old?", true));
  sc.canPerformEssentialFunctions = userAnswer<boolean>(
    await p.confirm("Can you, with or without reasonable accommodation, perform the essential functions of the roles you seek?", true)
  );
  sc.requiresAccommodationForProcess = userAnswer<boolean>(
    await p.confirm("Do you require accommodation for the application/interview process?", false)
  );
  // Base value only; the orchestrator re-resolves this per employer against the ledger.
  sc.previouslyEmployedHere = userAnswer<boolean>(false);

  // -- Voluntary self-identification ---------------------------------------------------
  p.print("\n--- Voluntary self-identification ---");
  p.print("These are VOLUNTARY. Declining will not affect your application. You may choose");
  p.print('"Decline to answer" (recorded as an explicit decline) or "Skip for now".\n');
  const sid = profile.selfId;
  sid.gender = userAnswer<EeoGender>(await p.choice("Gender", GENDER_OPTIONS, { voluntary: true }));
  sid.raceEthnicity = userAnswer<EeoRaceEthnicity>(
    await p.choice("Race / ethnicity", RACE_OPTIONS, { voluntary: true })
  );
  const vetStatus = await p.choice("Protected veteran status", VET_STATUS_OPTIONS, { voluntary: true });
  sid.veteran.status = userAnswer<ProtectedVeteranStatus>(vetStatus);
  if (vetStatus === "protected_veteran") {
    const cats = await p.multiChoice("Veteran classification(s)", VET_CATEGORY_OPTIONS, { voluntary: true });
    sid.veteran.categories = userAnswer<VeteranCategory[]>(cats);
  } else {
    // Not a protected veteran (or declined/skipped status): mirror that into categories.
    sid.veteran.categories = userAnswer<VeteranCategory[]>(
      vetStatus === DECLINE ? DECLINE : vetStatus === null ? null : []
    );
  }
  sid.disability = userAnswer<DisabilityStatus>(
    await p.choice("Disability status (OFCCP CC-305)", DISABILITY_OPTIONS, { voluntary: true })
  );

  // -- References ----------------------------------------------------------------------
  p.print("\n--- References (optional) ---");
  while (await p.confirm("Add a reference?", false)) {
    const name = await p.text("  Name", { required: true });
    const relationship = await p.text("  Relationship", { required: true });
    const company = await p.text("  Company (optional)");
    const email = await p.text("  Email (optional)");
    const phone = await p.text("  Phone (optional)");
    profile.references.push({
      name,
      relationship,
      ...(company ? { company } : {}),
      ...(email ? { email } : {}),
      ...(phone ? { phone } : {}),
    });
  }

  profile.updatedAt = new Date().toISOString();
  p.print("\nSetup complete.\n");
  return profile;
}
