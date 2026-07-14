import { describe, it, expect } from "vitest";
import { locationMatchesDesired, parseLocationList } from "../src/jobs/location-match";

describe("locationMatchesDesired", () => {
  it("matches a NY-state job for a Brooklyn/NY candidate (state abbr, word boundary)", () => {
    expect(locationMatchesDesired(["Brooklyn", "NY"], "New York, NY")).toBe(true);
  });
  it("reconciles state name <-> abbreviation (New York <-> NY)", () => {
    expect(locationMatchesDesired(["NY"], "New York, New York")).toBe(true);
    expect(locationMatchesDesired(["New York"], "Albany, NY")).toBe(true);
  });
  it("does NOT match the 2-letter abbr inside an unrelated word (germaNY / compaNY)", () => {
    expect(locationMatchesDesired(["NY"], "Germany")).toBe(false);
    expect(locationMatchesDesired(["NY"], "Company HQ, Berlin")).toBe(false);
  });
  it("keeps City, ST distinct across states", () => {
    expect(locationMatchesDesired(["San Francisco, CA"], "Austin, TX")).toBe(false);
    expect(locationMatchesDesired(["Brooklyn, NY"], "Brooklyn, NY")).toBe(true);
  });
  it("expands major-metro aliases", () => {
    expect(locationMatchesDesired(["NYC"], "Manhattan, NY")).toBe(true);
    expect(locationMatchesDesired(["Bay Area"], "San Jose, CA")).toBe(true);
  });
  it("empty job location never matches", () => {
    expect(locationMatchesDesired(["NY"], "")).toBe(false);
  });
});

describe("parseLocationList", () => {
  it("keeps 'City, ST' intact (the Brooklyn,NY shredding bug)", () => {
    expect(parseLocationList("Brooklyn, NY")).toEqual(["Brooklyn, NY"]);
  });
  it("splits multiple City, ST pairs", () => {
    expect(parseLocationList("Brooklyn, NY, Jersey City, NJ")).toEqual(["Brooklyn, NY", "Jersey City, NJ"]);
    expect(parseLocationList("Austin, TX, Dallas, TX")).toEqual(["Austin, TX", "Dallas, TX"]);
  });
  it("supports newline / semicolon separators", () => {
    expect(parseLocationList("Brooklyn, NY\nRemote US; Chicago, IL")).toEqual([
      "Brooklyn, NY",
      "Remote US",
      "Chicago, IL",
    ]);
  });
  it("does not over-merge full state names that are also cities", () => {
    expect(parseLocationList("Remote US, New York, NY")).toEqual(["Remote US", "New York, NY"]);
  });
});
