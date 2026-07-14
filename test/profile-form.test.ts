// In-app profile setup (M2) — the form<->profile bridge + the GET/POST /api/profile endpoint.
//
// The safety-critical property: a value the USER supplies in the form is written source:"user"
// (confirmed) so the gate may auto-submit it; a BLANK field is left untouched (never fabricated or
// downgraded); "decline" becomes the explicit DECLINE marker. Mirrors the `setup` CLI wizard.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { openDatabase, type DB } from "../src/db/database";
import { ProfileRepo } from "../src/db/profile-repo";
import { LedgerRepo } from "../src/db/ledger-repo";
import { createBlankProfile } from "../src/profile/factory";
import { startApiServer } from "../src/server/api";
import { applyFormToProfile, coerceForm, profileToForm, EMPTY_FORM, type ProfileForm } from "../src/server/profile-form";
import { DECLINE } from "../src/types/applicant-profile";

function filledForm(over: Partial<ProfileForm> = {}): ProfileForm {
  return {
    ...EMPTY_FORM,
    legalFirstName: "Jane", legalLastName: "Applicant", email: "jane@example.com", phone: "(415) 555-0137",
    addressLine1: "1 Main St", city: "San Francisco", state: "CA", postalCode: "94105",
    authorizedToWorkInUS: "yes", requiresSponsorship: "no", currentWorkStatus: "us_citizen",
    isAtLeast18: "yes", willingToRelocate: "no", workModes: ["remote", "hybrid"],
    targetRoles: "Senior Product Manager, Product Lead",
    targetIndustries: "AI, SaaS",
    yearsOfExperience: "10",
    companiesToAvoid: "Acme Staffing, LowSignal Jobs",
    jobLevel: "senior",
    employmentTypes: ["full_time", "contract"],
    desiredLocations: "Remote US, New York, NY", desiredBaseMin: "160000", isNegotiable: true,
    gender: "female", veteranStatus: "decline", disability: "no_disability",
    customAnswers: [{ questionText: "Why are you interested in this role?", answer: "I like product roles with measurable customer impact." }],
    ...over,
  };
}

