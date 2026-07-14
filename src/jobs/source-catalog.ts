// src/jobs/source-catalog.ts
//
// THE SINGLE SOURCE OF TRUTH for URL recognition: which job-source hosts the app knows about, and
// how to tell an individual posting (apply) URL apart from a board root / search page. This is a
// pure classification catalog — it holds NO search, scrape, or policy behavior. Each entry carries
// only what the recognizers need:
//
//   - host          -> the RegExp matched against `url.host` to identify the source (hosts are disjoint).
//   - isPostingUrl  -> the authoritative posting-URL gate (checkEmployerJobUrl); the host is already matched.
//   - kind / name   -> classification labels used by the apply pipeline (e.g. ats_board vs aggregator).
//
// Consumers DERIVE everything from this array via sourceForUrl():
//   - job-url.ts         -> sourceForUrl() + entry.isPostingUrl()  (the posting-URL gate)
//   - board-detect.ts    -> sourceForUrl()                          (ATS/source detection)
//   - apply-capability.ts-> sourceForUrl(...).name                 (labeling)
//   - pass-funnel.ts     -> sourceForUrl(...).kind === "ats_board" (routing)
//
// Recognition never changes submission routing — apply adapters select by URL/DOM markers, and any
// unrecognized apply form falls to the generic fallback, which always queues for the user's manual click.

import type { AtsType } from "./types";

/** The doc's 13 source classes. Only a subset is populated today; later milestones slot in here. */
export type SourceCategory =
  | "universal" // 1. Universal / high-volume boards and aggregators
  | "ats" // 2. Direct employer career sites and ATS platforms
  | "government" // 3. Federal, state, local, public-sector
  | "early_career" // 4. Internship, college, campus recruiting
  | "tech_startup" // 5. Tech, startup, product, software
  | "remote_freelance" // 6. Remote, flexible, freelance, contract
  | "hourly" // 7. Hourly, frontline, retail, hospitality, warehouse
  | "staffing" // 8. Staffing agencies and recruiting firms
  | "healthcare" // 9. Healthcare and medical
  | "finance_legal_cleared" // 10. Finance, accounting, compliance, legal, security-clearance
  | "education_nonprofit" // 11. Education, universities, schools, nonprofit
  | "industry" // 12. Industry-specific
  | "company"; // 13. Company career pages as their own class

export interface JobSource {
  /** Canonical id; also stored as `ats_type` on companies/discovered_jobs rows. */
  id: AtsType;
  /** Display label, e.g. "SimplyHired". */
  name: string;
  category: SourceCategory;
  /**
   * Classification label for the apply pipeline (no behavior attached here):
   *  - "ats_board"  -> an employer ATS board.
   *  - "aggregator" -> a third-party / multi-employer job board.
   *  - "api"        -> a source that exposes a REST API rather than HTML postings.
   */
  kind: "ats_board" | "aggregator" | "api";
  /** Matches `url.host` for URLs belonging to this source. Hosts are disjoint across the catalog. */
  host: RegExp;
  /**
   * True when `url` is an individual posting (apply) URL, not a board root / search page. This is the
   * authoritative gate (checkEmployerJobUrl). The `url`'s host has already been matched to this entry.
   */
  isPostingUrl: (url: URL) => boolean;
}

function segments(url: URL): string[] {
  return url.pathname.split("/").filter(Boolean);
}

