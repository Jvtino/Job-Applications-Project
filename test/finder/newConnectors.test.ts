import { describe, expect, it } from "vitest";
import { NetGuard } from "../../src/finder/net";
import { MockAgent } from "../../src/finder/net/testing";
import { ashbyConnector, smartRecruitersConnector, connectorFor } from "../../src/finder/sources";
import type { SourceDescriptor } from "../../src/finder/shared";
import { classifyApplyCapability } from "../../src/jobs/apply-capability";

function ctx(host: string, reply: (pool: ReturnType<MockAgent["get"]>) => void) {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  reply(mockAgent.get(host));
  const net = new NetGuard({ dispatcher: mockAgent, minIntervalMs: 0 });
  return { net };
}

describe("registry wiring", () => {
  it("registers the new ATS connectors", () => {
    expect(connectorFor("ats_ashby")).toBe(ashbyConnector);
    expect(connectorFor("ats_smartrecruiters")).toBe(smartRecruitersConnector);
  });
});

describe("ashbyConnector", () => {
  const source: SourceDescriptor = {
    id: "ashby:acme",
    slug: "ashby:acme",
    sourceName: "Acme",
    sourceType: "ats_ashby",
    baseUrl: "https://api.ashbyhq.com/posting-api/job-board/acme",
    config: { slug: "acme", company: "Acme" },
  };
  const body = JSON.stringify({
    jobs: [
      {
        id: "abcd1234-5678-90ef",
        title: "Compliance Analyst",
        location: "New York, NY",
        isRemote: false,
        applyUrl: "https://jobs.ashbyhq.com/acme/abcd1234-5678-90ef",
        descriptionHtml: "<p>KYC and AML work.</p>",
        publishedAt: "2026-07-01T00:00:00Z",
      },
    ],
  });

  it("maps postings and emits an apply-capable URL", async () => {
    const c = ctx("https://api.ashbyhq.com", (pool) =>
      pool
        .intercept({ path: "/posting-api/job-board/acme?includeCompensation=true", method: "GET" })
        .reply(200, body, { headers: { "content-type": "application/json" } }),
    );
    const jobs = await ashbyConnector.fetchJobs(source, c);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.title).toBe("Compliance Analyst");
    expect(jobs[0]!.applyUrl).toBe("https://jobs.ashbyhq.com/acme/abcd1234-5678-90ef");
    expect(classifyApplyCapability(jobs[0]!.applyUrl).capability).toBe("supported_form_fill");
  });
});

describe("smartRecruitersConnector", () => {
  const source: SourceDescriptor = {
    id: "smartrecruiters:acmeco",
    slug: "smartrecruiters:acmeco",
    sourceName: "Acme",
    sourceType: "ats_smartrecruiters",
    baseUrl: "https://api.smartrecruiters.com/v1/companies/acmeco/postings",
    config: { companyId: "acmeco", company: "Acme" },
  };
  const body = JSON.stringify({
    content: [
      {
        id: "743999888",
        name: "Operations Analyst",
        location: { city: "Austin", region: "TX", country: "US", remote: false },
        company: { name: "Acme" },
        releasedDate: "2026-07-02T00:00:00Z",
      },
    ],
  });

  it("maps postings and emits an apply-capable URL", async () => {
    const c = ctx("https://api.smartrecruiters.com", (pool) =>
      pool
        .intercept({ path: "/v1/companies/acmeco/postings?limit=100", method: "GET" })
        .reply(200, body, { headers: { "content-type": "application/json" } }),
    );
    const jobs = await smartRecruitersConnector.fetchJobs(source, c);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.title).toBe("Operations Analyst");
    expect(jobs[0]!.applyUrl).toBe("https://jobs.smartrecruiters.com/acmeco/743999888");
    expect(jobs[0]!.locationRaw).toBe("Austin, TX, US");
    expect(classifyApplyCapability(jobs[0]!.applyUrl).capability).toBe("supported_form_fill");
  });
});
