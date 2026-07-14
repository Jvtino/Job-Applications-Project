// Packaged-app data locations + legacy migration (electron/data-paths.cjs, commercial M1).
//
// The shell roots all mutable state under the OS user-data dir and copies (never moves) data from
// a legacy git-clone install on first packaged launch. These are the invariants that keep a signed
// read-only .app bootable and make the migration safe to re-run.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const { packagedDataEnv, migrateLegacyData, markerPath } = require_("../electron/data-paths.cjs");

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("packagedDataEnv", () => {
  it("roots db, .env, and browser profile under the user-data dir and creates data/", () => {
    const root = tmp("applypilot-userdata-");
    const env = packagedDataEnv(root);
    expect(env.APPLYPILOT_DB_PATH).toBe(join(root, "data", "applypilot.sqlite"));
    expect(env.APPLYPILOT_ENV_PATH).toBe(join(root, ".env"));
    expect(env.APPLYPILOT_BROWSER_PROFILE_DIR).toBe(join(root, "browser-profile"));
    expect(existsSync(join(root, "data"))).toBe(true);
  });
});

describe("migrateLegacyData", () => {
  function legacyInstall(): string {
    const legacy = tmp("applypilot-legacy-");
    mkdirSync(join(legacy, "data", "resumes"), { recursive: true });
    writeFileSync(join(legacy, "data", "applypilot.sqlite"), "sqlite-bytes");
    writeFileSync(join(legacy, "data", "resumes", "cv.pdf"), "resume-bytes");
    writeFileSync(join(legacy, ".env"), "ANTHROPIC_API_KEY=sk-legacy\n");
    mkdirSync(join(legacy, "browser-profile"));
    writeFileSync(join(legacy, "browser-profile", "Cookies"), "cookie-bytes");
    mkdirSync(join(legacy, "browser-profile-discovery"));
    writeFileSync(join(legacy, "browser-profile-discovery", "Cookies"), "discovery-cookie-bytes");
    return legacy;
  }

  it("copies db, subdirs, .env (0600), and browser profile — originals untouched", () => {
    const legacy = legacyInstall();
    const root = tmp("applypilot-userdata-");
    const env = packagedDataEnv(root);

    expect(migrateLegacyData(env, legacy)).toBe(true);

    expect(readFileSync(env.APPLYPILOT_DB_PATH, "utf8")).toBe("sqlite-bytes");
    expect(readFileSync(join(root, "data", "resumes", "cv.pdf"), "utf8")).toBe("resume-bytes");
    expect(readFileSync(env.APPLYPILOT_ENV_PATH, "utf8")).toContain("sk-legacy");
    expect(statSync(env.APPLYPILOT_ENV_PATH).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(env.APPLYPILOT_BROWSER_PROFILE_DIR, "Cookies"), "utf8")).toBe("cookie-bytes");
    expect(readFileSync(`${env.APPLYPILOT_BROWSER_PROFILE_DIR}-discovery/Cookies`, "utf8")).toBe("discovery-cookie-bytes");
    // Non-destructive: the legacy install still has everything.
    expect(readFileSync(join(legacy, "data", "applypilot.sqlite"), "utf8")).toBe("sqlite-bytes");
    expect(existsSync(join(legacy, ".env"))).toBe(true);
    // Completion marker written last; a second run is a pure no-op.
    expect(existsSync(markerPath(env))).toBe(true);
    expect(migrateLegacyData(env, legacy)).toBe(false);
  });

  it("resumes an interrupted migration: partial destination heals, existing files never overwritten", () => {
    const legacy = legacyInstall();
    const root = tmp("applypilot-userdata-");
    const env = packagedDataEnv(root);
    // Simulate a crash after the DB landed but before .env/profiles: no marker yet.
    writeFileSync(env.APPLYPILOT_DB_PATH, "current-user-data");

    expect(migrateLegacyData(env, legacy)).toBe(true);
    expect(readFileSync(env.APPLYPILOT_DB_PATH, "utf8")).toBe("current-user-data"); // kept, not clobbered
    expect(readFileSync(env.APPLYPILOT_ENV_PATH, "utf8")).toContain("sk-legacy"); // gap filled
    expect(readFileSync(join(env.APPLYPILOT_BROWSER_PROFILE_DIR, "Cookies"), "utf8")).toBe("cookie-bytes");
    expect(existsSync(markerPath(env))).toBe(true);
  });

  it("seals an established install (own DB, no legacy) so a later dev checkout is never merged in", () => {
    const root = tmp("applypilot-userdata-");
    const env = packagedDataEnv(root);
    writeFileSync(env.APPLYPILOT_DB_PATH, "current-user-data");

    expect(migrateLegacyData(env, join(root, "nope"))).toBe(false);
    expect(existsSync(markerPath(env))).toBe(true);
    // A legacy install appearing later is ignored: the marker wins.
    const legacy = legacyInstall();
    expect(migrateLegacyData(env, legacy)).toBe(false);
    expect(existsSync(env.APPLYPILOT_ENV_PATH)).toBe(false);
  });

  it("is a no-op when there is no legacy install and no data yet (no premature seal)", () => {
    const root = tmp("applypilot-userdata-");
    const env = packagedDataEnv(root);
    expect(migrateLegacyData(env, join(root, "nope"))).toBe(false);
    expect(existsSync(env.APPLYPILOT_DB_PATH)).toBe(false);
    expect(existsSync(markerPath(env))).toBe(false); // migration still possible once legacy data exists
  });
});
