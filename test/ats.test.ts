import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import {
  decideFillAction,
  canAutoSubmit,
  type FormField,
  type MatchResult,
  type PageContext,
} from "../src/ats/adapter";
import { pickAdapter } from "../src/ats/adapters";
import { LayeredFieldMatcher, resolveOption } from "../src/ats/field-matcher";
import { openDatabase, type DB } from "../src/db/database";
import {
  ApplicationsRepo,
  DuplicateApplicationError,
  RateLimitedError,
  dedupKeyForUrl,
} from "../src/db/applications-repo";
import { createBlankProfile } from "../src/profile/factory";

const matcher = new LayeredFieldMatcher();
function field(p: Partial<FormField>): FormField {
  return { ref: "r", label: "", controlType: "text", required: false, ...p };
}

describe("pickAdapter routes by host before Greenhouse's generic DOM signature", () => {
  // Fake the live situation: a real jobs.lever.co / jobs.ashbyhq.com apply form whose DOM looks
  // Greenhouse-ish (#first_name + #email present) but carries NO Lever/Ashby-specific DOM markers.
  // The only reliable signal is the host, so routing must be decided by host order, not by
  // Greenhouse's generic core check grabbing the form first. evaluate() is keyed off the detect
  // function's source: Greenhouse's DOM check (it references "first_name") returns true; the
  // Lever/Ashby DOM checks (no such marker) return false.
  function ctxFor(url: string): PageContext {
    const page = {
      url: () => url,
      evaluate: async (fn: (...a: unknown[]) => unknown) =>
        /first_name/.test(fn.toString()),
    };
    return { url, page } as unknown as PageContext;
  }

  it("routes a lever.co page to Lever even when greenhouse-ish field ids are present", async () => {
    const ctx = ctxFor("https://jobs.lever.co/gohighlevel/abc-123/apply");
    expect((await pickAdapter(ctx)).name).toBe("lever");
  });

  it("routes an ashbyhq.com page to Ashby even when greenhouse-ish field ids are present", async () => {
    const ctx = ctxFor("https://jobs.ashbyhq.com/acme/uuid/application");
    expect((await pickAdapter(ctx)).name).toBe("ashby");
  });

  it("still routes a real greenhouse host to Greenhouse", async () => {
    const ctx = ctxFor("https://boards.greenhouse.io/acme/jobs/123");
    expect((await pickAdapter(ctx)).name).toBe("greenhouse");
  });

  // A DOM whose only "signal" is the generic marker named by `present` (and which is on a non-ATS
  // host) must fall through to the generic fallback — never be mislabeled as a real ATS, since that
  // label is auto-submit-allowlisted. evaluate() returns true iff a detector's selector source
  // mentions `present`.
  function ctxWith(url: string, present: RegExp): PageContext {
    const page = { url: () => url, evaluate: async (fn: (...a: unknown[]) => unknown) => present.test(fn.toString()) };
    return { url, page } as unknown as PageContext;
  }

  it("routes a bare #first_name+#email form on a non-ATS host to generic, not greenhouse", async () => {
    const ctx = ctxWith("https://careers.acme.com/apply", /first_name/);
    expect((await pickAdapter(ctx)).name).toBe("generic");
  });

  it("routes a generic .application-form on a non-ATS host to generic, not lever", async () => {
    // Leading dot = the class selector ".application-form" specifically (Lever's old generic marker),
    // NOT Greenhouse's legitimate id selector "form#application-form".
    const ctx = ctxWith("https://careers.acme.com/apply", /\.application-form/);
    expect((await pickAdapter(ctx)).name).toBe("generic");
  });
});

