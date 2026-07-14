import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase, type DB } from "../src/db/database";
import { ApplicationDraftsRepo } from "../src/db/application-drafts-repo";
import { LedgerRepo } from "../src/db/ledger-repo";
import { ProfileRepo } from "../src/db/profile-repo";
import { createBlankProfile } from "../src/profile/factory";
import { runGenerate } from "../src/server/generate-runner";
import type { FactsLedger } from "../src/types/facts-ledger";

describe("application drafts", () => {
  let dir: string;
  let db: DB;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "applypilot-drafts-"));
    db = openDatabase(join(dir, "drafts.sqlite"));

    const profile = createBlankProfile("drafts");
    profile.contact.legalFirstName = "Jane";
    profile.contact.legalLastName = "Applicant";
    profile.contact.email = "jane@example.com";
    profile.contact.phone = "(415) 555-0137";
    profile.dynamicAnswers = [
      {
        key: "why_this_role",
        questionText: "Why are you interested in this role?",
        fieldType: "text",
        answer: "I like SaaS roles with measurable customer impact.",
        updatedAt: new Date().toISOString(),
      },
    ];
    new ProfileRepo(db, undefined).save(profile);

    const ledger: FactsLedger = {
      profileId: profile.id,
      approvedAt: new Date().toISOString(),
      facts: [
        { id: "sum", type: "summary_point", approved: true, statement: "Product manager focused on SaaS onboarding and retention" },
        {
          id: "job",
          type: "employment",
          approved: true,
          employer: "Northwind SaaS",
          title: "Senior Product Manager",
          startDate: "2021",
          endDate: "present",
          bullets: ["Improved onboarding activation by 18 percent", "Partnered with design and engineering on self-serve workflows"],
        },
        { id: "skill", type: "skill", approved: true, statement: "SaaS product strategy" },
      ],
    };
    new LedgerRepo(db, undefined).save(ledger);
  });

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("saves a generated packet as a reviewable application draft", async () => {
    const result = await runGenerate(db, undefined, join(dir, "generated"), {
      company: "Acme SaaS",
      title: "Senior Product Manager",
      location: "Remote US",
      postingUrl: "https://jobs.example.com/acme-saas/123",
      postingText: "Acme SaaS needs a Senior Product Manager for onboarding, activation, and self-serve product strategy.",
    });

    expect(result.draft.status).toBe("saved");
    expect(result.draft.company).toBe("Acme SaaS");
    expect(result.draft.applyUrl).toBe("https://jobs.example.com/acme-saas/123");
    expect(result.draft.applicationAnswers).toEqual([
      {
        question: "Why are you interested in this role?",
        answer: "I like SaaS roles with measurable customer impact.",
      },
    ]);

    const repo = new ApplicationDraftsRepo(db);
    const saved = repo.list("drafts");
    expect(saved).toHaveLength(1);
    expect(repo.setStatus("drafts", saved[0]!.id, "interviewing")).toBe(true);
    expect(repo.list("drafts")[0]!.status).toBe("interviewing");
  });
});
