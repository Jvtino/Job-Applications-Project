import { describe, expect, it } from "vitest";
import { NetGuard } from "../../src/finder/net";
import { MockAgent } from "../../src/finder/net/testing";
import { workdayConnector, connectorFor } from "../../src/finder/sources";
import type { SourceDescriptor } from "../../src/finder/shared";
import { classifyApplyCapability } from "../../src/jobs/apply-capability";

const source: SourceDescriptor = {
  id: "workday:acme",
  slug: "workday:acme/External",
  sourceName: "Acme Bank",
  sourceType: "ats_workday",
  baseUrl: "https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/External/jobs",
  config: { host: "acme.wd1.myworkdayjobs.com", tenant: "acme", site: "External", company: "Acme Bank" },
};

const body = JSON.stringify({
  total: 2,
  jobPostings: [
    {
      title: "AML Investigator",
      externalPath: "/job/New-York-NY/AML-Investigator_R-1001",
      locationsText: "New York, NY",
      postedOn: "Posted 3 Days Ago",
      bulletFields: ["R-1001"],
    },
    {
      title: "Remote KYC Analyst",
      externalPath: "/job/Remote-USA/KYC-Analyst_R-1002",
      locationsText: "Remote, USA",
      postedOn: "Posted Today",
      bulletFields: ["R-1002"],
    },
  ],
});

function ctxFor() {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  mockAgent
    .get("https://acme.wd1.myworkdayjobs.com")
    .intercept({ path: "/wday/cxs/acme/External/jobs", method: "POST" })
    .reply(200, body, { headers: { "content-type": "application/json" } });
  const net = new NetGuard({ dispatcher: mockAgent, minIntervalMs: 0 });
  return { net };
}

describe("workdayConnector", () => {
  it("is registered in the connector registry", () => {
    expect(connectorFor("ats_workday")).toBe(workdayConnector);
  });

  it("maps the CXS search POST to RawJobs", async () => {
    const jobs = await workdayConnector.fetchJobs(source, ctxFor());

    expect(jobs).toHaveLength(2);
    expect(jobs[0]!.title).toBe("AML Investigator");
    expect(jobs[0]!.externalJobId).toBe("R-1001");
    expect(jobs[0]!.applyUrl).toBe(
      "https://acme.wd1.myworkdayjobs.com/External/job/New-York-NY/AML-Investigator_R-1001",
    );
    expect(jobs[0]!.locationRaw).toBe("New York, NY");
    // Workday's postedOn is a relative string, not a date — we store no date rather than fabricate one.
    expect(jobs[0]!.postedAt).toBeNull();
    expect(jobs[1]!.remoteType).toBe("remote");

    // Recognized as a Workday posting; Workday is (experimentally) form-fill-supported.
    expect(classifyApplyCapability(jobs[0]!.applyUrl).atsType).toBe("workday");
  });
});
