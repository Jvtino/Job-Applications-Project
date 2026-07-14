import type { ProfileRepo } from "../db/profile-repo";
import type { ApplicantProfile } from "../types/applicant-profile";

export const DEMO_PROFILE_ID = "demo";

export interface ActiveProfileOptions {
  demoMode?: boolean;
}

function timestamp(raw: string): number {
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function newest(profiles: ApplicantProfile[]): ApplicantProfile | undefined {
  return profiles
    .slice()
    .sort(
      (a, b) =>
        timestamp(b.updatedAt) - timestamp(a.updatedAt) ||
        timestamp(b.createdAt) - timestamp(a.createdAt) ||
        b.id.localeCompare(a.id)
    )[0];
}

export function resolveActiveProfile(
  repo: ProfileRepo,
  opts: ActiveProfileOptions = {}
): ApplicantProfile | undefined {
  const profiles = repo.list();
  const liveProfiles = profiles.filter((profile) => profile.id !== DEMO_PROFILE_ID);
  const live = newest(liveProfiles);
  if (live) return live;
  return opts.demoMode ? newest(profiles) : undefined;
}

export function hasOnlyHiddenDemoProfile(repo: ProfileRepo, opts: ActiveProfileOptions = {}): boolean {
  if (opts.demoMode) return false;
  const profiles = repo.list();
  return profiles.length > 0 && profiles.every((profile) => profile.id === DEMO_PROFILE_ID);
}
