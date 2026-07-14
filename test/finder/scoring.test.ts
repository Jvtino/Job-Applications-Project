import { describe, expect, it } from 'vitest';
import { TRACKS, type ParsedResumeProfile } from '../../src/finder/shared';
import {
  DEFAULT_WEIGHTS,
  extractJobSignals,
  scoreJob,
  TRACK_WEIGHTS,
  type ScorableJob,
  type ScoringPreferences,
} from '../../src/finder/scoring/index';

const financeProfile: ParsedResumeProfile = {
  name: 'Maria',
  location: 'New York, NY',
  email: null,
  phone: null,
  summary: null,
  workHistory: [],
  jobTitles: ['Senior KYC Analyst', 'Compliance Analyst'],
  companies: [],
  skills: ['KYC', 'AML', 'EDD', 'OFAC', 'sanctions screening', 'transaction monitoring'],
  tools: [],
  certifications: ['CAMS'],
  education: [{ degree: 'Bachelor of Science in Finance', institution: 'Rutgers', year: '2016' }],
  industries: [],
  yearsExperience: 8,
  achievements: [],
  languages: [],
  workAuthorizationStatus: null,
};

const prefs: ScoringPreferences = {
  track: 'finance_compliance',
  targetTitles: ['KYC Analyst', 'Compliance Analyst', 'Sanctions Analyst'],
  excludedTitles: [],
  preferredLocations: ['New York, NY'],
  remotePreferences: ['remote', 'hybrid', 'onsite'],
  salaryMin: 85000,
  industries: ['banking', 'fintech'],
};

function job(over: Partial<ScorableJob>): ScorableJob {
  return {
    title: 'KYC Analyst',
    company: 'Meridian Bank',
    descriptionClean:
      'Our banking compliance team is hiring.\nRequirements\n3+ years of experience with KYC, AML, EDD, and OFAC sanctions screening. CAMS required.\nNice to have\nExperience with transaction monitoring tools.',
    locationNormalized: 'new york, ny',
    remoteType: 'onsite',
    salaryMin: 90000,
    salaryMax: 120000,
    salaryPeriod: 'year',
    postedAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    sourceType: 'ats_greenhouse',
    ...over,
  };
}

describe('weight tables', () => {
  it('every track sums to 1.0', () => {
    for (const track of TRACKS) {
      const sum = Object.values(TRACK_WEIGHTS[track]).reduce((a, b) => a + b, 0);
      expect(sum, track).toBeCloseTo(1.0, 9);
    }
  });

  it('track philosophies hold (§15): hourly boosts pay+location, tech boosts skills', () => {
    expect(TRACK_WEIGHTS.blue_collar_hourly.salary).toBeGreaterThan(DEFAULT_WEIGHTS.salary);
    expect(TRACK_WEIGHTS.blue_collar_hourly.location).toBeGreaterThan(DEFAULT_WEIGHTS.location);
    expect(TRACK_WEIGHTS.tech.requiredSkills).toBeGreaterThan(DEFAULT_WEIGHTS.requiredSkills);
    expect(TRACK_WEIGHTS.finance_compliance.educationCertification).toBeGreaterThan(
      DEFAULT_WEIGHTS.educationCertification,
    );
    expect(TRACK_WEIGHTS.government.title).toBeGreaterThan(DEFAULT_WEIGHTS.title);
  });

  it('weights snapshot — changes must be deliberate', () => {
    expect(TRACK_WEIGHTS).toMatchSnapshot();
  });
});

describe('extractJobSignals', () => {
  it('splits required vs preferred sections', () => {
    const signals = extractJobSignals(job({}).descriptionClean);
    expect(signals.hasExplicitSections).toBe(true);
    expect(signals.requiredSkills).toEqual(expect.arrayContaining(['KYC', 'AML', 'EDD', 'OFAC']));
    expect(signals.preferredSkills).toEqual(expect.arrayContaining(['transaction monitoring']));
    expect(signals.requiredCerts).toContain('CAMS');
    expect(signals.minYears).toBe(3);
  });

  it('falls back to whole-text when no headings exist', () => {
    const signals = extractJobSignals('We want someone who knows Python and SQL well.');
    expect(signals.hasExplicitSections).toBe(false);
    expect(signals.requiredSkills).toEqual(expect.arrayContaining(['Python', 'SQL']));
  });
});

