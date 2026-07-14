// src/finder/pipeline/company-sources.ts
//
// Turns ApplyPilot's target `companies` rows (and the search preferences) into
// finder SourceDescriptors the connectors can fetch. Only ATS types that have a
// finder connector are emitted; the rest (workday/icims/jobvite/…) are skipped
// for fetching but remain valid apply targets elsewhere.

import type { SourceDescriptor, SourceType, Track } from "../shared";
import type { TargetCompany } from "../../jobs/types";
import type { ScoringPreferences } from "../scoring/scoreJob";
import { slugFromBoardUrl } from "../../jobs/board-detect";
import { connectorFor } from "../sources/registry";
import { ROLE_FAMILY_PACKS } from "../../jobs/role-family-pack";

/** ApplyPilot ATS id -> finder SourceType (only those with a finder connector). */
const ATS_TO_FINDER: Record<string, SourceType> = {
  greenhouse: "ats_greenhouse",
  lever: "ats_lever",
  ashby: "ats_ashby",
  smartrecruiters: "ats_smartrecruiters",
  workable: "ats_workable",
  workday: "ats_workday",
};

/**
 * Parse a Workday careers board URL into the {host, tenant, site} the CXS endpoint needs. Workday
 * boards live at `{tenant}.wd{N}.myworkdayjobs.com/{locale?}/{site}`; the tenant is the first host
 * label and the site is the first path segment after an optional locale (e.g. `en-US`). Returns null
 * for anything that isn't a Workday host.
 */
