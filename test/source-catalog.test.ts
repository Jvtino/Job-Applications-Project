// The source catalog is the single source of truth for URL recognition. These tests assert the
// recognizers stay correct: the posting-URL gate (checkEmployerJobUrl), adapter/source resolution
// (detectAts / sourceForUrl), and the kind/name classification the apply pipeline routes on.

import { describe, it, expect } from "vitest";
import { SOURCE_CATALOG, sourceForUrl } from "../src/jobs/source-catalog";
import { checkEmployerJobUrl } from "../src/jobs/job-url";
import { detectAts } from "../src/jobs/board-detect";
import type { AtsType } from "../src/jobs/types";

// [source id, a real posting URL (gate must accept), a board-root/search URL on the same host (gate
// must reject but still recognize the source)].
const FIXTURES: [AtsType, string, string][] = [
  ["greenhouse", "https://job-boards.greenhouse.io/acme/jobs/1234567", "https://job-boards.greenhouse.io/acme"],
  ["lever", "https://jobs.lever.co/acme/abcd1234-5678-90ab-cdef-111122223333", "https://jobs.lever.co/acme"],
  ["ashby", "https://jobs.ashbyhq.com/acme/abcd1234-5678", "https://jobs.ashbyhq.com/acme"],
  ["workday", "https://acme.wd1.myworkdayjobs.com/en-US/External/job/New-York/Analyst_R123", "https://acme.wd1.myworkdayjobs.com/en-US/External"],
  ["smartrecruiters", "https://jobs.smartrecruiters.com/Acme/123456-analyst", "https://jobs.smartrecruiters.com/Acme"],
  ["jobvite", "https://jobs.jobvite.com/acme/job/o123abc", "https://jobs.jobvite.com/acme"],
  ["icims", "https://careers-acme.icims.com/jobs/123/analyst/job", "https://careers-acme.icims.com/jobs"],
  ["linkedin", "https://www.linkedin.com/jobs/view/123456", "https://www.linkedin.com/jobs/search/?keywords=AML"],
  ["indeed", "https://www.indeed.com/viewjob?jk=abc123", "https://www.indeed.com/jobs?q=analyst"],
  ["glassdoor", "https://www.glassdoor.com/job-listing/aml-analyst-acme-JV_IC.htm", "https://www.glassdoor.com/Job/index.htm"],
  ["ziprecruiter", "https://www.ziprecruiter.com/jobs/acme-aml-analyst", "https://www.ziprecruiter.com/jobs-search"],
  ["monster", "https://www.monster.com/job-openings/aml-analyst-new-york-ny", "https://www.monster.com/jobs/search"],
  ["simplyhired", "https://www.simplyhired.com/job/abc123token", "https://www.simplyhired.com/search?q=analyst"],
  ["talentcom", "https://www.talent.com/view?id=abc123", "https://www.talent.com/jobs?k=analyst"],
  ["careerbuilder", "https://www.careerbuilder.com/job/J3M0XYZ123", "https://www.careerbuilder.com/jobs?keywords=analyst"],
  ["jora", "https://us.jora.com/job/Analyst-abc123", "https://us.jora.com/AML-jobs-in-New-York"],
  ["getwork", "https://getwork.com/details/aml-analyst-abc123", "https://getwork.com/search?q=analyst"],
  ["nexxt", "https://www.nexxt.com/jobs/analyst-12345", "https://www.nexxt.com/jobs"],
  ["jobcase", "https://www.jobcase.com/jobs/analyst-abc123", "https://www.jobcase.com/gethired"],
  ["ladders", "https://www.theladders.com/job/analyst-12345", "https://www.theladders.com/jobs"],
  ["craigslist", "https://newyork.craigslist.org/mnh/ofc/d/analyst/7612345678.html", "https://newyork.craigslist.org/search/jjj"],
  ["dice", "https://www.dice.com/job-detail/abc123", "https://www.dice.com/jobs?q=analyst"],
  ["wellfound", "https://wellfound.com/jobs/123456-aml-analyst", "https://wellfound.com/jobs"],
  ["angellist", "https://angel.co/company/acme/jobs/123-aml-analyst", "https://angel.co/jobs"],
  // ATS platforms
  ["workable", "https://apply.workable.com/acme-corp/j/ABC12345EF", "https://jobs.workable.com/jobs?query=analyst"],
  ["taleo", "https://jpmc.taleo.net/careersection/10/jobdetail.ftl?job=210317780", "https://jpmc.taleo.net/careersection/10/jobsearch.ftl"],
  ["bamboohr", "https://acme.bamboohr.com/careers/12345", "https://acme.bamboohr.com/careers"],
  ["successfactors", "https://acme.successfactors.com/career?career_ns=job_listing&career_job_req_id=12345", "https://acme.successfactors.com/career?career_ns=job_search"],
  ["breezy", "https://acme.breezy.hr/p/aml-analyst-abc123", "https://acme.breezy.hr/"],
  ["recruitee", "https://acme.recruitee.com/o/aml-analyst", "https://acme.recruitee.com"],
  // government
  ["neogov", "https://www.governmentjobs.com/careers/cityofla/jobs/4735238/compliance-analyst", "https://www.governmentjobs.com/careers/cityofla"],
  // niche verticals — finance/compliance/cleared + remote
  ["efinancialcareers", "https://www.efinancialcareers.com/jobs/detail/123456789", "https://www.efinancialcareers.com/search?q=AML+Analyst"],
  ["clearancejobs", "https://clearancejobs.com/jobs/12345678/aml-analyst", "https://clearancejobs.com/jobs?q=AML"],
  ["roberthalf", "https://www.roberthalf.com/us/en/job/new-york-ny/aml-analyst/12345678", "https://www.roberthalf.com/us/en/jobs/finance-accounting"],
  ["weworkremotely", "https://weworkremotely.com/remote-jobs/123456", "https://weworkremotely.com/remote-jobs/search?term=AML"],
  ["remoteok", "https://remoteok.com/remote-jobs/remote-aml-analyst-12345678", "https://remoteok.com/remote-jobs"],
  // full-class coverage — early career
  ["handshake", "https://app.joinhandshake.com/jobs/7654321", "https://app.joinhandshake.com/explore"],
  ["wayup", "https://www.wayup.com/jobs/d/aml-analyst-acme", "https://www.wayup.com/search?q=analyst"],
  ["collegerecruiter", "https://www.collegerecruiter.com/job/aml-analyst-12345", "https://www.collegerecruiter.com/job-search?q=analyst"],
  // hourly / hospitality
  ["snagajob", "https://www.snagajob.com/jobs/12345678", "https://www.snagajob.com/search?q=server"],
  ["hcareers", "https://www.hcareers.com/job/hotel-manager-abc123", "https://www.hcareers.com/search?q=manager"],
  // healthcare
  ["healthecareers", "https://www.healthecareers.com/job/12345678", "https://www.healthecareers.com/jobs?keywords=nurse"],
  ["vivian", "https://www.vivian.com/job/12345678", "https://www.vivian.com/jobs?q=nurse"],
  ["practicelink", "https://www.practicelink.com/jobs/12345678", "https://www.practicelink.com/jobs/search"],
  // education / nonprofit
  ["higheredjobs", "https://www.higheredjobs.com/details.cfm?JobCode=178000000", "https://www.higheredjobs.com/search/"],
  ["idealist", "https://www.idealist.org/en/nonprofit-job/abc123/program-manager", "https://www.idealist.org/en/jobs?q=manager"],
  ["schoolspring", "https://www.schoolspring.com/job/3456789", "https://www.schoolspring.com/jobs"],
  // industry verticals
  ["dribbble", "https://dribbble.com/jobs/123456-Senior-Designer", "https://dribbble.com/jobs?keyword=design"],
  ["mediabistro", "https://www.mediabistro.com/jobs/12345678", "https://www.mediabistro.com/jobs/search"],
  ["rigzone", "https://www.rigzone.com/jobs/12345678", "https://www.rigzone.com/jobs?q=engineer"],
  // remote / staffing
  ["remoteco", "https://remote.co/job/senior-aml-analyst", "https://remote.co/remote-jobs"],
  ["randstad", "https://www.randstadusa.com/jobs/aml-analyst_12345/", "https://www.randstadusa.com/jobs/search/"],
  ["aerotek", "https://www.aerotek.com/en/job/12345678", "https://www.aerotek.com/en/search-jobs"],
  ["kellyservices", "https://www.kellyservices.com/job/12345678", "https://www.kellyservices.com/us/careers/find-jobs"],
  ["adecco", "https://www.adeccousa.com/job-details/aml-analyst-12345", "https://www.adeccousa.com/jobs"],
  // API sources — no adapters; gate + detectAts still work.
  ["adzuna", "https://www.adzuna.com/land/api/redirect/12345/abc", "https://www.adzuna.com/jobs/search"],
  ["jooble", "https://jooble.org/jdp/1234567890", "https://jooble.org/"],
  ["usajobs", "https://www.usajobs.gov/GetJob/ViewDetails/777882300", "https://www.usajobs.gov/Search"],
];

