import { describe, it, expect } from "vitest";
import { classifyUsEligibility, isUsEligible, isBlockedNonUs } from "../src/jobs/us-eligibility";

const status = (loc?: string | null, desc?: string | null) => classifyUsEligibility(loc, desc).status;

describe("classifyUsEligibility — positive US eligibility gate (A1)", () => {
  // ---- the brief's acceptance cases ----
  it("plain 'Remote' is NOT automation-ready (needs review)", () => {
    expect(status("Remote")).toBe("needs_review");
  });
  it("'Remote - United States' is automation-eligible", () => {
    expect(status("Remote - United States")).toBe("eligible_us");
  });
  it("'Remote - Canada' is blocked", () => {
    expect(status("Remote - Canada")).toBe("blocked_non_us");
  });
  it("'New York, NY' is eligible", () => {
    expect(status("New York, NY")).toBe("eligible_us");
  });
  it("'London, UK' is blocked", () => {
    expect(status("London, UK")).toBe("blocked_non_us");
  });
  it("blank location is NOT automation-ready", () => {
    expect(status("")).toBe("needs_review");
    expect(status(null)).toBe("needs_review");
    expect(status(undefined)).toBe("needs_review");
  });
  it("'Worldwide' is NOT automation-ready (ambiguous, not blocked)", () => {
    expect(status("Worldwide")).toBe("needs_review");
  });

  // ---- more US-eligible forms ----
  it.each([
    "United States",
    "USA",
    "U.S.",
    "US only",
    "Remote (US)",
    "US Remote",
    "United States Remote",
    "Remote within the United States",
    "Austin, TX",
    "San Francisco, CA",
    "Chicago",
    "Seattle, Washington",
    "Boston, MA (Hybrid)",
    "Remote, USA",
  ])("eligible: %s", (loc) => {
    expect(status(loc)).toBe("eligible_us");
  });

  // ---- explicit non-US → blocked ----
  it.each([
    "London",
    "Toronto, Canada",
    "Bengaluru, India",
    "Berlin, Germany",
    "Remote - EMEA",
    "Remote (LATAM)",
    "Dublin, Ireland",
    "Sydney, Australia",
    "Remote - Europe",
    "Singapore",
    "Tel Aviv, Israel",
    "Remote — Worldwide (excluding US)".replace("US", "United Kingdom"),
  ])("blocked: %s", (loc) => {
    expect(status(loc)).toBe("blocked_non_us");
  });

  // ---- ambiguous → needs review (never auto-eligible) ----
  it.each([
    "Remote",
    "Global",
    "Anywhere",
    "Remote (Global)",
    "Nationwide",
    "International",
    "Work from home",
    "Hybrid",
    "Flexible",
  ])("needs review: %s", (loc) => {
    expect(status(loc)).toBe("needs_review");
  });

  // ---- mixed US / non-US never defaults to eligible ----
  it("'US or Canada' is held for review, not eligible", () => {
    expect(status("Remote - US or Canada")).toBe("needs_review");
  });
  it("'United States / United Kingdom' is held for review", () => {
    expect(status("United States / United Kingdom")).toBe("needs_review");
  });

  // ---- description is a red-flag source, never a promoter ----
  it("blank-ish location + non-US description blocks", () => {
    expect(status("Remote", "This role is based in our London office and requires UK work authorization.")).toBe(
      "blocked_non_us"
    );
  });
  it("plain remote + friendly 'work with us' copy is not promoted to eligible", () => {
    // "us" the pronoun must not be read as United States.
    expect(status("Remote", "Come build the future with us! Join our team.")).toBe("needs_review");
  });
  it("explicit non-US location is not rescued by a US mention in the body", () => {
    expect(status("Berlin, Germany", "We also have a New York office.")).toBe("blocked_non_us");
  });

  // ---- word-boundary safety ----
  it("does not treat 'us' inside words as United States", () => {
    expect(status("Nexus, Bonus Program")).toBe("needs_review");
  });
  it("does not treat lowercase state-like words in prose as state codes", () => {
    // 'in', 'or', 'me', 'hi', 'ok', 'oh' must not be read as IN/OR/ME/HI/OK/OH.
    expect(status("Remote or hybrid, check in with me")).toBe("needs_review");
  });

  it("convenience helpers agree with classify", () => {
    expect(isUsEligible("Austin, TX")).toBe(true);
    expect(isUsEligible("Remote")).toBe(false);
    expect(isBlockedNonUs("London, UK")).toBe(true);
    expect(isBlockedNonUs("Remote")).toBe(false);
  });
});
