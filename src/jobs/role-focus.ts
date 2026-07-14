// src/jobs/role-focus.ts
//
// Derives the search/ranking focus from explicit profile target roles first, then approved facts.
// These are preferences for discovery, not claims used in generated documents.

import type { ApplicantProfile } from "../types/applicant-profile";
import type { Fact } from "../types/facts-ledger";
import { roleFamilies } from "./taxonomy";

const ROLE_RULES: { role: string; terms: RegExp[] }[] = [
  { role: "AML Analyst", terms: [/\baml\b/i, /\banti[-\s]?money laundering\b/i] },
  { role: "KYC Analyst", terms: [/\bkyc\b/i, /\bknow your customer\b/i] },
  { role: "Sanctions Analyst", terms: [/\bsanctions?\b/i, /\bofac\b/i] },
  { role: "Enhanced Due Diligence Analyst", terms: [/\benhanced due diligence\b/i, /\bedd\b/i] },
  { role: "Transaction Monitoring Analyst", terms: [/\btransaction monitoring\b/i, /\bsar\b/i] },
  { role: "Financial Crime Analyst", terms: [/\bfinancial crime\b/i, /\bfincrime\b/i, /\bfatf\b/i, /\bfincen\b/i] },
  { role: "Fraud Analyst", terms: [/\bfraud\b/i, /\brisk analytics?\b/i] },
  { role: "Compliance Analyst", terms: [/\bcompliance\b/i, /\bregulatory\b/i, /\bfca\b/i] },
  { role: "Product Manager", terms: [/\bproduct manager\b/i, /\bproduct management\b/i, /\bproduct owner\b/i, /\bproduct lead\b/i] },
  { role: "Data Analyst", terms: [/\bdata analyst\b/i, /\bdata analysis\b/i, /\bbusiness intelligence\b/i, /\bbi analyst\b/i, /\banalytics analyst\b/i] },
];

const BAD_TITLE = /\b(unknown|professional development|\d{1,2}\/?$)\b/i;
const ROLE_SUFFIX = /\b(analyst|manager|specialist|associate|lead|director|engineer|scientist|representative|consultant|officer)\b/ig;

export function targetRolesFromProfile(profile: ApplicantProfile): string[] {
  const answer = profile.dynamicAnswers.find((d) => /target.*role|role.*target/i.test(d.key))?.answer;
  if (Array.isArray(answer)) return dedupe(answer.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean));
  if (typeof answer === "string" && answer.trim()) return [answer.trim()];
  return [];
}

export function inferTargetRoles(profile: ApplicantProfile, facts: Fact[]): string[] {
  const explicit = targetRolesFromProfile(profile);
  if (explicit.length) return explicit;

  const text = facts.map(factText).join(" | ");
  const inferred = ROLE_RULES.filter((rule) => rule.terms.some((term) => term.test(text))).map((rule) => rule.role);
  if (inferred.length) return dedupe(inferred).slice(0, 6);

  const titles = facts
    .filter((f) => f.type === "employment")
    .map((f) => f.title.trim())
    .filter((title) => title && !BAD_TITLE.test(title));
  return dedupe(titles).slice(0, 5);
}

export function roleMatchesTitle(role: string, title: string): boolean {
  const normalizedTitle = title.toLowerCase();
  const normalizedRole = role.toLowerCase();
  if (normalizedTitle.includes(normalizedRole) || normalizedRole.includes(normalizedTitle)) return true;
  const core = normalizedRole.replace(ROLE_SUFFIX, " ").replace(/\s+/g, " ").trim();
  return core.length >= 3 && normalizedTitle.includes(core);
}

/** A target-role focus: the literal role strings plus the function FAMILIES they imply (taxonomy). */
export interface RoleFocus {
  roles: string[];
  families: Set<string>;
}

/** Build the role + family focus once, so we don't recompute role families per posting. */
export function buildRoleFocus(roles: string[]): RoleFocus {
  const families = new Set<string>();
  for (const r of roles) for (const f of roleFamilies(r)) families.add(f);
  return { roles, families };
}

/**
 * Does a posting title match the focus? Literal substring match FIRST (precise), then a FAMILY overlap
 * (domain-general): an "AML Analyst"/"KYC"/"Sanctions" focus → compliance family, which also catches
 * "Financial Crimes Investigator", "BSA Officer", "Fraud Operations Analyst", "Risk & Controls" — real
 * adjacent roles a literal substring missed — while still excluding "Software Engineer"/"Account
 * Executive" (different families) and scraper-junk titles (no family at all).
 */
export function titleMatchesFocus(focus: RoleFocus, title: string): boolean {
  if (focus.roles.some((r) => roleMatchesTitle(r, title))) return true;
  if (focus.families.size === 0) return false;
  for (const f of roleFamilies(title)) if (focus.families.has(f)) return true;
  return false;
}

/** Boards with at most this many postings keep ALL of them when nothing matches the role focus. */
export const ROLE_FOCUS_SMALL_BOARD = 8;

/**
 * Pick the postings worth scoring for the given target roles, family-aware (see {@link titleMatchesFocus}).
 *
 * SAFETY — this used to be a hard substring gate on raw titles that, with a narrow role list, silently
 * dropped 90%+ of discovery BEFORE scoring (the triaged "no roles surface" crater). Two guards now keep
 * it from starving the funnel:
 *   - no roles configured  → keep everything (focusing is a no-op);
 *   - a SMALL board with zero matches → keep the whole board (likely a targeted employer whose titles
 *     don't literally say the role, e.g. a bank posting "Investigations Associate").
 * A large board with zero matches genuinely has nothing relevant — that's a TARGET problem (add the
 * right employers), surfaced via funnel logging, not silently papered over by flooding with off-target roles.
 */
export function selectRoleRelevantPostings<T extends { title: string }>(
  postings: T[],
  roles: string[],
  smallBoard = ROLE_FOCUS_SMALL_BOARD
): { kept: T[]; usedFilter: boolean } {
  if (!roles.length || !postings.length) return { kept: postings, usedFilter: false };
  const focus = buildRoleFocus(roles);
  const matched = postings.filter((p) => titleMatchesFocus(focus, p.title));
  if (matched.length === 0 && postings.length <= smallBoard) return { kept: postings, usedFilter: false };
  return { kept: matched, usedFilter: true };
}

function factText(f: Fact): string {
  if (f.type === "employment") return `${f.title} ${f.employer} ${f.bullets.join(" ")}`;
  if ("statement" in f) return f.statement;
  if (f.type === "certification") return `${f.name} ${f.issuer ?? ""}`;
  if (f.type === "education") return `${f.degree} ${f.field ?? ""}`;
  return "";
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}