const API_IDS = new Set(SOURCE_CATALOG.filter((s) => s.kind === "api").map((s) => s.id));

describe("source catalog", () => {
  it("holds all 58 recognized sources with unique ids, each covered by a gate fixture", () => {
    expect(SOURCE_CATALOG).toHaveLength(58);
    const ids = SOURCE_CATALOG.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    const fixtured = new Set(FIXTURES.map((f) => f[0]));
    for (const id of ids) expect(fixtured.has(id)).toBe(true);
  });

  it("every entry exposes exactly the recognition fields (host + isPostingUrl + kind/name/category)", () => {
    for (const s of SOURCE_CATALOG) {
      expect(s.host, `${s.id} host`).toBeInstanceOf(RegExp);
      expect(typeof s.isPostingUrl, `${s.id} isPostingUrl`).toBe("function");
      expect(typeof s.name, `${s.id} name`).toBe("string");
      expect(["ats_board", "aggregator", "api"], `${s.id} kind`).toContain(s.kind);
    }
  });

  it("gate accepts real postings and rejects board roots, labeling the source either way", () => {
    for (const [id, posting, root] of FIXTURES) {
      expect(checkEmployerJobUrl(posting), `${id} posting`).toMatchObject({ ok: true, atsType: id });
      expect(checkEmployerJobUrl(root), `${id} root`).toMatchObject({ ok: false, atsType: id });
    }
  });

  it("sourceForUrl resolves each posting URL to its own entry (kind matches the catalog)", () => {
    for (const [id, posting] of FIXTURES) {
      const src = sourceForUrl(new URL(posting));
      expect(src?.id, `${id} sourceForUrl`).toBe(id);
      expect(src?.kind, `${id} kind`).toBe(SOURCE_CATALOG.find((s) => s.id === id)!.kind);
    }
  });

  it("classifies the employer ATS boards as ats_board and the keyed sources as api", () => {
    const kindOf = (id: AtsType) => SOURCE_CATALOG.find((s) => s.id === id)!.kind;
    for (const id of ["greenhouse", "lever", "ashby", "workday", "smartrecruiters", "jobvite", "icims"] as const) {
      expect(kindOf(id), id).toBe("ats_board");
    }
    for (const id of ["adzuna", "jooble", "usajobs"] as const) {
      expect(kindOf(id), id).toBe("api");
    }
  });

  it("resolves an adapter for each non-API source's posting URL (no host cross-matching)", () => {
    for (const [id, posting] of FIXTURES) {
      if (API_IDS.has(id)) {
        // API sources are discovered via REST, not scraped — no AggregatorBoard adapter.
        // The catalog gate (checkEmployerJobUrl / sourceForUrl) still covers them; the
        // registry adapter list intentionally omits them.
        continue;
      }
      expect(detectAts(posting), `${id} detectAts`).toBe(id);
    }
  });

  it("rejects unknown hosts and bad inputs", () => {
    expect(checkEmployerJobUrl("https://example.com/jobs/123")).toMatchObject({ ok: false });
    expect(checkEmployerJobUrl("https://example.com/jobs/123").atsType).toBeUndefined();
    expect(checkEmployerJobUrl("")).toMatchObject({ ok: false });
    expect(checkEmployerJobUrl("not a url")).toMatchObject({ ok: false });
    expect(checkEmployerJobUrl("ftp://acme.icims.com/jobs/1")).toMatchObject({ ok: false });
  });
});
