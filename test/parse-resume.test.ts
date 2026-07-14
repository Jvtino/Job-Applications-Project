import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { parseResumeHeuristic } from "../src/ingestion/parse-resume";
import {
  addFact,
  approvedFacts,
  approveAll,
  buildLedger,
  finalizeApproval,
  removeFact,
  setApproved,
  summarizeLedger,
} from "../src/ingestion/ledger-ops";
import type { CertificationFact, EmploymentFact, GenericFact } from "../src/types/facts-ledger";

const here = dirname(fileURLToPath(import.meta.url));
const sample = readFileSync(join(here, "fixtures", "sample-resume.txt"), "utf8");

describe("heuristic resume parsing", () => {
  const { facts, warnings } = parseResumeHeuristic(sample);

  it("extracts employment entries with employer, title, and dates", () => {
    const employment = facts.filter((f): f is EmploymentFact => f.type === "employment");
    const employers = employment.map((e) => e.employer);
    expect(employers).toContain("Northwind Logistics");
    expect(employers).toContain("Contoso Freight");

    const northwind = employment.find((e) => e.employer === "Northwind Logistics")!;
    expect(northwind.title).toBe("Senior Operations Analyst");
    expect(northwind.startDate).toContain("2021");
    expect(northwind.endDate).toBe("present");
    expect(northwind.bullets.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps numeric bullets inside employment and captures education, skills, certifications, and contact", () => {
    // A numeric bullet is a source claim: it stays inside the employment fact and is NOT
    // duplicated as a standalone metric fact.
    const northwind = facts.find(
      (f): f is EmploymentFact => f.type === "employment" && f.employer === "Northwind Logistics"
    );
    expect(northwind?.bullets.some((b) => /120 claims per week/.test(b))).toBe(true);
    expect(facts.some((f) => f.type === "metric")).toBe(false);
    expect(facts.some((f) => f.type === "education")).toBe(true);
    expect(facts.some((f) => f.type === "skill" && /SQL/i.test((f as { statement: string }).statement))).toBe(true);
    expect(facts.some((f) => f.type === "certification")).toBe(true);
    expect(facts.some((f) => f.type === "contact" && /@/.test((f as { statement: string }).statement))).toBe(true);
    expect(warnings).toHaveLength(0);
  });

  it("marks every parsed fact UNAPPROVED until the user reviews it", () => {
    expect(facts.every((f) => f.approved === false)).toBe(true);
  });

  it("does not duplicate numeric employment bullets as separate metric facts", () => {
    const resume = [
      "EXPERIENCE",
      "Senior Operations Analyst - Northwind Logistics 2021 - Present",
      "- Reviewed 120 claims per week, reducing backlog by 35%.",
    ].join("\n");

    const { facts } = parseResumeHeuristic(resume);
    const employment = facts.filter((f): f is EmploymentFact => f.type === "employment");
    const metrics = facts.filter((f) => f.type === "metric");

    expect(employment).toHaveLength(1);
    expect(employment[0]!.bullets).toEqual([
      "Reviewed 120 claims per week, reducing backlog by 35%.",
    ]);
    expect(metrics).toHaveLength(0);
  });

  it("keeps multiple numeric bullets grouped under the same employment fact", () => {
    const resume = [
      "EXPERIENCE",
      "AML & Risk Analyst",
      "London Stock Exchange Group (LSEG) | Gdynia, Poland | Aug 2023 - Oct 2025",
      "- Conducted 200+ enhanced due diligence investigations annually.",
      "- Reduced escalation delays by 18% through better case triage.",
    ].join("\n");

    const { facts } = parseResumeHeuristic(resume);
    const employment = facts.filter((f): f is EmploymentFact => f.type === "employment");
    const metrics = facts.filter((f) => f.type === "metric");

    expect(employment).toHaveLength(1);
    expect(employment[0]!.employer).toContain("London Stock Exchange Group");
    expect(employment[0]!.bullets).toEqual([
      "Conducted 200+ enhanced due diligence investigations annually.",
      "Reduced escalation delays by 18% through better case triage.",
    ]);
    expect(metrics).toHaveLength(0);
  });

  it("joins a PDF-wrapped professional summary into a single summary_point", () => {
    const resume = [
      "PROFESSIONAL SUMMARY",
      "AML and Financial Crime Analyst with 2+ years of experience supporting global financial institutions through enhanced",
      "due diligence (EDD), KYC lifecycle management, sanctions screening, and regulatory compliance. Experienced in",
      "identifying financial crime risks, conducting complex investigations, assessing beneficial ownership structures, and",
      "supporting SAR escalation workflows. Strong knowledge of FATF guidance, sanctions compliance, risk assessment",
      "methodologies, and audit-ready documentation. Currently expanding expertise in U.S. regulatory frameworks, including",
      "BSA, USA PATRIOT Act, OFAC, and FinCEN requirements.",
      "CORE SKILLS",
      "AML Compliance • KYC • OFAC Compliance",
    ].join("\n");

    const { facts } = parseResumeHeuristic(resume);
    const summary = facts.filter((f): f is GenericFact => f.type === "summary_point");

    expect(summary).toHaveLength(1);
    expect(summary[0]!.statement).toBe(
      "AML and Financial Crime Analyst with 2+ years of experience supporting global financial institutions through enhanced " +
        "due diligence (EDD), KYC lifecycle management, sanctions screening, and regulatory compliance. Experienced in " +
        "identifying financial crime risks, conducting complex investigations, assessing beneficial ownership structures, and " +
        "supporting SAR escalation workflows. Strong knowledge of FATF guidance, sanctions compliance, risk assessment " +
        "methodologies, and audit-ready documentation. Currently expanding expertise in U.S. regulatory frameworks, including " +
        "BSA, USA PATRIOT Act, OFAC, and FinCEN requirements."
    );
  });

  it("keeps explicitly bulleted summary lines as separate summary_point claims", () => {
    const resume = [
      "SUMMARY",
      "- Analyst with 2+ years in AML.",
      "- Skilled in KYC and sanctions screening.",
    ].join("\n");

    const { facts } = parseResumeHeuristic(resume);
    const summary = facts.filter((f): f is GenericFact => f.type === "summary_point");

    expect(summary.map((f) => f.statement)).toEqual([
      "Analyst with 2+ years in AML.",
      "Skilled in KYC and sanctions screening.",
    ]);
  });
});

describe("heuristic parsing of date-on-next-line layouts (PDF wrap)", () => {
  const wrapped = [
    "EXPERIENCE",
    "Senior Product Manager — Acme Corp",
    "2020 - Present",
    "- Shipped a new onboarding flow that lifted activation 22%.",
    "Product Manager — Globex",
    "2017 - 2020",
    "- Owned the analytics roadmap.",
  ].join("\n");

  it("pairs a header line with a date range on the following line", () => {
    const { facts } = parseResumeHeuristic(wrapped);
    const employment = facts.filter((f): f is EmploymentFact => f.type === "employment");
    const employers = employment.map((e) => e.employer);
    expect(employers).toContain("Acme Corp");
    expect(employers).toContain("Globex");

    const acme = employment.find((e) => e.employer === "Acme Corp")!;
    expect(acme.title).toBe("Senior Product Manager");
    expect(acme.startDate).toContain("2020");
    expect(acme.endDate).toBe("present");
    expect(acme.bullets.length).toBeGreaterThanOrEqual(1);
  });
});

describe("heuristic parsing of qualified headers and inline sections", () => {
  const resume = [
    "PROFESSIONAL SUMMARY",
    "AML analyst with 2+ years across sanctions screening and KYC.",
    "CORE SKILLS",
    "AML Compliance • KYC • OFAC Compliance • Sanctions Screening • World-Check One",
    "Languages: Turkish (Native) | English (Native)",
    "WORK HISTORY",
    "AML & Risk Analyst",
    "London Stock Exchange Group (LSEG) | Gdynia, Poland | Aug 2023 - Oct 2025",
    "- Conducted 200+ enhanced due diligence investigations annually.",
  ].join("\n");
  const { facts } = parseResumeHeuristic(resume);

  it("recognizes 'CORE SKILLS' (not just 'SKILLS') and splits the list", () => {
    const skills = facts.filter((f) => f.type === "skill").map((f) => (f as { statement: string }).statement);
    expect(skills).toContain("AML Compliance");
    expect(skills).toContain("OFAC Compliance");
    expect(skills).toContain("World-Check One");
  });

  it("captures an inline 'Languages: a | b' header line", () => {
    const langs = facts.filter((f) => f.type === "language").map((f) => (f as { statement: string }).statement);
    expect(langs).toContain("Turkish (Native)");
    expect(langs).toContain("English (Native)");
  });

  it("classifies a 'PROFESSIONAL SUMMARY' header", () => {
    expect(facts.some((f) => f.type === "summary_point")).toBe(true);
  });

  it("pairs a bare title line with the employer/location/date line below it", () => {
    const lseg = facts.find(
      (f): f is EmploymentFact => f.type === "employment" && /lseg|london stock/i.test(f.employer)
    );
    expect(lseg).toBeDefined();
    expect(lseg!.title).toBe("AML & Risk Analyst");
    expect(lseg!.employer).toContain("London Stock Exchange Group");
    expect(lseg!.startDate).toContain("2023");
  });
});

describe("heuristic joining of PDF-wrapped items (all prose sections, not skills)", () => {
  it("joins a certification wrapped across several lines into one fact", () => {
    const resume = [
      "CERTIFICATIONS",
      "Federal Law Enforcement Recruitment Process: Participated in a multi-stage federal law enforcement recruitment",
      "process during a career transition period, reinforcing interest in investigative, risk, compliance, confidentiality, and public-",
      "trust focused work. 02/2026 – 06/2026 (2026)",
    ].join("\n");

    const { facts } = parseResumeHeuristic(resume);
    const certs = facts.filter((f): f is CertificationFact => f.type === "certification");

    expect(certs).toHaveLength(1);
    // The hyphenated wrap ("public-" + "trust") rejoins without a space.
    expect(certs[0]!.name).toContain("and public-trust focused work.");
    expect(certs[0]!.name).toContain("Federal Law Enforcement Recruitment Process:");
    expect(certs[0]!.name).toContain("career transition period");
    expect(certs[0]!.dateEarned).toBe("2026");
  });

  it("keeps two distinct (capitalized) certifications separate", () => {
    const resume = [
      "CERTIFICATIONS",
      "Lean Six Sigma Green Belt 2020",
      "CAMS - Certified Anti-Money Laundering Specialist 2023",
    ].join("\n");

    const { facts } = parseResumeHeuristic(resume);
    const certs = facts.filter((f): f is CertificationFact => f.type === "certification");
    expect(certs).toHaveLength(2);
  });

  it("rejoins a bullet whose tail wrapped onto its own line", () => {
    const resume = [
      "EXPERIENCE",
      "AML Analyst - Acme Bank 2021 - Present",
      "- Conducted 200+ enhanced due diligence investigations annually and reduced escalation",
      "delays by 18% through better case triage.",
    ].join("\n");

    const { facts } = parseResumeHeuristic(resume);
    const employment = facts.filter((f): f is EmploymentFact => f.type === "employment");
    expect(employment).toHaveLength(1);
    expect(employment[0]!.bullets).toEqual([
      "Conducted 200+ enhanced due diligence investigations annually and reduced escalation delays by 18% through better case triage.",
    ]);
  });
});

describe("ledger approval flow", () => {
  it("only approved facts are usable; add/remove/approve-all behave", () => {
    const { facts } = parseResumeHeuristic(sample);
    let ledger = buildLedger("p1", facts);

    // Nothing usable before review.
    expect(approvedFacts(ledger)).toHaveLength(0);

    // Approve a single fact.
    const first = ledger.facts[0]!;
    ledger = setApproved(ledger, first.id, true);
    expect(approvedFacts(ledger)).toHaveLength(1);

    // Approve everything.
    ledger = approveAll(ledger);
    expect(approvedFacts(ledger).length).toBe(ledger.facts.length);

    // Delete a wrong fact.
    const before = ledger.facts.length;
    ledger = removeFact(ledger, first.id);
    expect(ledger.facts.length).toBe(before - 1);

    // Add a user-authored fact (approved by assertion).
    ledger = addFact(ledger, {
      type: "achievement",
      approved: true,
      statement: "Volunteer tax preparer, 2 seasons",
    });
    expect(approvedFacts(ledger).some((f) => f.type === "achievement")).toBe(true);

    // Finalizing stamps approvedAt once something is approved.
    ledger = finalizeApproval(ledger);
    expect(ledger.approvedAt).toBeTruthy();

    const summary = summarizeLedger(ledger);
    expect(summary.approved).toBe(summary.total);
  });

  it("does not stamp approvedAt when nothing is approved", () => {
    const { facts } = parseResumeHeuristic(sample);
    const ledger = finalizeApproval(buildLedger("p1", facts));
    expect(ledger.approvedAt).toBeUndefined();
  });
});
