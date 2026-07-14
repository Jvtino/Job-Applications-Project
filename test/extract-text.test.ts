import { describe, expect, it } from "vitest";
import { renderResumePdf } from "../src/generation/render";
import { extractResumeTextFromBuffer } from "../src/ingestion/extract-text";

describe("resume text extraction", () => {
  it("accepts Node Buffer-backed PDF uploads", async () => {
    const pdf = await renderResumePdf({
      name: "Haci Ahmet Ilhan",
      contactLines: ["haci-ilhan@example.com | Brooklyn, NY"],
      summary: "AML and Financial Crime Analyst",
      experience: [
        {
          header: "AML Analyst, Northwind Bank (2022 - Present)",
          bullets: ["Conducted enhanced due diligence and sanctions screening reviews."],
        },
      ],
      education: ["B.S. Finance, State University"],
      skills: ["KYC", "EDD", "Sanctions screening"],
      certifications: [],
    });

    expect(Buffer.isBuffer(pdf)).toBe(true);
    const extracted = await extractResumeTextFromBuffer("resume.pdf", pdf);

    expect(extracted.format).toBe("pdf");
    expect(extracted.text).toContain("Haci Ahmet Ilhan");
    expect(extracted.text).toContain("Financial Crime Analyst");
  });
});
