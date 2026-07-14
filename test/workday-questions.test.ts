// Workday question classifier (src/ats/workday-questions.ts) verified against the STRUCTURE of a real
// Workday application (TD Bank tenant fixture — no PII). Proves: standard fields route to their data
// source; safety-critical categories (self-ID, work-auth, terms, document) are never mistaken for a
// tenant question; the opaque hex-named TD questions become "ask the user" prompts; and a remembered
// answer is reused cross-tenant (matched by normalized question text), so a question is asked once.

import { describe, it, expect } from "vitest";
import {
  classifyWorkdayField,
  workdayQuestions,
  workdayQuestionsToAsk,
  toDynamicFieldType,
  type WorkdayFieldSource,
} from "../src/ats/workday-questions";
import { upsertDynamicAnswer, normalizeQuestionSignature } from "../src/profile/dynamic-qa";
import type { FormField } from "../src/ats/adapter";
import type { DynamicQA } from "../src/types/applicant-profile";
import { TD_WORKDAY_FIELDS } from "./fixtures/workday-td-fields";

const byRef = (ref: string): FormField => {
  const f = TD_WORKDAY_FIELDS.find((x) => x.ref === ref);
  if (!f) throw new Error(`fixture missing ref ${ref}`);
  return f;
};
const sourceOf = (ref: string): WorkdayFieldSource => classifyWorkdayField(byRef(ref));

describe("classifyWorkdayField — routes each field to the right answer source", () => {
  it("routes identity / contact / links to the structured profile", () => {
    for (const ref of ["legalName--firstName", "legalName--lastName", "addressLine1", "city", "postalCode", "phoneNumber", "country", "countryRegion", "linkedInAccount"]) {
      expect(sourceOf(ref), ref).toBe("profile");
    }
  });

  it("routes work history / education / skills / spoken language to the ledger (experience)", () => {
    for (const ref of ["jobTitle", "companyName", "location", "workExperience-48--roleDescription", "education-49--school", "degree", "language", "skills--skills"]) {
      expect(sourceOf(ref), ref).toBe("experience");
    }
  });

  it("routes EEO / self-ID to the risk gate, never to ask_user", () => {
    for (const ref of ["gender", "ethnicity", "veteranStatus", "disabilityForm", "64cbff5f364f10000ae7a421cf210000-disabilityStatus"]) {
      expect(sourceOf(ref), ref).toBe("self_id");
    }
  });

  it("routes work authorization + sponsorship to work_auth", () => {
    expect(sourceOf("73a5111f34b31004252a23ff39e20001")).toBe("work_auth"); // authorized to work
    expect(sourceOf("73a5111f34b31004252a23ff39e20004")).toBe("work_auth"); // sponsorship
  });

  it("routes the legal acceptance to terms (never auto-checked) and the resume to document", () => {
    expect(sourceOf("acceptTermsAndAgreements")).toBe("terms");
    expect(sourceOf("resumeAttachments--attachments")).toBe("document");
  });

  it("routes profile-modeled gating questions to knockout", () => {
    expect(sourceOf("73a5111f34b31004252a2365c6190000")).toBe("knockout"); // 18+ age of majority
  });

  it("routes the opaque tenant-specific questions to ask_user", () => {
    for (const ref of [
      "candidateIsPreviousWorker", // previously employed by TD
      "73a5111f34b31004252a2365c6190003", // diploma requirement
      "73a5111f34b31004252a23ff39e20007", // relatives at TD
      "73a5111f34b31004252a2498b5d70000", // non-solicitation agreement
      "73a5111f34b31004252a2498b5d70004", // gov banking agency
      "73a5111f34b31004252a25cbb5730001", // politically exposed person
      "empType-73a5111f34b31004252a25cbb5730005", // employment type
      "primaryQuestionnaire--73a5111f34b31004252a266562b10003", // weekly hours
      "primaryQuestionnaire--73a5111f34b31004252a266562b10004", // compensation
      "phoneType", // phone device type (not modeled in the profile)
      "de7696529635010f30a59173ff0385a1", // language proficiency: Conduct Business
    ]) {
      expect(sourceOf(ref), ref).toBe("ask_user");
    }
  });
});

describe("workdayQuestions — the ask-the-user list", () => {
  it("returns exactly the ask_user fields, keyed by normalized question text", () => {
    const qs = workdayQuestions(TD_WORKDAY_FIELDS);
    // every returned question is ask_user, and none of the safety/data categories leak in
    expect(qs.every((q) => q.source === "ask_user")).toBe(true);
    expect(qs.some((q) => /relatives/i.test(q.questionText))).toBe(true);
    expect(qs.some((q) => /compensation/i.test(q.questionText))).toBe(true);
    // keys match the answer-bank convention so they collide with the matcher's fallback + upsert
    const relatives = qs.find((q) => /relatives/i.test(q.questionText))!;
    expect(relatives.key).toBe(normalizeQuestionSignature(relatives.questionText));
    // multi-select and free-text field types are carried through
    expect(qs.find((q) => /type of employment/i.test(q.questionText))!.fieldType).toBe("multi_select");
    expect(qs.find((q) => /weekly hours/i.test(q.questionText))!.fieldType).toBe("text");
  });

  it("marks a remembered question and drops it from the ask list (cross-tenant reuse by text)", () => {
    const relativesText = TD_WORKDAY_FIELDS.find((f) => /relatives/i.test(f.label))!.label;
    // Simulate an answer captured on a DIFFERENT tenant/application, stored by normalized text.
    const bank: DynamicQA[] = upsertDynamicAnswer([], {
      questionText: relativesText,
      fieldType: "single_select",
      answer: "No",
    });

    const all = workdayQuestions(TD_WORKDAY_FIELDS, bank);
    const remembered = all.find((q) => /relatives/i.test(q.questionText))!;
    expect(remembered.remembered).toBe(true);

    const toAsk = workdayQuestionsToAsk(TD_WORKDAY_FIELDS, bank);
    expect(toAsk.some((q) => /relatives/i.test(q.questionText))).toBe(false); // no longer asked
    expect(toAsk.length).toBe(all.length - 1);
  });

  it("with an empty bank, every ask_user question still needs asking", () => {
    const all = workdayQuestions(TD_WORKDAY_FIELDS);
    const toAsk = workdayQuestionsToAsk(TD_WORKDAY_FIELDS);
    expect(all.every((q) => q.remembered === false)).toBe(true);
    expect(toAsk.length).toBe(all.length);
    expect(toAsk.length).toBeGreaterThan(0);
  });
});

describe("toDynamicFieldType", () => {
  it("maps control types to answer-bank field types", () => {
    expect(toDynamicFieldType("multi_checkbox")).toBe("multi_select");
    expect(toDynamicFieldType("custom_select")).toBe("single_select");
    expect(toDynamicFieldType("checkbox")).toBe("boolean");
    expect(toDynamicFieldType("number")).toBe("number");
    expect(toDynamicFieldType("textarea")).toBe("text");
  });
});
