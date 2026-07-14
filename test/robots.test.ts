// robots.txt support (commercial M4): parser/matcher units, the per-host verdict cache with an
// injected fetch, and a real-browser integration test proving BrowserSession skips disallowed
// paths when (and only when) robots enforcement is on.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import {
  parseRobotsGroups,
  selectRules,
  isPathAllowed,
  RobotsCache,
  RobotsDisallowedError,
  type RobotsFetcher,
} from "../src/ats/robots";
import { BrowserSession } from "../src/ats/browser";

const rulesFor = (text: string, token?: string) => selectRules(parseRobotsGroups(text), token);

describe("robots.txt parser + matcher", () => {
  it("applies the * group: disallowed prefix blocks, everything else allowed", () => {
    const rules = rulesFor("User-agent: *\nDisallow: /private/\n");
    expect(isPathAllowed(rules, "/private/page")).toBe(false);
    expect(isPathAllowed(rules, "/jobs/123")).toBe(true);
  });

  it("prefers the ApplyPilot-specific group over *", () => {
    const text = "User-agent: *\nDisallow: /\n\nUser-agent: ApplyPilot\nDisallow: /forbidden/\n";
    const rules = rulesFor(text);
    expect(isPathAllowed(rules, "/anything")).toBe(true); // * group's Disallow:/ does not apply
    expect(isPathAllowed(rules, "/forbidden/x")).toBe(false);
  });

  it("longest match wins and Allow wins exact ties (RFC 9309 §2.2.2)", () => {
    const text = "User-agent: *\nDisallow: /\nAllow: /jobs/\n";
    const rules = rulesFor(text);
    expect(isPathAllowed(rules, "/jobs/123")).toBe(true); // /jobs/ (6) beats / (1)
    expect(isPathAllowed(rules, "/admin")).toBe(false);

    const tie = rulesFor("User-agent: *\nDisallow: /jobs\nAllow: /jobs\n");
    expect(isPathAllowed(tie, "/jobs/1")).toBe(true); // equal length -> Allow
  });

  it("supports * wildcards and $ end anchors, matching path + query", () => {
    const rules = rulesFor("User-agent: *\nDisallow: /*?page=\nDisallow: /*.pdf$\n");
    expect(isPathAllowed(rules, "/search?page=2")).toBe(false);
    expect(isPathAllowed(rules, "/search")).toBe(true);
    expect(isPathAllowed(rules, "/docs/file.pdf")).toBe(false);
    expect(isPathAllowed(rules, "/docs/file.pdfx")).toBe(true); // $ anchors the end
  });

  it("handles comments, blank lines, shared groups, and stray rules", () => {
    const text =
      "# top comment\nUser-agent: googlebot\nUser-agent: *\nDisallow: /a # inline comment\n\n" +
      "Disallow:\n" + // empty value = no restriction
      "User-agent: other\nDisallow: /b\n";
    const rules = rulesFor(text);
    expect(isPathAllowed(rules, "/a/x")).toBe(false); // * shares the googlebot group's rules
    expect(isPathAllowed(rules, "/b/x")).toBe(true); // the "other" group does not apply to us
    const orphan = rulesFor("Disallow: /never\nUser-agent: *\nAllow: /\n");
    expect(isPathAllowed(orphan, "/never")).toBe(true); // rules before any User-agent are ignored
  });

  it("no rules / no robots groups means everything is allowed", () => {
    expect(isPathAllowed([], "/anything")).toBe(true);
    expect(isPathAllowed(rulesFor(""), "/x")).toBe(true);
  });

  it("normalizes percent-encoding on both sides (RFC 9309 §2.2.2)", () => {
    // A rule written in raw UTF-8 still matches the URL's canonical %-encoded path.
    const raw = rulesFor("User-agent: *\nDisallow: /café/\n");
    const encodedPath = new URL("https://x.com/café/menu").pathname; // -> /caf%C3%A9/menu
    expect(isPathAllowed(raw, encodedPath)).toBe(false);
    // Lowercase-hex rule also matches (escapes are uppercased before compare).
    const lower = rulesFor("User-agent: *\nDisallow: /caf%c3%a9/\n");
    expect(isPathAllowed(lower, encodedPath)).toBe(false);
    expect(isPathAllowed(lower, "/other")).toBe(true);
  });

  it("matches a hostile many-wildcard pattern in linear time (no catastrophic backtracking)", () => {
    // The pre-fix regex hung >2 min on this shape; the two-pointer matcher must return promptly.
    const rules = rulesFor("User-agent: *\nDisallow: /" + "a/*".repeat(20) + "/end$\n");
    const path = "/" + "a/".repeat(60) + "b";
    const t0 = Date.now();
    const allowed = isPathAllowed(rules, path); // fails to match -> path allowed
    expect(allowed).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

function fetcherCounting(
  handler: (url: string) => { status: number; body?: string } | Error
): { fetcher: RobotsFetcher; calls: string[] } {
  const calls: string[] = [];
  const fetcher: RobotsFetcher = async (url) => {
    calls.push(url);
    const r = handler(url);
    if (r instanceof Error) throw r; // network/transport error
    return { status: r.status, text: r.body ?? "" };
  };
  return { fetcher, calls };
}

describe("RobotsCache", () => {
  it("fetches robots.txt once per origin (concurrent calls dedup) and enforces its rules", async () => {
    const { fetcher, calls } = fetcherCounting(() => ({ status: 200, body: "User-agent: *\nDisallow: /blocked/\n" }));
    const cache = new RobotsCache({ fetcher });

    const [a, b, c] = await Promise.all([
      cache.isAllowed("https://example.com/blocked/1"),
      cache.isAllowed("https://example.com/ok"),
      cache.isAllowed("https://example.com/blocked/2?x=1"),
    ]);
    expect([a, b, c]).toEqual([false, true, false]);
    expect(calls).toEqual(["https://example.com/robots.txt"]);

    await cache.isAllowed("https://example.com/another");
    expect(calls).toHaveLength(1); // cached
  });

  it("404 -> allow-all; 5xx -> disallow-all; but a NETWORK error fails OPEN (short TTL)", async () => {
    const notFound = new RobotsCache({ fetcher: fetcherCounting(() => ({ status: 404 })).fetcher });
    expect(await notFound.isAllowed("https://a.com/x")).toBe(true);

    // Server up but erroring -> back off.
    const serverErr = new RobotsCache({ fetcher: fetcherCounting(() => ({ status: 503 })).fetcher });
    expect(await serverErr.isAllowed("https://b.com/x")).toBe(false);

    // Transport failure via the SAME stack the scraper uses -> the origin is unreachable for
    // scraping too, so fail open rather than blanket-blocking discovery on our own connectivity blip.
    const netErr = new RobotsCache({ fetcher: fetcherCounting(() => new Error("ECONNREFUSED")).fetcher });
    expect(await netErr.isAllowed("https://c.com/x")).toBe(true);
  });

  it("robots.txt itself and non-http(s)/invalid URLs are always allowed (no fetch)", async () => {
    const { fetcher, calls } = fetcherCounting(() => ({ status: 200, body: "User-agent: *\nDisallow: /\n" }));
    const cache = new RobotsCache({ fetcher });
    expect(await cache.isAllowed("https://example.com/robots.txt")).toBe(true);
    expect(await cache.isAllowed("not a url")).toBe(true);
    expect(await cache.isAllowed("ftp://example.com/x")).toBe(true);
    expect(calls).toEqual([]);
  });
});

// Integration: a real headless Chromium session against a local fixture server. Enforcement on ->
// a disallowed path throws RobotsDisallowedError WITHOUT navigating; enforcement off (the apply
// flow) -> the same URL opens normally.
describe("BrowserSession robots enforcement (real browser, served fixture)", () => {
  let server: http.Server;
  let base: string;
  let session: BrowserSession;
  let dir: string;
  const pageHits: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/robots.txt") {
        res.setHeader("content-type", "text/plain");
        res.end("User-agent: *\nDisallow: /blocked/\n");
        return;
      }
      pageHits.push(req.url ?? "");
      res.setHeader("content-type", "text/html");
      res.end("<!doctype html><html><body>ok</body></html>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = mkdtempSync(join(tmpdir(), "applypilot-robots-"));
    session = new BrowserSession({
      headed: false,
      userDataDir: join(dir, "p"),
      minActionDelayMs: 1,
      maxActionDelayMs: 2,
      respectRobots: true,
    });
    await session.start();
  }, 90000);

  afterAll(async () => {
    await session?.close();
    await new Promise<void>((r) => server?.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a disallowed path without opening the page, allows others", async () => {
    await expect(session.open(`${base}/blocked/listing`)).rejects.toBeInstanceOf(RobotsDisallowedError);
    expect(pageHits.filter((u) => u.startsWith("/blocked"))).toEqual([]); // never navigated

    const ctx = await session.open(`${base}/jobs/1`);
    await ctx.page.close();
    expect(pageHits).toContain("/jobs/1");
  }, 90000);

  it("setRespectRobots(false) restores user-initiated navigation to the same URL", async () => {
    const prev = session.setRespectRobots(false);
    expect(prev).toBe(true);
    const ctx = await session.open(`${base}/blocked/listing`);
    await ctx.page.close();
    expect(pageHits).toContain("/blocked/listing");
    session.setRespectRobots(true);
  }, 90000);
});