export const SOURCE_CATALOG: JobSource[] = [
  // ---------------------------------------------------------------------------------------------
  // 2. Employer ATS boards.
  // ---------------------------------------------------------------------------------------------
  {
    id: "greenhouse",
    name: "Greenhouse",
    category: "ats",
    kind: "ats_board",
    host: /greenhouse\.io/i,
    isPostingUrl: (u) => /\/jobs\/\d+\b/i.test(u.pathname) || /\b(gh_jid|token)=\d+\b/i.test(u.search),
  },
  {
    id: "lever",
    name: "Lever",
    category: "ats",
    kind: "ats_board",
    host: /lever\.co/i,
    isPostingUrl: (u) => {
      const p = segments(u);
      return p.length >= 2 && (p[1]?.length ?? 0) >= 8;
    },
  },
  {
    id: "ashby",
    name: "Ashby",
    category: "ats",
    kind: "ats_board",
    host: /ashbyhq\.com/i,
    isPostingUrl: (u) => {
      const p = segments(u);
      return p.length >= 2 && (p[1]?.length ?? 0) >= 8;
    },
  },
  {
    id: "workday",
    name: "Workday",
    category: "ats",
    kind: "ats_board",
    host: /(myworkdayjobs\.com|myworkdaysite\.com)/i,
    isPostingUrl: (u) => /\/job\//i.test(u.pathname),
  },
  {
    id: "smartrecruiters",
    name: "SmartRecruiters",
    category: "ats",
    kind: "ats_board",
    host: /jobs\.smartrecruiters\.com/i,
    isPostingUrl: (u) => segments(u).length >= 2,
  },
  {
    id: "jobvite",
    name: "Jobvite",
    category: "ats",
    kind: "ats_board",
    host: /jobs\.jobvite\.com/i,
    isPostingUrl: (u) => /\/(?:job|jobs)\//i.test(u.pathname),
  },
  {
    id: "icims",
    name: "iCIMS",
    category: "ats",
    kind: "ats_board",
    host: /icims\.com/i,
    isPostingUrl: (u) => /\/jobs\/\d+/i.test(u.pathname),
  },

  // ---------------------------------------------------------------------------------------------
  // 1. Universal / high-volume aggregators.
  // ---------------------------------------------------------------------------------------------
  {
    id: "linkedin",
    name: "LinkedIn Jobs",
    category: "universal",
    kind: "aggregator",
    host: /linkedin\.com/i,
    isPostingUrl: (u) => /\/jobs\/view\/\d+/i.test(u.pathname),
  },
  {
    id: "indeed",
    name: "Indeed",
    category: "universal",
    kind: "aggregator",
    host: /indeed\.com/i,
    isPostingUrl: (u) =>
      /^\/(?:viewjob|rc\/clk|pagead\/clk)$/i.test(u.pathname) &&
      (u.searchParams.has("jk") || u.searchParams.has("vjk")),
  },
  {
    id: "glassdoor",
    name: "Glassdoor",
    category: "universal",
    kind: "aggregator",
    host: /glassdoor\./i,
    isPostingUrl: (u) => /\/(?:job-listing|partner\/jobListing)/i.test(u.pathname),
  },
  {
    id: "ziprecruiter",
    name: "ZipRecruiter",
    category: "universal",
    kind: "aggregator",
    host: /ziprecruiter\.com/i,
    isPostingUrl: (u) => /\/(?:jobs|c\/.+\/Job)\//i.test(u.pathname),
  },
  {
    id: "monster",
    name: "Monster",
    category: "universal",
    kind: "aggregator",
    host: /monster\.com/i,
    isPostingUrl: (u) => /\/job-openings\//i.test(u.pathname),
  },
  {
    id: "simplyhired",
    name: "SimplyHired",
    category: "universal",
    kind: "aggregator",
    host: /simplyhired\.com/i,
    isPostingUrl: (u) => /\/job\//i.test(u.pathname),
  },
  {
    id: "talentcom",
    name: "Talent.com",
    category: "universal",
    kind: "aggregator",
    host: /talent\.com/i,
    isPostingUrl: (u) => /^\/view$/i.test(u.pathname) && u.searchParams.has("id"),
  },
  {
    id: "careerbuilder",
    name: "CareerBuilder",
    category: "universal",
    kind: "aggregator",
    host: /careerbuilder\.com/i,
    isPostingUrl: (u) => /\/job\//i.test(u.pathname),
  },
  {
    id: "jora",
    name: "Jora",
    category: "universal",
    kind: "aggregator",
    host: /jora\.com/i,
    isPostingUrl: (u) => /\/job\//i.test(u.pathname),
  },
  {
    id: "getwork",
    name: "Getwork",
    category: "universal",
    kind: "aggregator",
    host: /getwork\.com/i,
    isPostingUrl: (u) => /\/(?:details|j|jobs?)\//i.test(u.pathname),
  },
  {
    id: "nexxt",
    name: "Nexxt",
    category: "universal",
    kind: "aggregator",
    host: /nexxt\.com/i,
    isPostingUrl: (u) => /\/jobs?\//i.test(u.pathname),
  },
  {
    id: "jobcase",
    name: "Jobcase",
    category: "universal",
    kind: "aggregator",
    host: /jobcase\.com/i,
    isPostingUrl: (u) => /\/(?:j|jobs?)\//i.test(u.pathname),
  },
  {
    id: "ladders",
    name: "Ladders",
    category: "universal",
    kind: "aggregator",
    host: /theladders\.com/i,
    isPostingUrl: (u) => /\/job\//i.test(u.pathname),
  },
  {
    id: "craigslist",
    name: "Craigslist",
    category: "universal",
    kind: "aggregator",
    host: /craigslist\.org/i,
    isPostingUrl: (u) => /\/\d+\.html$/i.test(u.pathname),
  },

  // ---------------------------------------------------------------------------------------------
  // 5. Tech / startup boards.
  // ---------------------------------------------------------------------------------------------
  {
    id: "dice",
    name: "Dice",
    category: "tech_startup",
    kind: "aggregator",
    host: /dice\.com/i,
    isPostingUrl: (u) => /\/job-detail\//i.test(u.pathname),
  },
  {
    id: "wellfound",
    name: "Wellfound",
    category: "tech_startup",
    kind: "aggregator",
    host: /wellfound\.com/i,
    isPostingUrl: (u) => /\/jobs\/[^/]+/i.test(u.pathname),
  },
  {
    id: "angellist",
    name: "AngelList",
    category: "tech_startup",
    kind: "aggregator",
    host: /angel\.co/i,
    isPostingUrl: (u) => /\/(?:company\/[^/]+\/jobs\/[^/]+|jobs\/[^/]+)/i.test(u.pathname),
  },
  {
    // jobs.workable.com is a unified cross-company search; posting URLs are on apply.workable.com.
    id: "workable",
    name: "Workable",
    category: "tech_startup",
    kind: "aggregator",
    host: /workable\.com/i,
    isPostingUrl: (u) => /\/j\/[A-Za-z0-9]{6,}/i.test(u.pathname),
  },

  // ---------------------------------------------------------------------------------------------
  // Employer ATS platforms (per-company boards; recognized by host + posting pattern).
  // ---------------------------------------------------------------------------------------------
  {
    // Oracle Taleo — widely used by JP Morgan, Barclays, HSBC, BNY Mellon, Deutsche Bank, etc.
    id: "taleo",
    name: "Taleo",
    category: "ats",
    kind: "aggregator",
    host: /taleo\.net/i,
    isPostingUrl: (u) => /jobdetail\.ftl/i.test(u.pathname),
  },
  {
    // BambooHR — popular at mid-size companies and growing fintechs.
    id: "bamboohr",
    name: "BambooHR",
    category: "ats",
    kind: "aggregator",
    host: /bamboohr\.com/i,
    isPostingUrl: (u) => /\/careers\/\d+/i.test(u.pathname),
  },
  {
    // SAP SuccessFactors — large enterprises (Morgan Stanley, Deutsche Bank, Citigroup, etc.).
    // Posting URLs carry career_job_req_id as a query param; search pages do not.
    id: "successfactors",
    name: "SAP SuccessFactors",
    category: "ats",
    kind: "aggregator",
    host: /(successfactors|sapsf)\.com/i,
    isPostingUrl: (u) => u.searchParams.has("career_job_req_id"),
  },
  {
    // Breezy HR — growing platform popular at tech companies and professional services firms.
    id: "breezy",
    name: "Breezy",
    category: "ats",
    kind: "aggregator",
    host: /breezy\.hr/i,
    isPostingUrl: (u) => /\/p\/[a-zA-Z0-9-]+$/i.test(u.pathname),
  },
  {
    // Recruitee — per-company boards at {company}.recruitee.com (postings live under /o/).
    id: "recruitee",
    name: "Recruitee",
    category: "ats",
    kind: "aggregator",
    host: /(?:^|\/\/|\.)recruitee\.com(?:[:/]|$)/i,
    isPostingUrl: (u) => /\/o\//i.test(u.pathname),
  },

  // ---------------------------------------------------------------------------------------------
  // 3. Government — federal, state, and local public-sector boards.
  //    USAJOBS (federal) is an API source in the block below.
  // ---------------------------------------------------------------------------------------------
  {
    // NEOGOV / GovernmentJobs.com — the dominant platform for US state and local government jobs.
    id: "neogov",
    name: "NEOGOV",
    category: "government",
    kind: "aggregator",
    host: /governmentjobs\.com/i,
    isPostingUrl: (u) => /\/careers\/[^/]+\/jobs\/\d+/i.test(u.pathname),
  },

  // ---------------------------------------------------------------------------------------------
  // 10. Finance, compliance, and security-cleared verticals.
  // ---------------------------------------------------------------------------------------------
  {
    // Largest finance/banking job board globally; strong coverage of AML, compliance, risk, quant.
    id: "efinancialcareers",
    name: "eFinancialCareers",
    category: "finance_legal_cleared",
    kind: "aggregator",
    host: /efinancialcareers\.com/i,
    isPostingUrl: (u) => /\/jobs(?:\/detail)?\/\d{6,}/i.test(u.pathname),
  },
  {
    // Security-clearance-focused board; strong overlap with AML/BSA roles at cleared contractors.
    id: "clearancejobs",
    name: "ClearanceJobs",
    category: "finance_legal_cleared",
    kind: "aggregator",
    host: /clearancejobs\.com/i,
    isPostingUrl: (u) => /\/jobs\/\d+/i.test(u.pathname),
  },
  {
    // Finance/accounting/legal staffing firm with a strong US job board; postings use singular /job/.
    id: "roberthalf",
    name: "Robert Half",
    category: "staffing",
    kind: "aggregator",
    host: /roberthalf\.com/i,
    isPostingUrl: (u) => /\/job\//i.test(u.pathname),
  },

  // ---------------------------------------------------------------------------------------------
  // 6. Remote / flexible work boards.
  // ---------------------------------------------------------------------------------------------
  {
    id: "weworkremotely",
    name: "We Work Remotely",
    category: "remote_freelance",
    kind: "aggregator",
    host: /weworkremotely\.com/i,
    isPostingUrl: (u) => /\/remote-jobs\/\d+/i.test(u.pathname),
  },
  {
    id: "remoteok",
    name: "Remote OK",
    category: "remote_freelance",
    kind: "aggregator",
    host: /remoteok\.com/i,
    isPostingUrl: (u) => /\/remote-jobs\/[^/?#]+\d{4,}/i.test(u.pathname),
  },

  // ---------------------------------------------------------------------------------------------
  // Full-class coverage — every remaining class from the 13-class source map gets representation.
  // ---------------------------------------------------------------------------------------------

  // 4. Early career / internships / campus recruiting.
  {
    id: "handshake",
    name: "Handshake",
    category: "early_career",
    kind: "aggregator",
    host: /joinhandshake\.com/i,
    isPostingUrl: (u) => /\/(?:stu\/)?jobs\/\d+/i.test(u.pathname),
  },
  {
    id: "wayup",
    name: "WayUp",
    category: "early_career",
    kind: "aggregator",
    host: /wayup\.com/i,
    isPostingUrl: (u) => /\/jobs\/d\//i.test(u.pathname),
  },
  {
    id: "collegerecruiter",
    name: "College Recruiter",
    category: "early_career",
    kind: "aggregator",
    host: /collegerecruiter\.com/i,
    isPostingUrl: (u) => /\/job\//i.test(u.pathname),
  },

  // 7. Hourly / frontline / retail / hospitality.
  {
    id: "snagajob",
    name: "Snagajob",
    category: "hourly",
    kind: "aggregator",
    host: /snagajob\.com/i,
    isPostingUrl: (u) => /\/jobs\/\d+/i.test(u.pathname),
  },
  {
    // Hospitality careers (hotels, restaurants, resorts).
    id: "hcareers",
    name: "Hcareers",
    category: "hourly",
    kind: "aggregator",
    host: /hcareers\.com/i,
    isPostingUrl: (u) => /\/job\//i.test(u.pathname),
  },

  // 9. Healthcare / medical.
  {
    id: "healthecareers",
    name: "Health eCareers",
    category: "healthcare",
    kind: "aggregator",
    host: /healthecareers\.com/i,
    isPostingUrl: (u) => /\/job\/\d+/i.test(u.pathname),
  },
  {
    // Nursing / allied-health / travel jobs.
    id: "vivian",
    name: "Vivian Health",
    category: "healthcare",
    kind: "aggregator",
    host: /vivian\.com/i,
    isPostingUrl: (u) => /\/job\/\d+/i.test(u.pathname),
  },
  {
    // Physician / advanced-practice recruiting.
    id: "practicelink",
    name: "PracticeLink",
    category: "healthcare",
    kind: "aggregator",
    host: /practicelink\.com/i,
    isPostingUrl: (u) => /\/jobs?\/\d+/i.test(u.pathname),
  },

  // 11. Education / universities / schools / nonprofit.
  {
    id: "higheredjobs",
    name: "HigherEdJobs",
    category: "education_nonprofit",
    kind: "aggregator",
    host: /higheredjobs\.com/i,
    isPostingUrl: (u) => /details\.cfm/i.test(u.pathname),
  },
  {
    id: "idealist",
    name: "Idealist",
    category: "education_nonprofit",
    kind: "aggregator",
    host: /idealist\.org/i,
    isPostingUrl: (u) => /\/(?:en\/)?(?:nonprofit-job|job)\//i.test(u.pathname),
  },
  {
    // K-12 education hiring.
    id: "schoolspring",
    name: "SchoolSpring",
    category: "education_nonprofit",
    kind: "aggregator",
    host: /schoolspring\.com/i,
    isPostingUrl: (u) => /\/jobs?\/\d+/i.test(u.pathname),
  },

  // 12. Industry-specific verticals (design / media / energy as representative examples).
  {
    id: "dribbble",
    name: "Dribbble",
    category: "industry",
    kind: "aggregator",
    host: /dribbble\.com/i,
    isPostingUrl: (u) => /\/jobs\/\d+/i.test(u.pathname),
  },
  {
    id: "mediabistro",
    name: "Mediabistro",
    category: "industry",
    kind: "aggregator",
    host: /mediabistro\.com/i,
    isPostingUrl: (u) => /\/jobs?\/\d+/i.test(u.pathname),
  },
  {
    // Oil, gas, and energy sector.
    id: "rigzone",
    name: "Rigzone",
    category: "industry",
    kind: "aggregator",
    host: /rigzone\.com/i,
    isPostingUrl: (u) => /\/jobs\/\d+/i.test(u.pathname),
  },

  // 6. Remote / flexible (joins weworkremotely + remoteok above).
  {
    id: "remoteco",
    name: "Remote.co",
    category: "remote_freelance",
    kind: "aggregator",
    // Bounded so it matches the host without colliding with remote.com.
    host: /(?:^|\/\/|\.)remote\.co(?:[:/]|$)/i,
    isPostingUrl: (u) => /\/job\//i.test(u.pathname),
  },

  // 8. Staffing / recruiting firms (joins roberthalf above).
  {
    id: "randstad",
    name: "Randstad",
    category: "staffing",
    kind: "aggregator",
    host: /randstadusa\.com/i,
    isPostingUrl: (u) => /\/jobs\/[^/]+\d{4,}/i.test(u.pathname),
  },
  {
    id: "aerotek",
    name: "Aerotek",
    category: "staffing",
    kind: "aggregator",
    host: /aerotek\.com/i,
    isPostingUrl: (u) => /\/job\/\d+/i.test(u.pathname),
  },
  {
    id: "kellyservices",
    name: "Kelly Services",
    category: "staffing",
    kind: "aggregator",
    host: /kellyservices\.com/i,
    isPostingUrl: (u) => /\/job\/\d+/i.test(u.pathname),
  },
  {
    id: "adecco",
    name: "Adecco",
    category: "staffing",
    kind: "aggregator",
    host: /adeccousa\.com/i,
    isPostingUrl: (u) => /\/job-details\//i.test(u.pathname),
  },

  // ---------------------------------------------------------------------------------------------
  // API-backed sources (recognized by host + posting pattern like any other source).
  // ---------------------------------------------------------------------------------------------
  {
    id: "adzuna",
    name: "Adzuna",
    category: "universal",
    kind: "api",
    host: /adzuna\.com/i,
    isPostingUrl: (u) => /\/land\/api\/redirect\//i.test(u.pathname),
  },
  {
    id: "jooble",
    name: "Jooble",
    category: "universal",
    kind: "api",
    host: /jooble\.org/i,
    isPostingUrl: (u) => /\/jdp\/\d+/i.test(u.pathname),
  },
  {
    // US federal jobs.
    id: "usajobs",
    name: "USAJOBS",
    category: "government",
    kind: "api",
    host: /usajobs\.gov/i,
    isPostingUrl: (u) => /\/GetJob\/ViewDetails\/\d+/i.test(u.pathname),
  },
];

/** The catalog entry whose host matches this URL's host, if any. Hosts are disjoint, so first wins. */
export function sourceForUrl(url: URL): JobSource | undefined {
  return SOURCE_CATALOG.find((s) => s.host.test(url.host));
}

/** The catalog entry for a board/posting URL string, or undefined for unknown/invalid hosts. */
export function sourceForBoardUrl(raw: string): JobSource | undefined {
  try {
    return sourceForUrl(new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`));
  } catch {
    return undefined;
  }
}