describe("classifyRisk", () => {
  it("routes labels to the right risk tier", () => {
    expect(matcher.classifyRisk(field({ label: "Gender" }))).toBe("self_id");
    expect(matcher.classifyRisk(field({ label: "Disability Status" }))).toBe("self_id");
    expect(matcher.classifyRisk(field({ label: "Are you legally authorized to work in the US?" }))).toBe("authorization");
    expect(matcher.classifyRisk(field({ label: "Will you require sponsorship?" }))).toBe("authorization");
    expect(matcher.classifyRisk(field({ label: "Are you at least 18 years of age?" }))).toBe("knockout");
    expect(matcher.classifyRisk(field({ label: "Email" }))).toBe("identity");
    expect(matcher.classifyRisk(field({ label: "Desired salary" }))).toBe("compensation");
    expect(matcher.classifyRisk(field({ label: "How did you hear about us?" }))).toBe("low_stakes");
  });
});

describe("resolveOption (deterministic synonym/fuzzy mapping)", () => {
  it("maps semantic synonyms to rendered options", () => {
    expect(resolveOption(["female", "woman"], ["Male", "Female"])?.value).toBe("Female");
    expect(resolveOption(["yes"], ["Yes", "No"])?.method).toBe("exact");
    expect(
      resolveOption(["no, i do not have a disability"], [
        "Yes, I have a disability",
        "No, I do not have a disability and have not had one in the past",
      ])?.value
    ).toContain("No, I do not have a disability");
  });
});

describe("matcher resolves profile values with provenance", () => {
  it("maps work authorization Yes/No and carries source", async () => {
    const p = createBlankProfile("x");
    p.workAuthorization.authorizedToWorkInUS = { value: true, source: "user", updatedAt: "" };
    const m = await matcher.match(
      field({ label: "Are you legally authorized to work in the United States?", controlType: "native_select", options: ["Yes", "No"], required: true }),
      p,
      []
    );
    expect(m.resolvedValue).toBe("Yes");
    expect(m.risk).toBe("authorization");
    expect(m.source).toBe("user");
  });

  it("returns unmapped for an unknown required field (so the policy pauses)", async () => {
    const p = createBlankProfile("x");
    const m = await matcher.match(field({ label: "Why do you want to work here?", required: true, controlType: "textarea" }), p, []);
    expect(m.method).toBe("unmapped");
    expect(m.resolvedValue).toBeNull();
  });
});

describe("decideFillAction risk policy (the exact brief gate)", () => {
  const base = (over: Partial<MatchResult>): MatchResult => ({
    field: field({ required: false }),
    risk: "identity",
    resolvedValue: "x",
    source: "user",
    method: "exact",
    confidence: 1,
    rationale: "",
    ...over,
  });

  it("never fills in manual mode", () => {
    expect(decideFillAction(base({}), "manual")).toBe("skip");
  });

  it("pauses a required field with no resolved value", () => {
    expect(decideFillAction(base({ resolvedValue: null, field: field({ required: true }) }), "semi_auto")).toBe("pause_for_confirmation");
  });

  it("A5: pauses (never fills) unconfirmed high-stakes self-id in semi_auto", () => {
    const m = base({ risk: "self_id", source: "default", confidence: 1 });
    expect(decideFillAction(m, "semi_auto")).toBe("pause_for_confirmation");
  });

  it("A5: pauses inferred work authorization before filling it", () => {
    const m = base({ risk: "authorization", source: "inferred", confidence: 1 });
    expect(decideFillAction(m, "semi_auto")).toBe("pause_for_confirmation");
    expect(decideFillAction(m, "auto")).toBe("pause_for_confirmation");
  });

  it("A5: pauses inferred/default EEO, veteran, and disability self-id", () => {
    for (const source of ["inferred", "default"] as const) {
      const m = base({ risk: "self_id", source, confidence: 1 });
      expect(decideFillAction(m, "semi_auto")).toBe("pause_for_confirmation");
      expect(decideFillAction(m, "auto")).toBe("pause_for_confirmation");
    }
  });

  it("A5: a USER-confirmed high-stakes value may still fill in semi_auto", () => {
    const m = base({ risk: "authorization", source: "user", confidence: 1 });
    expect(decideFillAction(m, "semi_auto")).toBe("fill");
  });

  it("pauses unconfirmed high-stakes in auto", () => {
    const m = base({ risk: "self_id", source: "default", confidence: 1 });
    expect(decideFillAction(m, "auto")).toBe("pause_for_confirmation");
  });

  it("refuses an LLM-proposed knockout match in auto even at high confidence", () => {
    const m = base({ risk: "knockout", source: "user", method: "llm", confidence: 1 });
    expect(decideFillAction(m, "auto")).toBe("pause_for_confirmation");
  });

  it("fills a user-confirmed identity field in semi_auto", () => {
    expect(decideFillAction(base({}), "semi_auto")).toBe("fill");
  });
});