async function listening(server: http.Server): Promise<string> {
  await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("profile-form converter", () => {
  it("marks user-supplied answers source:user and maps decline -> DECLINE", () => {
    const p = applyFormToProfile(createBlankProfile("x"), filledForm());
    expect(p.contact.legalFirstName).toBe("Jane");
    expect(p.contact.address.country).toBe("US");
    expect(p.workAuthorization.authorizedToWorkInUS).toMatchObject({ value: true, source: "user" });
    expect(p.workAuthorization.requiresSponsorshipNowOrFuture.source).toBe("user");
    expect(p.screening.isAtLeast18).toMatchObject({ value: true, source: "user" });
    // "City, ST" stays intact: a bare 2-letter state abbr re-joins its preceding city (parseLocationList),
    // fixing the bug that shredded "Brooklyn, NY" into ["Brooklyn","NY"].
    expect(p.preferences.desiredLocations).toEqual(["Remote US", "New York, NY"]);
    expect(p.preferences.targetIndustries).toEqual(["AI", "SaaS"]);
    expect(p.preferences.yearsOfExperience).toBe(10);
    expect(p.preferences.jobLevel).toBe("senior");
    expect(p.preferences.employmentTypes).toEqual(["full_time", "contract"]);
    expect(p.preferences.companiesToAvoid).toEqual(["Acme Staffing", "LowSignal Jobs"]);
    expect(p.preferences.compensation.desiredBaseMin).toBe(160000);
    expect(p.selfId.gender).toMatchObject({ value: "female", source: "user" });
    expect(p.selfId.veteran.status).toMatchObject({ value: DECLINE, source: "user" });
    expect(p.selfId.disability.value).toBe("no_disability");
    expect(p.dynamicAnswers).toHaveLength(1);
    expect(p.dynamicAnswers[0]).toMatchObject({
      questionText: "Why are you interested in this role?",
      answer: "I like product roles with measurable customer impact.",
    });
  });

  it("leaves a field untouched when the form value is blank (no fabrication)", () => {
    const p = applyFormToProfile(createBlankProfile("y"), filledForm({ isAtLeast18: "", gender: "" }));
    expect(p.screening.isAtLeast18.value).toBeNull();
    expect(p.screening.isAtLeast18.source).toBe("default"); // untouched, not invented
    expect(p.selfId.gender.value).toBeNull();
    expect(p.selfId.raceEthnicity.value).toBeNull();
  });

  it("round-trips through profileToForm", () => {
    const f = profileToForm(applyFormToProfile(createBlankProfile("z"), filledForm()));
    expect(f.legalFirstName).toBe("Jane");
    expect(f.authorizedToWorkInUS).toBe("yes");
    expect(f.requiresSponsorship).toBe("no");
    expect(f.workModes).toEqual(["remote", "hybrid"]);
    expect(f.targetIndustries).toBe("AI, SaaS");
    expect(f.yearsOfExperience).toBe("10");
    expect(f.companiesToAvoid).toBe("Acme Staffing, LowSignal Jobs");
    expect(f.jobLevel).toBe("senior");
    expect(f.employmentTypes).toEqual(["full_time", "contract"]);
    expect(f.desiredLocations).toBe("Remote US, New York, NY");
    expect(f.desiredBaseMin).toBe("160000");
    expect(f.gender).toBe("female");
    expect(f.veteranStatus).toBe("decline");
    expect(f.customAnswers?.[0]?.questionText).toBe("Why are you interested in this role?");
  });

  it("captures the positioning statement and round-trips it", () => {
    const p = applyFormToProfile(
      createBlankProfile("pos"),
      filledForm({
        positioningWhatIDo: "I catch financial-crime risks before they become regulatory problems",
        positioningWhoIServe: "mid-to-large financial institutions",
        positioningWhatResult: "fewer regulatory findings",
      })
    );
    expect(p.positioning).toMatchObject({
      whatIDo: "I catch financial-crime risks before they become regulatory problems",
      whoIServe: "mid-to-large financial institutions",
      whatResult: "fewer regulatory findings",
    });
    expect(typeof p.positioning?.updatedAt).toBe("string");
    const f = profileToForm(p);
    expect(f.positioningWhoIServe).toBe("mid-to-large financial institutions");
  });

  it("leaves an existing positioning untouched when all three fields are blank", () => {
    const base = applyFormToProfile(
      createBlankProfile("pos2"),
      filledForm({ positioningWhatIDo: "AML analyst", positioningWhoIServe: "banks", positioningWhatResult: "clean audits" })
    );
    // A later save where the user didn't touch positioning must NOT wipe it.
    const after = applyFormToProfile(base, filledForm({ positioningWhatIDo: "", positioningWhoIServe: "", positioningWhatResult: "" }));
    expect(after.positioning?.whatIDo).toBe("AML analyst");
  });

  it("coerceForm defends against partial / garbage JSON", () => {
    const f = coerceForm({
      legalFirstName: "A",
      workModes: ["remote", "bogus"],
      employmentTypes: ["full_time", "mystery"],
      jobLevel: "executive",
      customAnswers: [{ questionText: "Q", answer: "A" }, { questionText: "", answer: "" }, "bad"],
      isNegotiable: "nope",
    } as Record<string, unknown>);
    expect(f.legalFirstName).toBe("A");
    expect(f.workModes).toEqual(["remote"]); // bogus mode filtered out
    expect(f.employmentTypes).toEqual(["full_time"]);
    expect(f.jobLevel).toBe("executive");
    expect(f.customAnswers).toEqual([{ questionText: "Q", answer: "A" }]);
    expect(f.isNegotiable).toBe(true); // non-boolean -> default
    expect(f.email).toBe(""); // missing -> blank
  });
});

describe("GET/POST /api/profile", () => {
  let dir: string;
  let db: DB;
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "applypilot-prof-"));
    db = openDatabase(join(dir, "p.sqlite"));
    server = startApiServer(0, { db, envPath: join(dir, ".env") });
    base = await listening(server);
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts unconfigured, saves a profile (source:user), and reads it back", async () => {
    const before = await (await fetch(`${base}/api/profile`)).json();
    expect(before.configured).toBe(false);

    const post = await fetch(`${base}/api/profile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(filledForm()),
    });
    expect(post.status).toBe(200);
    const pbody = await post.json();
    expect(pbody.configured).toBe(true);
    expect(pbody.form.legalFirstName).toBe("Jane");

    const after = await (await fetch(`${base}/api/profile`)).json();
    expect(after.configured).toBe(true);
    expect(after.form.email).toBe("jane@example.com");

    // The persisted profile carries user-confirmed provenance (so the gate may use it).
    const saved = new ProfileRepo(db, undefined).getFirst();
    expect(saved?.workAuthorization.authorizedToWorkInUS.source).toBe("user");
    expect(saved?.selfId.veteran.status.value).toBe(DECLINE);
  });

  it("POST /api/profile/reset clears profile data and returns a blank form", async () => {
    const post = await fetch(`${base}/api/profile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(filledForm()),
    });
    expect(post.status).toBe(200);

    const ledgerRepo = new LedgerRepo(db, undefined);
    const profileBefore = new ProfileRepo(db, undefined).getFirst()!;
    ledgerRepo.save({ profileId: profileBefore.id, facts: [] });

    const reset = await fetch(`${base}/api/profile/reset`, { method: "POST" });
    expect(reset.status).toBe(200);
    const body = await reset.json();
    expect(body.configured).toBe(true);
    expect(body.form.legalFirstName).toBe("");
    expect(body.form.email).toBe("");

    const after = await (await fetch(`${base}/api/profile`)).json();
    expect(after.configured).toBe(true);
    expect(after.form.email).toBe("");

    const saved = new ProfileRepo(db, undefined).getFirst();
    expect(saved?.contact.email).toBe("");
    expect(ledgerRepo.get(saved!.id)).toBeUndefined();
  });
});
