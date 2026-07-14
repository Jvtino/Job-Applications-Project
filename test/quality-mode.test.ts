import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { readSettings, writeSettings } from "../src/server/config-store";

let dir: string;
let envPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "applypilot-quality-"));
  envPath = join(dir, ".env");
  // Isolate from any value a sibling test may have written to the process env.
  delete process.env.APPLYPILOT_QUALITY_MODE;
});

afterEach(() => {
  delete process.env.APPLYPILOT_QUALITY_MODE;
  rmSync(dir, { recursive: true, force: true });
});

describe("quality mode setting", () => {
  it("defaults to off when unset", () => {
    expect(readSettings(envPath).qualityMode).toBe(false);
  });

  it("persists qualityMode=true to the .env and reads it back", () => {
    const saved = writeSettings(envPath, { qualityMode: true });
    expect(saved.qualityMode).toBe(true);
    expect(readFileSync(envPath, "utf8")).toMatch(/APPLYPILOT_QUALITY_MODE=on/);
    delete process.env.APPLYPILOT_QUALITY_MODE; // prove it's read from the file, not the env
    expect(readSettings(envPath).qualityMode).toBe(true);
  });

  it("turns quality mode back off", () => {
    writeSettings(envPath, { qualityMode: true });
    const off = writeSettings(envPath, { qualityMode: false });
    expect(off.qualityMode).toBe(false);
    expect(readFileSync(envPath, "utf8")).toMatch(/APPLYPILOT_QUALITY_MODE=off/);
  });

  it("leaves an existing value untouched when qualityMode is omitted", () => {
    writeSettings(envPath, { qualityMode: true });
    const after = writeSettings(envPath, { model: "claude-sonnet-4-6" }); // unrelated change
    expect(after.qualityMode).toBe(true);
  });

  it.each([
    ["on", true],
    ["true", true],
    ["1", true],
    ["yes", true],
    ["off", false],
    ["false", false],
    ["", false],
  ])("parses APPLYPILOT_QUALITY_MODE=%s as %s", (raw, expected) => {
    writeFileSync(envPath, `APPLYPILOT_QUALITY_MODE=${raw}\n`);
    delete process.env.APPLYPILOT_QUALITY_MODE;
    expect(readSettings(envPath).qualityMode).toBe(expected);
  });
});