describe('scoreJob — ordering sanity', () => {
  it('a strong on-profile job outscores an unrelated one decisively', () => {
    const strong = scoreJob(job({}), financeProfile, prefs);
    const unrelated = scoreJob(
      job({
        title: 'Line Cook',
        company: 'Diner Group',
        descriptionClean: 'Prepare food on the grill station and keep the kitchen clean.',
        locationNormalized: 'boise, id',
        salaryMin: null,
        salaryMax: null,
      }),
      financeProfile,
      prefs,
    );
    expect(strong.overall).toBeGreaterThanOrEqual(85);
    expect(['strong', 'good']).toContain(strong.label);
    expect(unrelated.overall).toBeLessThanOrEqual(40);
    expect(['bad', 'weak']).toContain(unrelated.label);
  });

  it('missing data redistributes weight — never a punitive zero', () => {
    const noSalaryNoDate = scoreJob(
      job({ salaryMin: null, salaryMax: null, postedAt: null }),
      financeProfile,
      prefs,
    );
    const full = scoreJob(job({}), financeProfile, prefs);
    // Both should score in the same band; missing metadata must not crater it.
    expect(Math.abs(noSalaryNoDate.overall - full.overall)).toBeLessThanOrEqual(12);
    expect(noSalaryNoDate.explanation.concerns.join(' ')).toMatch(/Salary is not listed/);
  });

  it('missing required certification produces the §16 concern', () => {
    const noCams = { ...financeProfile, certifications: [] };
    const result = scoreJob(job({}), noCams, prefs);
    expect(result.explanation.concerns.join(' ')).toMatch(/CAMS/);
    expect(result.components.educationCertification.score).toBeLessThan(0.5);
  });

  it('wrong seniority is scored and explained', () => {
    const junior = { ...financeProfile, yearsExperience: 1 };
    const demanding = job({
      descriptionClean: 'Requirements\n8+ years of experience with KYC and AML programs.',
    });
    const result = scoreJob(demanding, junior, prefs);
    expect(result.components.experience.score).toBeLessThan(0.5);
    expect(result.explanation.concerns.join(' ')).toMatch(/8\+ years/);
  });

  it('excluded titles cap the score hard', () => {
    const result = scoreJob(job({ title: 'KYC Analyst (Contract)' }), financeProfile, {
      ...prefs,
      excludedTitles: ['contract'],
    });
    expect(result.overall).toBeLessThanOrEqual(15);
    expect(result.explanation.concerns[0]).toMatch(/excluded/);
  });

  it('hourly pay annualizes for the salary check', () => {
    const hourly = scoreJob(
      job({ salaryMin: 45, salaryMax: 50, salaryPeriod: 'hour' }), // ≈ $104k
      financeProfile,
      prefs,
    );
    expect(hourly.components.salary.score).toBe(1);
    const lowHourly = scoreJob(
      job({ salaryMin: 18, salaryMax: 22, salaryPeriod: 'hour' }), // ≈ $46k
      financeProfile,
      prefs,
    );
    expect(lowHourly.components.salary.score).toBeLessThan(0.5);
  });

  it('aggregator copies score lower on source quality with a concern', () => {
    const agg = scoreJob(job({ sourceType: 'api_adzuna' }), financeProfile, prefs);
    const direct = scoreJob(job({}), financeProfile, prefs);
    expect(agg.components.sourceQuality.score).toBeLessThan(direct.components.sourceQuality.score);
  });
});

describe('scoreJob — explanations (§16)', () => {
  it('every score has at least one why bullet', () => {
    for (const sample of [
      job({}),
      job({ title: 'Zookeeper', descriptionClean: 'Feed the animals daily.' }),
    ]) {
      expect(scoreJob(sample, financeProfile, prefs).explanation.why.length).toBeGreaterThanOrEqual(
        1,
      );
    }
  });

  it('components contributing ≥10 points always appear in the explanation', () => {
    const result = scoreJob(job({}), financeProfile, prefs);
    // requiredSkills carries 22% weight for finance and scores ~1 → must be in why.
    expect(result.explanation.why.join(' ')).toMatch(/requirement|skills/i);
  });

  it('never uses banned overclaiming phrases (§23)', () => {
    const samples = [
      job({}),
      job({ title: 'Chief Compliance Officer' }),
      job({ title: 'Zookeeper', descriptionClean: 'Feed the animals.' }),
      job({ salaryMin: null, salaryMax: null, postedAt: '2020-01-01T00:00:00Z' }),
    ];
    for (const sample of samples) {
      const text = JSON.stringify(
        scoreJob(sample, financeProfile, prefs).explanation,
      ).toLowerCase();
      expect(text).not.toContain('qualified');
      expect(text).not.toContain('perfect match');
      expect(text).not.toContain('guaranteed');
      expect(text).not.toContain('definitely apply');
    }
  });

  it('is deterministic', () => {
    const a = scoreJob(job({}), financeProfile, prefs);
    const b = scoreJob(job({}), financeProfile, prefs);
    expect(a.overall).toBe(b.overall);
    expect(a.explanation).toEqual(b.explanation);
  });
});

describe('scoreJob — track weighting changes outcomes', () => {
  it('the same job scores differently under different tracks', () => {
    // Slightly under the $85k minimum (~88%): salary scores 0.55, no floor cap
    // fires, so the difference comes purely from the weight tables.
    const sample = job({ salaryMin: 70000, salaryMax: 75000 });
    const asFinance = scoreJob(sample, financeProfile, { ...prefs, track: 'finance_compliance' });
    const asHourly = scoreJob(sample, financeProfile, { ...prefs, track: 'blue_collar_hourly' });
    // Hourly track weights salary 5× more → low pay should hurt more there.
    expect(asHourly.overall).toBeLessThan(asFinance.overall);
  });

  it('a job paying >15% under the stated floor never ranks above possible', () => {
    const result = scoreJob(job({ salaryMin: 40000, salaryMax: 45000 }), financeProfile, prefs);
    expect(result.overall).toBeLessThanOrEqual(65);
    expect(result.explanation.concerns.join(' ')).toMatch(/below your minimum/);
  });

  it('off-profile jobs are gated out of the possible band', () => {
    const result = scoreJob(
      job({
        title: 'Staff Accountant',
        descriptionClean:
          'Requirements\nGAAP, month-end close, reconciliation. CPA track. Bachelor degree required.',
      }),
      { ...financeProfile, skills: ['forklift', 'pallet jack'], certifications: [] },
      { ...prefs, targetTitles: ['Forklift Operator'] },
    );
    expect(result.overall).toBeLessThanOrEqual(34);
  });
});
