// Map the engine's profile snapshot (GET /api/state) into the editable ProfileForm the profile/welcome
// screens bind to (extracted from ChronicleDashboard for testability, commercial M10). This is the
// read/deserialize direction only — it parses the snapshot's human-readable strings (name, location,
// work authorization, relocation, compensation range, screening answers) back into structured fields.
// Positioning + several free-text fields aren't in the snapshot; GET /api/profile supplies those, so
// all-blank here is safe (the backend leaves an existing value untouched when the field is empty).
import type { DashboardState, ProfileForm } from "../data";

function digits(value: string): string {
  return value.replace(/[^\d]/g, "");
}

function csv(values: string[]): string {
  return values.join(", ");
}

export function formFromProfileSnapshot(state: DashboardState): ProfileForm {
  const profile = state.profile;
  const [first = "", ...rest] = profile.name.split(/\s+/).filter(Boolean);
  const link = (label: string) => profile.links.find((item) => item.label.toLowerCase() === label)?.value ?? "";
  const salary = profile.compensation.match(/\$?(\d+)k?.*?\$?(\d+)k?/i);
  return {
    legalFirstName: first,
    legalLastName: rest.join(" "),
    preferredName: profile.preferredName ?? first,
    email: profile.email,
    phone: profile.phone,
    addressLine1: "",
    addressLine2: "",
    city: profile.location.split(",")[0]?.trim() ?? "",
    state: profile.location.split(",")[1]?.trim() ?? "",
    postalCode: "",
    linkedin: link("linkedin"),
    github: link("github"),
    portfolio: link("portfolio"),
    authorizedToWorkInUS: /authorized/i.test(profile.workAuthorization) ? "yes" : "",
    requiresSponsorship: /sponsorship/i.test(profile.workAuthorization) && !/no sponsorship/i.test(profile.workAuthorization) ? "yes" : "no",
    currentWorkStatus: "",
    earliestStartDate: profile.earliestStart === "Immediate" ? "" : profile.earliestStart,
    noticePeriodDays: digits(profile.noticePeriod),
    willingToRelocate: /no relocation/i.test(profile.relocation) ? "no" : /relocation/i.test(profile.relocation) ? "yes" : "",
    workModes: profile.workModes.filter((mode): mode is ProfileForm["workModes"][number] => mode === "remote" || mode === "hybrid" || mode === "onsite"),
    targetRoles: csv(profile.targetRoles),
    targetIndustries: "",
    yearsOfExperience: "",
    companiesToAvoid: "",
    jobLevel: "",
    employmentTypes: [],
    desiredLocations: csv(profile.desiredLocations),
    desiredBaseMin: salary?.[1] ?? "",
    desiredBaseMax: salary?.[2] ?? "",
    isNegotiable: /negotiable/i.test(profile.compensation),
    // Positioning isn't in the snapshot; GET /api/profile supplies the real values. All-blank here
    // is safe — the backend leaves an existing positioning untouched when these three are empty.
    positioningWhatIDo: "",
    positioningWhoIServe: "",
    positioningWhatResult: "",
    isAtLeast18: profile.screening.find((item) => /18/.test(item.label))?.ok ? "yes" : "",
    canPerformEssentialFunctions: profile.screening.find((item) => /essential/i.test(item.label))?.ok ? "yes" : "",
    requiresAccommodationForProcess: profile.screening.find((item) => /accommodation/i.test(item.label))?.ok ? "no" : "",
    gender: "",
    raceEthnicity: "",
    veteranStatus: "",
    disability: "",
    references: [],
    eligibilityNote: "",
    criminalHistoryDisclosure: "",
    customAnswers: [],
  };
}
