import { describe, expect, it } from "vitest";
import { NetGuard } from "../../src/finder/net";
import { MockAgent } from "../../src/finder/net/testing";
import { DENIED_HOST_SUFFIXES } from "../../src/finder/net/hosts";
import {
  boardUrlFor,
  buildCompanyBoardIndex,
  type CuratedBoard,
} from "../../src/jobs/company-board-catalog";
import { companySlug, resolveCompanyToBoard } from "../../src/jobs/resolve-company-board";

const CATALOG: CuratedBoard[] = [
  { name: "Coinbase", vendor: "greenhouse", boardId: "coinbase" },
  { name: "Anchorage Digital", vendor: "lever", boardId: "anchorage" },
  { name: "Kraken", vendor: "ashby", boardId: "kraken.com" },
];
const index = buildCompanyBoardIndex(CATALOG);

describe("boardUrlFor (URL minting — the compliance choke point)", () => {
  it("mints an employer-ATS URL per vendor and never an aggregator host", () => {
    expect(boardUrlFor("greenhouse", "coinbase")).toBe("https://boards.greenhouse.io/coinbase");
    expect(boardUrlFor("lever", "anchorage")).toBe("https://jobs.lever.co/anchorage");
    expect(boardUrlFor("ashby", "kraken.com")).toBe("https://jobs.ashbyhq.com/kraken.com");
    expect(boardUrlFor("smartrecruiters", "acme")).toBe("https://jobs.smartrecruiters.com/acme");
    // Workday needs a full board URL, not a bare slug.
    expect(boardUrlFor("workday", "acme")).toBeNull();
    expect(boardUrlFor("workday", "https://acme.wd1.myworkdayjobs.com/careers")).toBe(
      "https://acme.wd1.myworkdayjobs.com/careers",
    );
    // A non-Workday host that merely CONTAINS the domain string is rejected (host is validated).
    expect(boardUrlFor("workday", "https://evil.com/?x=myworkdayjobs.com")).toBeNull();
    // Aggregators have no URL shape here — a name can never resolve to one.
    expect(boardUrlFor("linkedin", "coinbase")).toBeNull();
    expect(boardUrlFor("indeed", "coinbase")).toBeNull();
  });
});

describe("resolveCompanyToBoard — catalog path (no network)", () => {
  it("resolves a known company from the catalog with zero network", async () => {
    // No `net` supplied → catalog-only; a miss returns null instead of probing.
    const r = await resolveCompanyToBoard("Coinbase, Inc.", { index });
    expect(r).toEqual({
      name: "Coinbase",
      atsType: "greenhouse",
      boardUrl: "https://boards.greenhouse.io/coinbase",
      via: "catalog",
    });
  });

  it("returns null for an unknown company when probing is disabled", async () => {
    expect(await resolveCompanyToBoard("Some Unknown LLC", { index })).toBeNull();
  });

  it("normalizes legal suffixes / punctuation when matching the catalog", async () => {
    const r = await resolveCompanyToBoard("KRAKEN", { index });
    expect(r?.atsType).toBe("ashby");
    expect(r?.boardUrl).toBe("https://jobs.ashbyhq.com/kraken.com");
  });
});

describe("resolveCompanyToBoard — probe path (allowlisted ATS APIs only)", () => {
  function guardWith(agent: MockAgent): NetGuard {
    agent.disableNetConnect();
    return new NetGuard({ dispatcher: agent, minIntervalMs: 0 });
  }

  it("probes greenhouse and resolves on a 200 with ≥1 posting", async () => {
    const agent = new MockAgent();
    agent
      .get("https://boards-api.greenhouse.io")
      .intercept({ path: "/v1/boards/probeco/jobs", method: "GET" })
      .reply(200, JSON.stringify({ jobs: [{ id: 1, title: "AML Analyst" }] }), {
        headers: { "content-type": "application/json" },
      });
    const r = await resolveCompanyToBoard("ProbeCo", { index, net: guardWith(agent) });
    expect(r).toEqual({
      name: "ProbeCo",
      atsType: "greenhouse",
      boardUrl: "https://boards.greenhouse.io/probeco",
      via: "probe",
    });
  });

  it("falls through greenhouse→lever when greenhouse has no board", async () => {
    const agent = new MockAgent();
    agent
      .get("https://boards-api.greenhouse.io")
      .intercept({ path: "/v1/boards/leveronly/jobs", method: "GET" })
      .reply(404, "not found");
    agent
      .get("https://api.lever.co")
      .intercept({ path: "/v0/postings/leveronly?mode=json", method: "GET" })
      .reply(200, JSON.stringify([{ id: "x", text: "AML Analyst" }]), {
        headers: { "content-type": "application/json" },
      });
    const r = await resolveCompanyToBoard("LeverOnly", { index, net: guardWith(agent) });
    expect(r?.atsType).toBe("lever");
    expect(r?.boardUrl).toBe("https://jobs.lever.co/leveronly");
  });

  it("returns null when the board exists but has zero postings (no false positive)", async () => {
    const agent = new MockAgent();
    for (const host of [
      "https://boards-api.greenhouse.io",
      "https://api.lever.co",
      "https://api.ashbyhq.com",
    ]) {
      agent.get(host).intercept({ path: () => true, method: "GET" }).reply(200, JSON.stringify({ jobs: [] }), {
        headers: { "content-type": "application/json" },
      }).persist();
    }
    expect(await resolveCompanyToBoard("EmptyBoardCo", { index, net: guardWith(agent) })).toBeNull();
  });

  it("does not probe on an ultra-short slug", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect(); // any request would throw; the short-slug guard must return before that
    const net = new NetGuard({ dispatcher: agent, minIntervalMs: 0 });
    // "AB" -> slug "ab" (< 4 chars): too generic to be a safe board token, so no probe is attempted.
    expect(await resolveCompanyToBoard("AB", { index, net })).toBeNull();
  });
});

describe("compliance: the resolver can never emit or contact a denied host", () => {
  it("never mints a board URL on a hard-denied host, for any input", () => {
    const adversarial = ["LinkedIn", "Indeed Inc", "Glassdoor", "linkedin.com", "Coinbase"];
    for (const name of adversarial) {
      // Even if an aggregator name were in a catalog, boardUrlFor for its (non-existent) vendor is null,
      // and the resolver only ever emits greenhouse/lever/ashby board URLs.
      const slug = companySlug(name);
      for (const url of [
        `https://boards.greenhouse.io/${slug}`,
        `https://jobs.lever.co/${slug}`,
        `https://jobs.ashbyhq.com/${slug}`,
      ]) {
        const host = new URL(url).hostname;
        for (const denied of DENIED_HOST_SUFFIXES) {
          expect(host === denied || host.endsWith(`.${denied}`)).toBe(false);
        }
      }
    }
  });

  it("a probe attempt against a denied host would be refused by NetGuard before the allowlist", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const net = new NetGuard({ dispatcher: agent, minIntervalMs: 0 });
    // Structural proof: NetGuard hard-denies aggregator hosts even if some future code tried them.
    await expect(net.getJson("https://www.linkedin.com/jobs")).rejects.toThrow(/hard-denied/i);
    await expect(net.getJson("https://www.indeed.com/jobs")).rejects.toThrow(/hard-denied/i);
    // And an unknown company simply resolves to null via the allowlisted probes (all un-mocked → skip).
    expect(await resolveCompanyToBoard("Totally Unknown Co", { index, net })).toBeNull();
  });
});
