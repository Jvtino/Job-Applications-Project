import { describe, it, expect } from "vitest";
import { checkBulletStrength } from "../src/generation/bullet-strength";

describe("checkBulletStrength", () => {
  it("flags 'Responsible for' as a weak opener", () => {
    const w = checkBulletStrength(["Responsible for managing a team of 5 analysts"]);
    expect(w).toHaveLength(1);
    expect(w[0]!.issue).toBe("weak_opener");
    expect(w[0]!.bullet).toContain("Responsible for");
  });

  it("flags 'Assisted with' as a weak opener", () => {
    const w = checkBulletStrength(["Assisted with the compliance reporting process"]);
    expect(w).toHaveLength(1);
    expect(w[0]!.issue).toBe("weak_opener");
  });

  it("flags a strong-verb bullet that lacks any quantifier", () => {
    const w = checkBulletStrength(["Reviewed claims across multiple regional offices"]);
    expect(w).toHaveLength(1);
    expect(w[0]!.issue).toBe("no_quantifier");
  });

  it("does not flag a strong bullet with a percentage metric", () => {
    const w = checkBulletStrength(["Reduced claim backlog by 35% within the first quarter"]);
    expect(w).toHaveLength(0);
  });

  it("does not flag a strong bullet with a headcount number", () => {
    const w = checkBulletStrength(["Led a team of 5 analysts across two regional offices"]);
    expect(w).toHaveLength(0);
  });

  it("does not flag a strong bullet with a dollar amount", () => {
    const w = checkBulletStrength(["Generated $2.4M in cost savings by automating reconciliation"]);
    expect(w).toHaveLength(0);
  });

  it("reports the correct mix across multiple bullets", () => {
    const bullets = [
      "Reviewed 120 claims per week, reducing backlog by 35%", // strong — no warning
      "Responsible for data entry and team coordination",       // weak opener
      "Led process improvement initiatives across the region",  // no quantifier
    ];
    const warnings = checkBulletStrength(bullets);
    expect(warnings).toHaveLength(2);
    const issues = warnings.map((w) => w.issue).sort();
    expect(issues).toEqual(["no_quantifier", "weak_opener"]);
  });

  it("ignores empty and whitespace-only bullets", () => {
    expect(checkBulletStrength(["", "   ", "\t"])).toHaveLength(0);
  });

  it("flags 'Helped to' as a weak opener (partial match)", () => {
    const w = checkBulletStrength(["Helped to streamline the onboarding workflow"]);
    expect(w).toHaveLength(1);
    expect(w[0]!.issue).toBe("weak_opener");
  });
});
