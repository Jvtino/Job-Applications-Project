import { describe, expect, it } from 'vitest';
import { labelForScore } from '../../src/finder/shared';
import { DEFAULT_WEIGHTS } from '../../src/finder/scoring/index';
import type {
  ComponentName,
  ComponentResult,
  JobScoreV1,
} from '../../src/finder/scoring/scoreJob';
import { jobFitFromScore } from '../../src/finder/pipeline/run-discovery';
import {
  isActionableDiscoveredJob,
  isDisplayableDiscoveredJob,
} from '../../src/jobs/actionable-jobs';
import type { DiscoveredJob } from '../../src/db/discovered-jobs-repo';

const NAMES = Object.keys(DEFAULT_WEIGHTS) as ComponentName[];

/** A minimal but complete scorecard result at a chosen overall score. */
function mkResult(overall: number): JobScoreV1 {
  const neutral: ComponentResult = { score: 0.5, informative: true };
  const components = Object.fromEntries(NAMES.map((n) => [n, { ...neutral }])) as Record<
    ComponentName,
    ComponentResult
  >;
  return {
    overall,
    label: labelForScore(overall),
    components,
    explanation: { why: ['reason'], concerns: [] },
    listing: {
      requirementsMet: [],
      requirementsMissing: [],
      preferredMet: [],
      preferredMissing: [],
      transferable: [],
      dealbreakers: [],
    },
  };
}

function mkJob(score: number, fit?: DiscoveredJob['fit']): DiscoveredJob {
  return {
    id: 'j',
    profileId: 'p',
    company: 'Acme',
    title: 'Engineer',
    jobUrl: 'https://job-boards.greenhouse.io/acme/jobs/1',
    atsType: 'greenhouse',
    score,
    rationale: '',
    knockouts: [],
    status: 'scored',
    dedupKey: 'k',
    discoveredAt: '2026-01-01T00:00:00Z',
    ...(fit ? { fit } : {}),
  };
}

describe('fit surfacing preserves apply/display behavior (Phase C lock-in)', () => {
  // Spanning the boundaries: apply floor (0.75), display floor (0.35), and edges.
  const SCORES = [92, 85, 80, 76, 75, 74, 60, 45, 36, 35, 34, 20, 8];
  const opts = { requireEmployerJobUrl: false } as const;

  it('populating fit never changes isActionableDiscoveredJob vs score-only', () => {
    for (const overall of SCORES) {
      const score = overall / 100;
      const fit = jobFitFromScore(mkResult(overall));
      expect(isActionableDiscoveredJob(mkJob(score, fit), opts), `actionable@${overall}`).toBe(
        isActionableDiscoveredJob(mkJob(score), opts),
      );
    }
  });

  it('populating fit never changes isDisplayableDiscoveredJob vs score-only', () => {
    for (const overall of SCORES) {
      const score = overall / 100;
      const fit = jobFitFromScore(mkResult(overall));
      expect(isDisplayableDiscoveredJob(mkJob(score, fit), opts), `displayable@${overall}`).toBe(
        isDisplayableDiscoveredJob(mkJob(score), opts),
      );
    }
  });

  it('apply-recommendation still hinges on the 0.75 score floor', () => {
    expect(isActionableDiscoveredJob(mkJob(0.8, jobFitFromScore(mkResult(80))), opts)).toBe(true);
    expect(isActionableDiscoveredJob(mkJob(0.74, jobFitFromScore(mkResult(74))), opts)).toBe(false);
  });

  it('carries the structured requirement listing through to the fit payload', () => {
    const result = mkResult(80);
    result.listing.requirementsMet = ['SQL'];
    result.listing.requirementsMissing = ['Go'];
    const fit = jobFitFromScore(result);
    expect(fit.requirementListing?.requirementsMet).toContain('SQL');
    expect(fit.missingRequirements).toContain('Go');
    expect(fit.hardBlockers).toEqual([]); // soft caps stay visible for review
  });
});
