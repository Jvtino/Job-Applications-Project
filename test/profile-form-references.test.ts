import { describe, it, expect } from "vitest";
import { createBlankProfile } from "../src/profile/factory";
import { applyFormToProfile, profileToForm, EMPTY_FORM, RESERVED_DYNAMIC_Q } from "../src/server/profile-form";

describe("profile form: references + reserved free-text fields", () => {
  it("round-trips references and stores eligibility/criminal as dynamicAnswers (never duplicated in custom answers)", () => {
    const base = createBlankProfile("test");
    const p = applyFormToProfile(base, {
      ...EMPTY_FORM,
      legalFirstName: "Jane",
      legalLastName: "Doe",
      email: "j@x.com",
      phone: "1",
      references: [{ name: "Sam Lee", relationship: "Former manager", company: "Acme", email: "sam@acme.com", phone: "555" }],
      eligibilityNote: "US citizen, no sponsorship needed.",
      criminalHistoryDisclosure: "None to disclose.",
      customAnswers: [{ questionText: "Why us?", answer: "Impact." }],
    });

    expect(p.references).toHaveLength(1);
    expect(p.references[0]).toMatchObject({ name: "Sam Lee", relationship: "Former manager", company: "Acme" });

    const dynQs = p.dynamicAnswers.map((d) => d.questionText);
    expect(dynQs).toContain(RESERVED_DYNAMIC_Q.eligibility);
    expect(dynQs).toContain(RESERVED_DYNAMIC_Q.criminalHistory);
    expect(dynQs).toContain("Why us?");

    const back = profileToForm(p);
    expect(back.references).toHaveLength(1);
    expect(back.eligibilityNote).toBe("US citizen, no sponsorship needed.");
    expect(back.criminalHistoryDisclosure).toBe("None to disclose.");

    const customQs = (back.customAnswers ?? []).map((c) => c.questionText);
    expect(customQs).toContain("Why us?");
    expect(customQs).not.toContain(RESERVED_DYNAMIC_Q.eligibility);
    expect(customQs).not.toContain(RESERVED_DYNAMIC_Q.criminalHistory);
  });

  it("blank reserved fields are opt-in (omitted)", () => {
    const base = createBlankProfile("test");
    const p = applyFormToProfile(base, { ...EMPTY_FORM, legalFirstName: "A", legalLastName: "B", email: "a@b.com", phone: "1", criminalHistoryDisclosure: "discl" });
    expect(p.dynamicAnswers.some((d) => d.questionText === RESERVED_DYNAMIC_Q.criminalHistory)).toBe(true);
    expect(p.dynamicAnswers.some((d) => d.questionText === RESERVED_DYNAMIC_Q.eligibility)).toBe(false);
  });
});
