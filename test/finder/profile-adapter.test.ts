import { describe, expect, it } from "vitest";
import { buildFinderInputs } from "../../src/finder/pipeline/profile-adapter";
import { createBlankProfile } from "../../src/profile/factory";
import type { JobSearchIntent } from "../../src/types/job-search-intent";
import type { ResumeInsights } from "../../src/types/resume-insights";

function makeIntent(over: Partial<JobSearchIntent> = {}): JobSearchIntent {
  return {
    confirmed: true,
    confidence: "confirmed",
    roleFamilies: [],
    targetTitles: [],
    adjacentTitles: [],
    excludedTitles: [],
    currentOrPastTitles: [],
    seniority: { min: "mid", max: "senior", evidence: [] },
    mustHaveSkills: [],
    niceToHaveSkills: [],
    transferableSkills: [],
    requiredCredentials: [],
    missingCredentialDealbreakers: [],
    industries: [],
    companyTypes: [],
    locations: [],
    workArrangement: [],
    dealbreakers: [],
    ...over,
  };
}

function makeInsights(over: Partial<ResumeInsights> = {}): ResumeInsights {
  return {
    totalYearsExperience: 5,
    seniorityLevel: 3,
    seniorityLabel: "mid",
    domains: [],
    skills: [],
    topTitles: [],
    education: [],
    method: "deterministic",
    generatedAt: "2026-07-11T00:00:00Z",
    ...over,
  };
}

describe("buildFinderInputs (ApplyPilot profile -> finder scoring inputs)", () => {
  it("maps a finance/compliance intent to the finance_compliance track and projects fields", () => {
    const profile = createBlankProfile("u1");
    const intent = makeIntent({
      roleFamilies: ["compliance"],
      targetTitles: ["KYC Analyst", "Compliance Analyst"],
      adjacentTitles: ["AML Investigator"],
      excludedTitles: ["Sales Associate"],
      mustHaveSkills: ["KYC", "AML"],
      niceToHaveSkills: ["SQL"],
      industries: ["fintech"],
      locations: ["New York, NY"],
      workArrangement: ["remote_us", "hybrid"],
      compensation: { min: 90000, currency: "USD" },
    });
    const insights = makeInsights({
      totalYearsExperience: 6,
      domains: ["compliance", "finance"],
      skills: [
        { name: "sanctions screening", mentions: 4 },
        { name: "KYC", mentions: 8 },
      ],
      topTitles: ["Compliance Analyst"],
    });

    const { profile: rp, prefs } = buildFinderInputs({ profile, intent, insights });

    expect(prefs.track).toBe("finance_compliance");
    expect(prefs.targetTitles).toEqual(
      expect.arrayContaining(["KYC Analyst", "Compliance Analyst", "AML Investigator"]),
    );
    expect(prefs.excludedTitles).toEqual(["Sales Associate"]);
    expect(prefs.preferredLocations).toEqual(["New York, NY"]);
    expect(prefs.remotePreferences).toEqual(expect.arrayContaining(["remote", "hybrid"]));
    expect(prefs.remotePreferences).not.toContain("remote_us"); // remote_us -> remote
    expect(prefs.salaryMin).toBe(90000);
    expect(prefs.industries).toEqual(["fintech"]);

    expect(rp.skills).toEqual(expect.arrayContaining(["sanctions screening", "KYC", "AML", "SQL"]));
    expect(rp.yearsExperience).toBe(6);
    expect(rp.jobTitles).toContain("Compliance Analyst");
  });

  it("maps an engineering profile to the tech track", () => {
    const profile = createBlankProfile("u2");
    const intent = makeIntent({ roleFamilies: ["engineering"], targetTitles: ["Software Engineer"] });
    const { prefs } = buildFinderInputs({ profile, intent, insights: null });
    expect(prefs.track).toBe("tech");
  });

  it("falls back to ApplicantProfile.preferences when intent & insights are null", () => {
    const profile = createBlankProfile("u3");
    profile.preferences.targetRoles = ["Warehouse Associate"];
    profile.preferences.desiredLocations = ["Dallas, TX"];
    profile.preferences.targetIndustries = ["logistics"];
    profile.preferences.compensation.desiredBaseMin = 45000;
    profile.preferences.yearsOfExperience = 2;

    const { profile: rp, prefs } = buildFinderInputs({ profile, intent: null, insights: null });
    expect(prefs.targetTitles).toEqual(["Warehouse Associate"]);
    expect(prefs.preferredLocations).toEqual(["Dallas, TX"]);
    expect(prefs.industries).toEqual(["logistics"]);
    expect(prefs.salaryMin).toBe(45000);
    expect(prefs.track).toBe("blue_collar_hourly"); // "Warehouse" keyword
    expect(rp.yearsExperience).toBe(2);
  });

  it("defaults to general_professional when nothing signals a domain", () => {
    const profile = createBlankProfile("u4");
    const intent = makeIntent({ targetTitles: ["Program Manager"] });
    const insights = makeInsights({ seniorityLevel: 4 });
    const { prefs } = buildFinderInputs({ profile, intent, insights });
    expect(prefs.track).toBe("general_professional");
  });
});
