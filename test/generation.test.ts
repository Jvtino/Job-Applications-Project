import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import type { ApplicantProfile } from "../src/types/applicant-profile";
import type { FactsLedger } from "../src/types/facts-ledger";
import { createBlankProfile } from "../src/profile/factory";
import { parsePosting } from "../src/generation/posting";
import {
  TemplateDocumentGenerator,
  LlmDocumentGenerator,
  type DocumentGenerator,
  type GeneratorContext,
} from "../src/generation/generator";
import type { LlmClient } from "../src/llm/types";
import { sanitizeProse } from "../src/generation/document-model";
import { generateApplicationDocuments } from "../src/generation/pipeline";
import {
  renderResumePdf,
  renderResumeDocx,
  renderCoverLetterPdf,
  renderCoverLetterDocx,
  saveGeneratedDocs,
} from "../src/generation/render";

function approvedLedger(): FactsLedger {
  return {
    profileId: "gen",
    approvedAt: new Date().toISOString(),
    facts: [
      { id: "sum1", type: "summary_point", approved: true, statement: "Operations analyst focused on claims review and process improvement" },
      { id: "e1", type: "employment", approved: true, title: "Senior Operations Analyst", employer: "Northwind Logistics", startDate: "2021", endDate: "present", bullets: ["Reviewed 120 claims per week, reducing backlog by 35%", "Led a team of 5 analysts across two regional offices"] },
      { id: "e2", type: "employment", approved: true, title: "Operations Analyst", employer: "Contoso Freight", startDate: "2018", endDate: "2021", bullets: ["Built dashboards that cut reporting time by 40%"] },
      { id: "ed1", type: "education", approved: true, institution: "State University", degree: "B.S. Industrial Engineering", graduationDate: "2018" },
      { id: "s1", type: "skill", approved: true, statement: "SQL" },
      { id: "s2", type: "skill", approved: true, statement: "Tableau" },
      { id: "c1", type: "certification", approved: true, name: "Lean Six Sigma Green Belt", dateEarned: "2020" },
    ],
  };
}

function profile(): ApplicantProfile {
  const p = createBlankProfile("gen");
  p.contact.legalFirstName = "Jane";
  p.contact.legalLastName = "Applicant";
  p.contact.email = "jane.applicant@example.com";
  p.contact.phone = "(415) 555-0137";
  p.contact.address.city = "San Francisco";
  p.contact.address.state = "CA";
  p.contact.links.linkedin = "https://linkedin.com/in/janeapplicant";
  return p;
}

const posting = parsePosting(
  `Operations Analyst
Acme Corp - San Francisco, CA

About the role
We are hiring an Operations Analyst to improve claims review and reporting.

Requirements
- 3+ years of experience in operations or claims analysis
- Strong SQL and Tableau skills
- Experience reducing backlog and improving reporting time
- Bachelor's degree`,
  { title: "Operations Analyst", company: "Acme Corp", location: "San Francisco, CA" }
);

describe("posting parser", () => {
  it("extracts requirements and ranks relevant keywords", () => {
    expect(posting.requirements.length).toBeGreaterThanOrEqual(3);
    expect(posting.keywords).toContain("sql");
    expect(posting.keywords).toContain("tableau");
  });
});

describe("positioning statement as LLM framing guidance", () => {
  // A capturing stub: records the prompt and returns minimal valid JSON for either doc.
  function capturingClient(): { client: LlmClient; prompts: string[] } {
    const prompts: string[] = [];
    const client: LlmClient = {
      model: "stub",
      provider: "stub",
      async complete(prompt: string) {
        prompts.push(prompt);
        if (prompt.includes("cover letter")) {
          return { text: JSON.stringify({
            date: "January 1, 2026", recipient: "Hiring Team", greeting: "Dear Hiring Manager,",
            paragraphs: ["I am applying."], closing: "Sincerely,", signature: "Jane Applicant",
          }) };
        }
        return { text: JSON.stringify({
          name: "Jane Applicant", contactLines: ["jane.applicant@example.com"],
          experience: [], education: [], skills: [], certifications: [],
        }) };
      },
    };
    return { client, prompts };
  }

  const ctxBase = (): GeneratorContext => ({
    approvedFacts: approvedLedger().facts,
    contact: profile().contact,
    posting,
  });

  it("injects the positioning into the prompt as emphasis-only framing", async () => {
    const { client, prompts } = capturingClient();
    await new LlmDocumentGenerator(client).generateResume({
      ...ctxBase(),
      positioning: {
        whatIDo: "I catch financial-crime risks",
        whoIServe: "mid-to-large financial institutions",
        whatResult: "fewer regulatory findings",
        updatedAt: new Date().toISOString(),
      },
    });
    expect(prompts[0]).toContain("STRATEGIC FRAMING");
    expect(prompts[0]).toContain("mid-to-large financial institutions");
    // Framed as guidance, NOT as a new source of facts.
    expect(prompts[0]).toMatch(/NOT a source of facts/i);
  });

  it("omits the framing block entirely when positioning is unset", async () => {
    const { client, prompts } = capturingClient();
    await new LlmDocumentGenerator(client).generateResume(ctxBase());
    expect(prompts[0]).not.toContain("STRATEGIC FRAMING");
  });
});

