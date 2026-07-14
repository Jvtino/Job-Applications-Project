import { describe, it, expect } from "vitest";
import { splitSentences } from "../src/generation/claim-extraction";

// `splitSentences` feeds the deterministic anti-fabrication gate. Two failure
// modes matter in opposite directions:
//   - over-splitting shatters names/abbreviations into fragments (annoying, and
//     it corrupts entity extraction), while
//   - under-splitting merges two real sentences so a fabricated claim can hide
//     inside the merged unit and bypass the gate — the dangerous direction.
// These tests pin both: abbreviations/initials must NOT split; every genuine
// boundary MUST still split.
describe("splitSentences — abbreviation & initial handling", () => {
  describe("must NOT split (single claim kept intact)", () => {
    const keepWhole = [
      "Managed KYC reviews for J. P. Morgan and Goldman Sachs.",
      "Worked with Dr. Smith on the sanctions model.",
      "Reported to Mr. Chen at St. Louis HQ.",
      "Fluent in English and Turkish (i.e. native-level in both).",
      "Holds a B.A. in Economics from Bogazici University.",
    ];
    for (const text of keepWhole) {
      it(text, () => {
        expect(splitSentences(text)).toEqual([text]);
      });
    }
  });

  describe("must STILL split (real sentence boundaries preserved)", () => {
    const twoSentences: [string, [string, string]][] = [
      [
        "Screened counterparties using World-Check One. Reduced false positives by 30%.",
        ["Screened counterparties using World-Check One.", "Reduced false positives by 30%."],
      ],
      [
        "Reported directly to the MLRO. Escalated 12 SARs in Q3.",
        ["Reported directly to the MLRO.", "Escalated 12 SARs in Q3."],
      ],
      [
        "Cut onboarding time by 1.5 days. Improved SLA compliance.",
        ["Cut onboarding time by 1.5 days.", "Improved SLA compliance."],
      ],
      // Org suffix genuinely ends a sentence — must remain a 2-way split so a
      // fabricated claim can't hide behind "Inc.".
      [
        "Joined Acme Inc. Grew the desk 40%.",
        ["Joined Acme Inc.", "Grew the desk 40%."],
      ],
    ];
    for (const [text, expected] of twoSentences) {
      it(text, () => {
        expect(splitSentences(text)).toEqual(expected);
      });
    }
  });

  describe("edge cases", () => {
    it("keeps trailing initials in one sentence (initial at end of sentence)", () => {
      expect(splitSentences("Reported to J. P. Morgan.")).toEqual(["Reported to J. P. Morgan."]);
    });

    it("does not split a dotted abbreviation followed by a lowercase word", () => {
      expect(splitSentences("Attended the a.m. standup daily.")).toEqual([
        "Attended the a.m. standup daily.",
      ]);
    });

    it("still splits after an ordinal (21st/1st are not the 'St.' abbreviation)", () => {
      expect(splitSentences("Ranked 1st. Improved SLA next quarter.")).toEqual([
        "Ranked 1st.",
        "Improved SLA next quarter.",
      ]);
    });

    it("suppresses honorific + initial but keeps the real boundary after the name", () => {
      expect(splitSentences("Worked with Dr. A. Smith. Shipped it.")).toEqual([
        "Worked with Dr. A. Smith.",
        "Shipped it.",
      ]);
    });

    it("still splits on ! and ? boundaries", () => {
      expect(splitSentences("Shipped it! Then iterated. Done?")).toEqual([
        "Shipped it!",
        "Then iterated.",
        "Done?",
      ]);
    });
  });
});
