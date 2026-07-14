import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import type { ApplicantProfile } from "../src/types/applicant-profile";
import { openDatabase, type DB } from "../src/db/database";
import { BrowserSession } from "../src/ats/browser";
import { GreenhouseAdapter } from "../src/ats/greenhouse";
import { makePageContext } from "../src/ats/page-context";
import { runApplication } from "../src/orchestrator/apply";
import { ApplicationsRepo, DuplicateApplicationError, dedupKeyForUrl } from "../src/db/applications-repo";
import { createBlankProfile } from "../src/profile/factory";

const here = dirname(fileURLToPath(import.meta.url));

let server: http.Server;
let baseUrl: string;
let session: BrowserSession;
let dir: string;
let resumePath: string;

beforeAll(async () => {
  const html = readFileSync(join(here, "fixtures", "greenhouse-fixture.html"), "utf8");
  server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}/acme/jobs/123/apply`;

  dir = mkdtempSync(join(tmpdir(), "applypilot-gh-"));
  resumePath = join(dir, "resume.pdf");
  writeFileSync(resumePath, "%PDF-1.4\n% test resume\n");

  session = new BrowserSession({
    headed: false,
    userDataDir: join(dir, "profile"),
    minActionDelayMs: 1,
    maxActionDelayMs: 2,
  });
  await session.start();
}, 90000);

afterAll(async () => {
  await session?.close();
  await new Promise<void>((r) => server?.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

function profileFixture(): ApplicantProfile {
  const p = createBlankProfile("applicant");
  p.contact.legalFirstName = "Jane";
  p.contact.legalLastName = "Applicant";
  p.contact.email = "jane.applicant@example.com";
  p.contact.phone = "(415) 555-0137";
  p.contact.links.linkedin = "https://linkedin.com/in/janeapplicant";
  p.workAuthorization.authorizedToWorkInUS = { value: true, source: "user", updatedAt: "" };
  p.workAuthorization.requiresSponsorshipNowOrFuture = { value: false, source: "user", updatedAt: "" };
  p.screening.isAtLeast18 = { value: true, source: "user", updatedAt: "" };
  p.screening.previouslyEmployedHere = { value: false, source: "user", updatedAt: "" };
  // App-seeded (NOT user-confirmed) self-id -> must PAUSE for the human, never placed on the form (A5).
  p.selfId.gender = { value: "female", source: "default", updatedAt: "" };
  return p;
}

describe("Greenhouse adapter + review gate (semi_auto), end-to-end in a real browser", () => {
  it(
    "detects, fills, pauses unconfirmed self-id, pauses unmapped, attaches resume, and NEVER submits",
    async () => {
      const db: DB = openDatabase(join(dir, "apps.sqlite"));
      const profile = profileFixture();

      const outcome = await runApplication(session, db, {
        url: baseUrl,
        mode: "semi_auto",
        profile,
        resumePath,
        company: "Acme Corp",
        title: "Operations Analyst",
      });
      const g = outcome.gate;

      // Detection by DOM signature (host is localhost, not greenhouse.io).
      expect(g.ats).toBe("greenhouse");

      // Identity filled from the profile.
      const find = (arr: typeof g.filled, re: RegExp) => arr.find((m) => re.test(m.field.label));
      expect(find(g.filled, /first name/i)?.resolvedValue).toBe("Jane");
      expect(find(g.filled, /email/i)?.resolvedValue).toBe("jane.applicant@example.com");

      // Work authorization (native select) + sponsorship (radio group) mapped to Yes/No.
      expect(find(g.filled, /authorized to work/i)?.resolvedValue).toBe("Yes");
      expect(find(g.filled, /sponsorship/i)?.resolvedValue).toBe("No");
      expect(find(g.filled, /18 years/i)?.resolvedValue).toBe("Yes");

      // A5: unconfirmed self-id (custom dropdown) is NOT placed on the form at all — it pauses for
      // the human. Never filled, never flagged-with-a-value; surfaced in needsConfirmation instead.
      const gender = find(g.needsConfirmation, /gender/i);
      expect(gender).toBeTruthy();
      expect(gender?.risk).toBe("self_id");
      expect(gender?.source).toBe("default");
      expect(find(g.filled, /gender/i)).toBeUndefined();
      expect(find(g.flaggedForReview, /gender/i)).toBeUndefined();

      // Required free-text with no profile value -> pauses for the human.
      expect(g.needsConfirmation.some((m) => /why do you want/i.test(m.field.label))).toBe(true);

      // Resume attached; not double-nagged in needs-confirmation.
      expect(g.attachedDocuments.find((d) => d.kind === "resume")?.attached).toBe(true);
      expect(g.needsConfirmation.some((m) => m.field.controlType === "file_upload")).toBe(false);

      // Submit located but NOT clicked; gate is not auto-submittable.
      expect(g.submitControlRef).toBeTruthy();
      expect(outcome.submitted).toBe(false);
      expect(g.readyForOneClickSubmit).toBe(false);

      // Prove nothing was submitted: the form's submit guard never fired.
      const page = session.pages().find((p) => p.url().includes("/acme/jobs/123/apply"));
      expect(page).toBeTruthy();
      const submitted = await page!.evaluate(() => (window as unknown as { __submitted: boolean }).__submitted);
      expect(submitted).toBe(false);

      // Regression: some Greenhouse/typeahead widgets can leave a second input on the page with
      // the same data-ap-ref as a real text field. The adapter must choose the label/type match
      // instead of letting Playwright fail strict-mode on the duplicate ref.
      const adapter = new GreenhouseAdapter();
      const ctx = makePageContext(page!);
      const fields = await adapter.getFields(ctx);
      const firstName = fields.find((f) => /first name/i.test(f.label));
      expect(firstName).toBeTruthy();
      await page!.evaluate((ref) => {
        const dupe = document.createElement("input");
        dupe.type = "search";
        dupe.setAttribute("role", "combobox");
        dupe.setAttribute("aria-label", "Search");
        dupe.setAttribute("placeholder", "Search");
        dupe.setAttribute("data-ap-ref", ref);
        document.body.appendChild(dupe);
      }, firstName!.ref);
      await expect(adapter.setField(ctx, firstName!, "Janet")).resolves.toBeUndefined();
      expect(await adapter.readField(ctx, firstName!)).toBe("Janet");
      expect(await page!.evaluate((ref) => document.querySelectorAll(`[data-ap-ref="${ref}"]`).length, firstName!.ref)).toBe(1);

      // Hard dedup blocks re-SUBMISSION (not paused retries). Mark this job submitted, then a
      // re-run is refused before the browser even opens.
      new ApplicationsRepo(db).record({
        profileId: profile.id,
        dedupKey: dedupKeyForUrl(baseUrl),
        company: "Acme Corp",
        status: "submitted",
        submitted: true,
      });
      await expect(
        runApplication(session, db, { url: baseUrl, mode: "semi_auto", profile, company: "Acme Corp" })
      ).rejects.toBeInstanceOf(DuplicateApplicationError);

      db.close();
    },
    90000
  );
});