describe("template generation gated by the verifier", () => {
  it("produces submission-eligible resume + cover letter from approved facts", async () => {
    const result = await generateApplicationDocuments(approvedLedger(), profile(), posting, {
      generator: new TemplateDocumentGenerator(),
    });
    expect(result.generator).toBe("template");
    expect(result.resume.submissionEligible).toBe(true);
    expect(result.coverLetter.submissionEligible).toBe(true);
    expect(result.allEligible).toBe(true);
  });

  it("includes real facts and tailors toward the posting", async () => {
    const { resume } = await generateApplicationDocuments(approvedLedger(), profile(), posting, {
      generator: new TemplateDocumentGenerator(),
    });
    expect(resume.text).toContain("Northwind Logistics");
    expect(resume.text).toContain("120");
    expect(resume.text).toContain("SQL");
    // Most-recent role first.
    expect(resume.model.experience[0]!.header).toContain("Northwind Logistics");
    // In-progress / dated certification rendered without implying more than the fact states.
    expect(resume.model.certifications[0]).toContain("Lean Six Sigma Green Belt");
  });

  it("emits NO em-dashes", async () => {
    const { resume, coverLetter } = await generateApplicationDocuments(
      approvedLedger(),
      profile(),
      posting,
      { generator: new TemplateDocumentGenerator() }
    );
    expect(resume.text).not.toContain("—");
    expect(coverLetter.text).not.toContain("—");
    expect(sanitizeProse("led a team — across offices")).toBe("led a team - across offices");
  });
});

describe("LLM generator failure falls back to the template generator (commercial M3 fail-soft)", () => {
  class ThrowingGenerator implements DocumentGenerator {
    readonly name = "llm";
    async generateResume(): Promise<never> {
      throw new Error("fetch failed (LLM daemon down)");
    }
    async generateCoverLetter(): Promise<never> {
      throw new Error("fetch failed (LLM daemon down)");
    }
  }

  it("produces template documents instead of propagating the LLM error", async () => {
    const result = await generateApplicationDocuments(approvedLedger(), profile(), posting, {
      generator: new ThrowingGenerator(),
    });
    expect(result.generator).toBe("template");
    expect(result.resume.submissionEligible).toBe(true);
    expect(result.allEligible).toBe(true);
  });
});

describe("verifier gate blocks a fabricating generator", () => {
  // A generator that invents an employer and a metric.
  class FabricatingGenerator implements DocumentGenerator {
    readonly name = "fabricating";
    async generateResume(ctx: GeneratorContext) {
      return {
        name: "Jane Applicant",
        contactLines: ["jane.applicant@example.com"],
        experience: [
          {
            header: "Director, Globex Corporation (2019 - 2021)",
            bullets: ["Increased revenue by 250 percent"],
          },
        ],
        education: [],
        skills: [],
        certifications: [],
      };
    }
    async generateCoverLetter(ctx: GeneratorContext) {
      return {
        date: "June 16, 2026",
        recipient: `Hiring Team, ${ctx.posting.company}`,
        greeting: "Dear Hiring Manager,",
        paragraphs: ["I led teams at Northwind Logistics."],
        closing: "Sincerely,",
        signature: "Jane Applicant",
      };
    }
  }

  it("marks the fabricated resume NOT submission-eligible and surfaces the sentence", async () => {
    const result = await generateApplicationDocuments(approvedLedger(), profile(), posting, {
      generator: new FabricatingGenerator(),
      maxRepairs: 0,
    });
    expect(result.resume.submissionEligible).toBe(false);
    expect(result.allEligible).toBe(false);
    const reasons = result.resume.check.checks
      .filter((c) => !c.supported)
      .map((c) => `${c.claim.text} :: ${c.reason}`)
      .join(" | ");
    expect(reasons).toMatch(/Globex/);
    expect(reasons).toMatch(/250/);
  });
});

describe("ATS-friendly rendering", () => {
  it("renders valid PDF and DOCX bytes", async () => {
    const { resume, coverLetter } = await generateApplicationDocuments(
      approvedLedger(),
      profile(),
      posting,
      { generator: new TemplateDocumentGenerator() }
    );
    const rpdf = await renderResumePdf(resume.model);
    const rdocx = await renderResumeDocx(resume.model);
    const cpdf = await renderCoverLetterPdf(coverLetter.model);
    const cdocx = await renderCoverLetterDocx(coverLetter.model);

    expect(rpdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(cpdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    // DOCX is a zip container -> starts with "PK".
    expect(rdocx.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(cdocx.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(rpdf.length).toBeGreaterThan(500);
  });

  it("saves all four files to disk", async () => {
    const { resume, coverLetter } = await generateApplicationDocuments(
      approvedLedger(),
      profile(),
      posting,
      { generator: new TemplateDocumentGenerator() }
    );
    const dir = mkdtempSync(join(tmpdir(), "applypilot-gen-"));
    try {
      const saved = await saveGeneratedDocs(resume.model, coverLetter.model, dir, "acme-ops");
      for (const p of Object.values(saved)) {
        expect(existsSync(p)).toBe(true);
        expect(readFileSync(p).length).toBeGreaterThan(100);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