describe("canAutoSubmit", () => {
  it("is false unless auto mode and nothing needs a human", () => {
    const empty = { filled: [], flaggedForReview: [], needsConfirmation: [], challengeDetected: false };
    expect(canAutoSubmit(empty, "semi_auto")).toBe(false);
    expect(canAutoSubmit(empty, "auto")).toBe(true);
    expect(canAutoSubmit({ ...empty, challengeDetected: true }, "auto")).toBe(false);
    expect(canAutoSubmit({ ...empty, needsConfirmation: [{} as MatchResult] }, "auto")).toBe(false);
    expect(canAutoSubmit({ ...empty, flaggedForReview: [{} as MatchResult] }, "auto")).toBe(true);
  });
});

describe("applications repo: hard dedup + per-company rate limit", () => {
  let dir: string;
  let db: DB;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "applypilot-apps-"));
    db = openDatabase(join(dir, "a.sqlite"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("blocks a duplicate SUBMITTED application, but allows retry of a paused one", () => {
    const repo = new ApplicationsRepo(db);
    const key = dedupKeyForUrl("https://boards.greenhouse.io/acme/jobs/123?utm=x");
    repo.assertCanApply("p", key, "Acme");
    // A paused/incomplete attempt (e.g. account_required) does NOT block a retry.
    repo.record({ profileId: "p", dedupKey: key, company: "Acme", status: "account_required", submitted: false });
    expect(() => repo.assertCanApply("p", key, "Acme")).not.toThrow();
    // A SUBMITTED application blocks re-submission.
    repo.record({ profileId: "p", dedupKey: key, company: "Acme", status: "submitted", submitted: true });
    expect(() => repo.assertCanApply("p", key, "Acme")).toThrow(DuplicateApplicationError);
  });

  it("enforces the per-company cap on submitted applications only", () => {
    const repo = new ApplicationsRepo(db);
    const cfg = { perCompanyWindowMs: 24 * 3600_000, perCompanyMax: 2 };
    repo.record({ profileId: "p", dedupKey: "acme/jobs/0", company: "Acme", status: "needs_review", submitted: false });
    repo.record({ profileId: "p", dedupKey: "acme/jobs/1", company: "Acme", status: "submitted", submitted: true });
    repo.record({ profileId: "p", dedupKey: "acme/jobs/2", company: "Acme", status: "submitted", submitted: true });
    expect(() => repo.assertCanApply("p", "acme/jobs/9", "Acme", cfg)).toThrow(RateLimitedError);
    expect(() => repo.assertCanApply("p", "other/jobs/1", "Globex", cfg)).not.toThrow();
  });

  it("paused applications do not count toward per-company cap", () => {
    const repo = new ApplicationsRepo(db);
    const cfg = { perCompanyWindowMs: 24 * 3600_000, perCompanyMax: 2 };
    for (let i = 0; i < 5; i++) {
      repo.record({ profileId: "p", dedupKey: `paused/${i}`, company: "Acme", status: "needs_review", submitted: false });
    }
    expect(() => repo.assertCanApply("p", "acme/jobs/9", "Acme", cfg)).not.toThrow();
  });

  it("normalizes URLs to a stable dedup key (ignores query/hash/trailing slash)", () => {
    expect(dedupKeyForUrl("https://boards.greenhouse.io/Acme/Jobs/1/?x=1#y")).toBe(
      dedupKeyForUrl("https://boards.greenhouse.io/acme/jobs/1")
    );
  });
});