function parseWorkdayBoard(boardUrl: string): { host: string; tenant: string; site: string } | null {
  try {
    const u = new URL(/^https?:\/\//i.test(boardUrl) ? boardUrl : `https://${boardUrl}`);
    const host = u.host.toLowerCase();
    if (!/(?:^|\.)(myworkdayjobs\.com|myworkdaysite\.com)$/i.test(host)) return null;
    const tenant = host.split(".")[0] ?? "";
    const segs = u.pathname.split("/").filter(Boolean);
    let i = 0;
    if (segs[i] && /^[a-z]{2}(-[A-Za-z]{2,})?$/.test(segs[i]!)) i++; // drop a leading locale
    const site = segs[i] ?? "";
    if (!tenant || !site) return null;
    return { host, tenant, site };
  } catch {
    return null;
  }
}

function descriptorFor(
  finderType: SourceType,
  slug: string,
  companyName: string,
  id: string,
  boardUrl: string,
): SourceDescriptor | null {
  switch (finderType) {
    case "ats_greenhouse":
      return {
        id,
        slug: `greenhouse:${slug}`,
        sourceName: companyName,
        sourceType: "ats_greenhouse",
        baseUrl: `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`,
        config: { board_token: slug, company: companyName },
      };
    case "ats_lever":
      return {
        id,
        slug: `lever:${slug}`,
        sourceName: companyName,
        sourceType: "ats_lever",
        baseUrl: `https://api.lever.co/v0/postings/${slug}`,
        config: { site: slug, company: companyName },
      };
    case "ats_ashby":
      return {
        id,
        slug: `ashby:${slug}`,
        sourceName: companyName,
        sourceType: "ats_ashby",
        baseUrl: `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
        config: { slug, company: companyName },
      };
    case "ats_smartrecruiters":
      return {
        id,
        slug: `smartrecruiters:${slug}`,
        sourceName: companyName,
        sourceType: "ats_smartrecruiters",
        baseUrl: `https://api.smartrecruiters.com/v1/companies/${slug}/postings`,
        config: { companyId: slug, company: companyName },
      };
    case "ats_workable":
      return {
        id,
        slug: `workable:${slug}`,
        sourceName: companyName,
        sourceType: "ats_workable",
        baseUrl: `https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`,
        config: { subdomain: slug, company: companyName },
      };
    case "ats_workday": {
      const wd = parseWorkdayBoard(boardUrl);
      if (!wd) return null;
      return {
        id,
        slug: `workday:${wd.tenant}/${wd.site}`,
        sourceName: companyName,
        sourceType: "ats_workday",
        baseUrl: `https://${wd.host}/wday/cxs/${wd.tenant}/${wd.site}/jobs`,
        config: { host: wd.host, tenant: wd.tenant, site: wd.site, company: companyName },
      };
    }
    default:
      return null;
  }
}

/** Enabled target companies -> finder SourceDescriptors (skips ATS types without a connector). */
export function companySources(companies: TargetCompany[]): SourceDescriptor[] {
  const out: SourceDescriptor[] = [];
  for (const c of companies) {
    const finderType = ATS_TO_FINDER[c.atsType];
    if (!finderType || !connectorFor(finderType)) continue;
    const slug = slugFromBoardUrl(c.atsType, c.boardUrl);
    if (!slug) continue;
    const d = descriptorFor(finderType, slug, c.name, c.id, c.boardUrl);
    if (d) out.push(d);
  }
  return out;
}

/**
 * Which role-family packs to draw extra USAJOBS keywords from, per scoring track.
 * The pack's exact titles + first must-have skill group broaden a federal search
 * beyond the user's private-sector titles (federal postings use different titles
 * but the same skill vocabulary in their text).
 */
const TRACK_TO_PACKS: Partial<Record<Track, string[]>> = {
  finance_compliance: ["compliance"],
  tech: ["engineering"],
  healthcare_admin: ["healthcare"],
  government: ["compliance", "operations"],
  sales: ["sales"],
  customer_support: ["customer_success"],
  office_admin: ["administrative"],
  blue_collar_hourly: ["logistics"],
  general_professional: ["operations"],
};

const MAX_KEYWORDS = 8; // bound the number of USAJOBS API calls per pass

/**
 * Build the USAJOBS keyword queries: a diverse mix of the user's own target titles
 * AND role-family-pack terms. Pack terms lead with the common FEDERAL title and
 * entry/associate variants + the family's must-have skills. We reserve ~half the
 * slots for each so the user's (often mid-level) titles don't crowd out the
 * broader entry/associate/federal terms, or vice versa.
 */
function usajobsKeywords(prefs: ScoringPreferences): string[] {
  const packTerms = (TRACK_TO_PACKS[prefs.track] ?? []).flatMap((id) => {
    const p = ROLE_FAMILY_PACKS[id];
    return p ? [...p.adjacentTitles, ...p.exactTitles, ...(p.mustHaveSkillGroups[0] ?? [])] : [];
  });

  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string): void => {
    const kw = raw.trim();
    const key = kw.toLowerCase();
    if (kw.length < 2 || seen.has(key) || out.length >= MAX_KEYWORDS) return;
    seen.add(key);
    out.push(kw);
  };

  const reserve = Math.ceil(MAX_KEYWORDS / 2);
  prefs.targetTitles.slice(0, reserve).forEach(add); // ~half for the user's own titles
  packTerms.forEach(add); // fill the rest with pack terms (federal/associate/skills)
  prefs.targetTitles.slice(reserve).forEach(add); // backfill any slots left
  return out.length ? out : ["analyst"];
}

function keywordSlug(keyword: string): string {
  return keyword.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "q";
}

/**
 * Keyword market-search sources.
 *
 * Owner amendment (2026-07): the FREE, public USAJOBS federal search is re-enabled
 * — its key is a no-cost public identifier from developer.usajobs.gov, not a paid
 * private secret — to widen discovery beyond the user's curated employer boards
 * (federal compliance/AML/investigator roles especially). It is OPT-IN: emitted
 * only when the USAJOBS key + registered email are configured. Paid aggregators
 * (Adzuna/Jooble) remain OFF. Each keyword becomes one USAJOBS query; results are
 * scored and deduped through the same pipeline as employer boards.
 */
export function keywordSources(
  prefs: ScoringPreferences,
  getSecret?: (key: string) => string | null,
): SourceDescriptor[] {
  const apiKey = getSecret?.("keys.usajobs.api_key");
  const email = getSecret?.("keys.usajobs.user_agent_email");
  if (!apiKey || !email) return []; // opt-in: no key configured → no market search

  return usajobsKeywords(prefs).map((keyword): SourceDescriptor => {
    const slug = `usajobs:${keywordSlug(keyword)}`;
    return {
      id: slug,
      slug,
      sourceName: `USAJOBS — ${keyword}`,
      sourceType: "api_usajobs",
      baseUrl: "https://data.usajobs.gov/api/search",
      config: { keyword, results_per_page: 150 },
    };
  });
}
