import { describe, it, expect } from "vitest";
import { buildRoleFocus, titleMatchesFocus, selectRoleRelevantPostings } from "../src/jobs/role-focus";

const AML_ROLES = ["AML Analyst", "KYC Analyst", "Sanctions Analyst"];

describe("role focus (family-aware)", () => {
  it("maps compliance roles to the compliance family", () => {
    expect(buildRoleFocus(["AML Analyst"]).families.has("compliance")).toBe(true);
  });

  it("matches AML-adjacent titles a literal substring would miss", () => {
    const focus = buildRoleFocus(AML_ROLES);
    for (const t of [
      "AML Operations Analyst",
      "Financial Crimes Investigator",
      "BSA Officer",
      "Fraud Operations Specialist",
      "Sanctions Screening Associate",
    ]) {
      expect(titleMatchesFocus(focus, t), t).toBe(true);
    }
  });

  it("excludes clearly off-target titles", () => {
    const focus = buildRoleFocus(AML_ROLES);
    for (const t of ["Senior Software Engineer", "Account Executive, Enterprise", "Revenue Accountant"]) {
      expect(titleMatchesFocus(focus, t), t).toBe(false);
    }
  });
});

describe("selectRoleRelevantPostings (starvation guard)", () => {
  const make = (titles: string[]) => titles.map((title) => ({ title }));

  it("focuses on relevant titles on a large board", () => {
    const postings = make([
      "AML Operations Analyst",
      "Financial Crimes Investigator",
      "Software Engineer II",
      "Account Executive",
      "Senior Revenue Accountant",
      "Customer Success Manager",
      "Frontend Engineer",
      "BSA Officer",
      "Data Engineer",
      "Sales Development Rep",
    ]);
    const { kept, usedFilter } = selectRoleRelevantPostings(postings, AML_ROLES);
    expect(usedFilter).toBe(true);
    const titles = kept.map((k) => k.title);
    expect(titles).toContain("AML Operations Analyst");
    expect(titles).toContain("Financial Crimes Investigator");
    expect(titles).toContain("BSA Officer");
    expect(titles).not.toContain("Software Engineer II");
    expect(titles).not.toContain("Account Executive");
  });

  it("never filters when no roles are configured", () => {
    const postings = make(["Anything", "Whatever"]);
    expect(selectRoleRelevantPostings(postings, []).usedFilter).toBe(false);
    expect(selectRoleRelevantPostings(postings, []).kept).toHaveLength(2);
  });

  it("keeps a SMALL board even when nothing matches (targeted employer safety net)", () => {
    const postings = make(["Operations Associate", "Office Coordinator"]); // a tiny bank board, no literal AML
    const { kept, usedFilter } = selectRoleRelevantPostings(postings, AML_ROLES);
    expect(usedFilter).toBe(false);
    expect(kept).toHaveLength(2);
  });
});
