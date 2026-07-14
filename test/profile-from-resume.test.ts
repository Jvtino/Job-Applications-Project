import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { parseResumeHeuristic } from "../src/ingestion/parse-resume";
import { extractProfileFromResume, mergeResumeIntoProfile } from "../src/ingestion/profile-from-resume";
import { createBlankProfile } from "../src/profile/factory";
import { profileToForm } from "../src/server/profile-form";

const sample = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sample-resume.txt"), "utf8");

describe("extractProfileFromResume", () => {
  it("pulls name, contact, location, and links from a typical résumé", () => {
    const parsed = parseResumeHeuristic(sample);
    const extracted = extractProfileFromResume(parsed.facts, sample);
    expect(extracted.legalFirstName).toBe("Jane");
    expect(extracted.legalLastName).toBe("Applicant");
    expect(extracted.preferredName).toBe("Q.");
    expect(extracted.email).toBe("jane.applicant@example.com");
    expect(extracted.phone).toContain("415");
    expect(extracted.city).toBe("San Francisco");
    expect(extracted.state).toBe("CA");
    expect(extracted.linkedin).toMatch(/linkedin/i);
    expect(extracted.github).toMatch(/github/i);
  });

  it("merges into a blank profile without overwriting existing user values", () => {
    const parsed = parseResumeHeuristic(sample);
    const extracted = extractProfileFromResume(parsed.facts, sample);
    const blank = createBlankProfile("p1");
    const merged = mergeResumeIntoProfile(blank, extracted);
    const form = profileToForm(merged);
    expect(form.legalFirstName).toBe("Jane");
    expect(form.email).toBe("jane.applicant@example.com");

    blank.contact.email = "already@set.com";
    blank.contact.legalFirstName = "Keep";
    const again = mergeResumeIntoProfile(blank, extracted);
    expect(again.contact.email).toBe("already@set.com");
    expect(again.contact.legalFirstName).toBe("Keep");
    expect(again.contact.phone).toContain("415");
  });
});
