import { describe, expect, it } from 'vitest';
import { MATCH_LABELS, type MatchLabel } from '../../src/finder/shared';
import { scoreJob } from '../../src/finder/scoring/index';
import { OWNER_CASES, OWNER_PREFS, OWNER_PROFILE } from './fixtures/ownerCalibration';

/**
 * Owner calibration gate: scorecard-v2 must agree with the owner's own ratings
 * (AML/financial-crime analyst, ~2 yrs, NYC hybrid/onsite) — every case within one
 * band, and no inversions (a strong→weak or bad→strong flip). Encodes the tuning
 * decisions: degree credited, coverage band tightened, experience-stretch ceiling.
 */
const bandIndex = (label: MatchLabel) => MATCH_LABELS.indexOf(label);

describe('owner calibration (finance_compliance, real profile)', () => {
  const results = OWNER_CASES.map((c) => {
    const scored = scoreJob(c.job, OWNER_PROFILE, OWNER_PREFS);
    return { c, scored, drift: bandIndex(scored.label) - bandIndex(c.rating) };
  });

  it('every case is within one band of the owner rating', () => {
    const misses = results.filter((r) => Math.abs(r.drift) > 1);
    const detail = misses
      .map((m) => `  ${m.c.name}: rated ${m.c.rating}, got ${m.scored.label} (${m.scored.overall})`)
      .join('\n');
    expect(misses.length, `band misses:\n${detail}`).toBe(0);
  });

  it('credits the owner’s bachelor’s degree (finding #1)', () => {
    // "on-target KYC analyst" requires a Bachelor degree; the owner has one.
    const kyc = OWNER_CASES.find((c) => c.name.startsWith('on-target KYC'))!;
    const scored = scoreJob(kyc.job, OWNER_PROFILE, OWNER_PREFS);
    expect(scored.components.educationCertification.informative).toBe(true);
    expect(scored.components.educationCertification.score).toBe(1);
  });

  it('experience-stretch ceiling (loosened) softens by band with the gap', () => {
    const senior = OWNER_CASES.find((c) => c.name.startsWith('senior AML'))!;
    const officer = OWNER_CASES.find((c) => c.name.startsWith('BSA/AML officer'))!;
    expect(scoreJob(senior.job, OWNER_PROFILE, OWNER_PREFS).label).toBe('good'); // asks 5+ (gap 3)
    expect(scoreJob(officer.job, OWNER_PROFILE, OWNER_PREFS).label).toBe('weak'); // asks 8+ (gap 6)
  });

  it('an entry role with full skills is a strong match (no experience gap)', () => {
    const entry = OWNER_CASES.find((c) => c.name.startsWith('entry KYC associate'))!;
    expect(scoreJob(entry.job, OWNER_PROFILE, OWNER_PREFS).label).toBe('strong');
  });

  it('on-target NYC roles with full skill coverage still read strong', () => {
    const onTarget = OWNER_CASES.find((c) => c.name.startsWith('on-target KYC'))!;
    expect(scoreJob(onTarget.job, OWNER_PROFILE, OWNER_PREFS).label).toBe('strong');
  });

  it('a 1-year experience stretch with full skills stays strong (loosened)', () => {
    const sanctions = OWNER_CASES.find((c) => c.name.startsWith('sanctions analyst'))!;
    expect(scoreJob(sanctions.job, OWNER_PROFILE, OWNER_PREFS).label).toBe('strong'); // asks 3+, has 2
  });
});
