import { describe, it, expect } from "vitest";
import {
  findDynamicAnswer,
  normalizeQuestionSignature,
  upsertDynamicAnswer,
} from "../src/profile/dynamic-qa";

describe("DynamicQA ask-once / reuse", () => {
  it("normalizes trivially-different phrasings to the same signature", () => {
    expect(normalizeQuestionSignature("How did you hear about us?")).toBe(
      normalizeQuestionSignature("how did you hear about us")
    );
    expect(normalizeQuestionSignature("  Are you   18+? ")).toBe("are you 18");
  });

  it("reuses a stored answer for the same question asked again", () => {
    let answers = upsertDynamicAnswer([], {
      questionText: "How did you hear about us?",
      fieldType: "text",
      answer: "LinkedIn",
    });
    // Same question, different punctuation/case -> found.
    const hit = findDynamicAnswer(answers, "how did you HEAR about us");
    expect(hit?.answer).toBe("LinkedIn");

    // Re-answering updates in place (no duplicate row).
    answers = upsertDynamicAnswer(answers, {
      questionText: "How did you hear about us?",
      fieldType: "text",
      answer: "Referral",
    });
    expect(answers).toHaveLength(1);
    expect(findDynamicAnswer(answers, "How did you hear about us?")?.answer).toBe("Referral");
  });

  it("retains the original phrasing for audit", () => {
    const answers = upsertDynamicAnswer([], {
      questionText: "Do you have a security clearance (TS/SCI)?",
      fieldType: "boolean",
      answer: false,
    });
    expect(answers[0]!.questionText).toBe("Do you have a security clearance (TS/SCI)?");
    expect(answers[0]!.key).not.toContain("?");
  });
});
