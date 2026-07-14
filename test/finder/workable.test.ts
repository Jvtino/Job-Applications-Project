import { describe, expect, it } from "vitest";
import { NetGuard } from "../../src/finder/net";
import { MockAgent } from "../../src/finder/net/testing";
import { workableConnector, connectorFor } from "../../src/finder/sources";
import type { SourceDescriptor } from "../../src/finder/shared";
import { classifyApplyCapability } from "../../src/jobs/apply-capability";

function ctx(host: string, reply: (pool: ReturnType<MockAgent["get"]>) => void) {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  reply(mockAgent.get(host));
  const net = new NetGuard({ dispatcher: mockAgent, minIntervalMs: 0 });
  return { net };
}

const source: SourceDescriptor = {
  id: "workable:acme",
  slug: "workable:acme",
  sourceName: "Acme",
  sourceType: "ats_workable",
  baseUrl: "https://apply.workable.com/api/v1/widget/accounts/acme?details=true",
  config: { subdomain: "acme", company: "Acme" },
};

const body = JSON.stringify({
  name: "Acme",
  description: "Careers at Acme",
  jobs: [
    {
      title: "AML Investigator",
      shortcode: "ABC123DEF",
      employment_type: "Full-time",
      telecommuting: false,
      department: "Compliance",
      url: "https://apply.workable.com/acme/j/ABC123DEF/",
      application_url: "https://apply.workable.com/acme/j/ABC123DEF/apply/",
      shortlink: "https://apply.workable.com/j/ABC123DEF",
      location: {
        country: "United States",
        country_code: "US",
        region: "New York",
        region_code: "NY",
        city: "New York",
        telecommuting: false,
      },
      created_at: "2026-07-01T00:00:00Z",
    },
    {
      title: "Remote KYC Analyst",
      shortcode: "XYZ789GHI",
      employment_type: "Contract",
      telecommuting: true,
      url: "https://apply.workable.com/acme/j/XYZ789GHI/",
      location: { country: "United States", country_code: "US", telecommuting: true },
    },
  ],
});

describe("workableConnector", () => {
  it("is registered in the connector registry", () => {
    expect(connectorFor("ats_workable")).toBe(workableConnector);
  });

  it("maps the public widget feed to RawJobs", async () => {
    const c = ctx("https://apply.workable.com", (pool) =>
      pool
        .intercept({ path: "/api/v1/widget/accounts/acme?details=true", method: "GET" })
        .reply(200, body, { headers: { "content-type": "application/json" } }),
    );
    const jobs = await workableConnector.fetchJobs(source, c);

    expect(jobs).toHaveLength(2);
    expect(jobs[0]!.title).toBe("AML Investigator");
    expect(jobs[0]!.externalJobId).toBe("ABC123DEF");
    expect(jobs[0]!.applyUrl).toBe("https://apply.workable.com/acme/j/ABC123DEF/");
    expect(jobs[0]!.locationRaw).toBe("New York, New York, United States");
    expect(jobs[0]!.employmentType).toBe("full_time");
    expect(jobs[0]!.remoteType).toBe("unknown");

    expect(jobs[1]!.employmentType).toBe("contract");
    expect(jobs[1]!.remoteType).toBe("remote");
  });

  it("classifies Workable postings as manual-apply (not auto form-fill)", () => {
    // Discovery finds Workable roles, but the fill adapters are Greenhouse/Lever/Ashby only —
    // a Workable posting is surfaced as manual-open, never routed into the fill pipeline.
    const cap = classifyApplyCapability("https://apply.workable.com/acme/j/ABC123DEF/").capability;
    expect(cap).not.toBe("supported_form_fill");
  });
});
