// Profile snapshot → editable form mapping (commercial M10). This is the read direction the profile
// and welcome screens bind to; it parses the snapshot's human-readable strings back into structured
// fields. Tests pin the non-trivial parses (name/location split, work-auth & relocation phrasing,
// salary-range regex, screening answers) so a snapshot wording change can't silently corrupt the form.
import { describe, it, expect } from "vitest";
import { formFromProfileSnapshot } from "./profile-form";
import type { DashboardState, ProfileSnapshot } from "../data";

const baseProfile: ProfileSnapshot = {
  name: "Ada Lovelace",
  title: "Analyst",
  email: "ada@example.com",
  phone: "555-0100",
  location: "Austin, TX",
  links: [
    { label: "LinkedIn", value: "https://linkedin.com/in/ada" },
    { label: "GitHub", value: "https://github.com/ada" },
  ],
  targetRoles: ["Compliance Analyst", "Risk Analyst"],
  targetIndustries: ["Fintech"],
  desiredLocations: ["Austin", "Remote"],
  workModes: ["remote", "hybrid"],
  yearsOfExperience: "5",
  jobLevel: "mid",
  employmentTypes: ["full_time"],
  companiesToAvoid: [],
  compensation: "$90k–$120k, negotiable",
  workAuthorization: "Authorized to work in the US, no sponsorship required",
  earliestStart: "Immediate",
  noticePeriod: "2 weeks",
  relocation: "Open to relocation",
  screening: [
    { label: "Are you at least 18?", value: "Yes", ok: true },
    { label: "Can you perform essential functions?", value: "Yes", ok: true },
    { label: "Do you need accommodation for the process?", value: "No", ok: true },
  ],
};

const formFrom = (p: Partial<ProfileSnapshot>) =>
  formFromProfileSnapshot({ profile: { ...baseProfile, ...p } } as unknown as DashboardState);

describe("formFromProfileSnapshot", () => {
  it("splits the display name into first + last and defaults preferredName to first", () => {
    const f = formFrom({ name: "Ada Lovelace", preferredName: undefined });
    expect(f.legalFirstName).toBe("Ada");
    expect(f.legalLastName).toBe("Lovelace");
    expect(f.preferredName).toBe("Ada");
  });

  it("keeps an explicit preferred name", () => {
    expect(formFrom({ preferredName: "Addy" }).preferredName).toBe("Addy");
  });

  it("splits 'City, ST' location into city + state", () => {
    const f = formFrom({ location: "Austin, TX" });
    expect(f.city).toBe("Austin");
    expect(f.state).toBe("TX");
  });

  it("pulls links by lowercased label", () => {
    const f = formFrom({});
    expect(f.linkedin).toBe("https://linkedin.com/in/ada");
    expect(f.github).toBe("https://github.com/ada");
    expect(f.portfolio).toBe("");
  });

  it("reads work authorization: authorized yes, sponsorship no when 'no sponsorship'", () => {
    const f = formFrom({ workAuthorization: "Authorized to work in the US, no sponsorship required" });
    expect(f.authorizedToWorkInUS).toBe("yes");
    expect(f.requiresSponsorship).toBe("no");
  });

  it("flags sponsorship yes when the text asks for sponsorship without 'no sponsorship'", () => {
    expect(formFrom({ workAuthorization: "Requires visa sponsorship" }).requiresSponsorship).toBe("yes");
  });

  it("blanks earliestStartDate for 'Immediate' and extracts notice-period digits", () => {
    const f = formFrom({ earliestStart: "Immediate", noticePeriod: "2 weeks" });
    expect(f.earliestStartDate).toBe("");
    expect(f.noticePeriodDays).toBe("2");
  });

  it("maps relocation phrasing to yes/no", () => {
    expect(formFrom({ relocation: "Open to relocation" }).willingToRelocate).toBe("yes");
    expect(formFrom({ relocation: "No relocation" }).willingToRelocate).toBe("no");
    expect(formFrom({ relocation: "Unspecified" }).willingToRelocate).toBe("");
  });

  it("keeps only valid work modes and CSV-joins list fields", () => {
    const f = formFrom({ workModes: ["remote", "hybrid", "bogus"], targetRoles: ["A", "B"], desiredLocations: ["X", "Y"] });
    expect(f.workModes).toEqual(["remote", "hybrid"]);
    expect(f.targetRoles).toBe("A, B");
    expect(f.desiredLocations).toBe("X, Y");
  });

  it("parses a salary range and negotiable flag from the compensation string", () => {
    const f = formFrom({ compensation: "$90k–$120k, negotiable" });
    expect(f.desiredBaseMin).toBe("90");
    expect(f.desiredBaseMax).toBe("120");
    expect(f.isNegotiable).toBe(true);
  });

  it("derives screening answers from labelled ok flags", () => {
    const f = formFrom({});
    expect(f.isAtLeast18).toBe("yes");
    expect(f.canPerformEssentialFunctions).toBe("yes");
    expect(f.requiresAccommodationForProcess).toBe("no");
  });

  it("leaves positioning + free-text fields blank (backend supplies them, blank is non-destructive)", () => {
    const f = formFrom({});
    expect(f.positioningWhatIDo).toBe("");
    expect(f.positioningWhoIServe).toBe("");
    expect(f.positioningWhatResult).toBe("");
    expect(f.yearsOfExperience).toBe("");
  });
});
