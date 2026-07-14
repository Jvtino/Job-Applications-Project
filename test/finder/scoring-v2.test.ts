import { describe, expect, it } from 'vitest';
import {
  canonicalSkillKey,
  dedupeByCanonicalSkill,
  type ParsedResumeProfile,
} from '../../src/finder/shared';
import { extractJobSignals, scoreJob } from '../../src/finder/scoring/index';
import type { ScorableJob, ScoringPreferences } from '../../src/finder/scoring/scoreJob';

// A tech profile whose skills use the everyday résumé spellings ("Excel", "JS",
// "node") the JOB side would name with dictionary spellings ("Microsoft Excel",
// "JavaScript", "Node.js"). scorecard-v1 compared these by exact string and
// missed them all; v2 reconciles via canonicalSkillKey.
const techProfile: ParsedResumeProfile = {
  name: null,
  location: null,
  email: null,
  phone: null,
  summary: null,
  workHistory: [],
  jobTitles: ['Software Engineer', 'Senior Software Engineer'],
  companies: [],
  skills: ['JS', 'TypeScript', 'node', 'React', 'SQL', 'AWS', 'Excel'],
  tools: [],
  certifications: [],
  education: [],
  industries: [],
  yearsExperience: 7,
  achievements: [],
  languages: [],
  workAuthorizationStatus: null,
};

const techPrefs: ScoringPreferences = {
  track: 'tech',
  targetTitles: ['Software Engineer', 'Backend Engineer', 'Full Stack Engineer'],
  excludedTitles: [],
  preferredLocations: ['San Francisco, CA'],
  remotePreferences: ['remote', 'hybrid'],
  salaryMin: 150000,
  industries: ['software', 'saas'],
};

function techJob(over: Partial<ScorableJob>): ScorableJob {
  return {
    title: 'Software Engineer',
    company: 'Streamlogic',
    descriptionClean:
      'Requirements\n5+ years of experience with JavaScript, Node.js, React, and SQL. Microsoft Excel reporting.',
    locationNormalized: 'san francisco, ca',
    remoteType: 'remote',
    salaryMin: 170000,
    salaryMax: 200000,
    salaryPeriod: 'year',
    postedAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    sourceType: 'ats_greenhouse',
    ...over,
  };
}

describe('canonicalSkillKey (Phase A vocabulary parity)', () => {
  it('folds dictionary and résumé spellings to one key', () => {
    expect(canonicalSkillKey('Microsoft Excel')).toBe(canonicalSkillKey('Excel'));
    expect(canonicalSkillKey('JS')).toBe(canonicalSkillKey('JavaScript'));
    expect(canonicalSkillKey('Node.js')).toBe(canonicalSkillKey('node'));
    expect(canonicalSkillKey('anti-money laundering')).toBe(canonicalSkillKey('AML'));
    expect(canonicalSkillKey('CI / CD')).toBe(canonicalSkillKey('CI/CD'));
  });

  it('keeps distinct skills distinct (no false collisions)', () => {
    expect(canonicalSkillKey('Python')).not.toBe(canonicalSkillKey('SQL'));
    expect(canonicalSkillKey('accounts payable')).not.toBe(canonicalSkillKey('accounts receivable'));
    expect(canonicalSkillKey('C++')).toBe('c++');
    expect(canonicalSkillKey('C#')).toBe('c#');
  });

  it('dedupeByCanonicalSkill collapses "Microsoft Excel" + "Excel" to one', () => {
    expect(dedupeByCanonicalSkill(['Microsoft Excel', 'Excel', 'SQL'])).toHaveLength(2);
  });
});

describe('required-skill matching reconciles vocabularies (Phase A)', () => {
  it('a résumé using everyday spellings still covers dictionary-spelled requirements', () => {
    const result = scoreJob(techJob({}), techProfile, techPrefs);
    // JavaScript, Node.js, React, SQL, Microsoft Excel are all in the résumé under
    // "JS"/"node"/"Excel" etc. — coverage should be high, not near-zero.
    expect(result.components.requiredSkills.score).toBeGreaterThan(0.8);
    expect(result.listing.requirementsMet).toEqual(
      expect.arrayContaining(['JavaScript', 'Node.js', 'React', 'SQL']),
    );
    expect(['strong', 'good']).toContain(result.label);
  });
});

describe('jobSignals extraction fixes (Phase B)', () => {
  it('a preferred-only heading does NOT push nice-to-haves into required (#4)', () => {
    const signals = extractJobSignals(
      'Build great products with our team.\nPreferred qualifications\nKubernetes and Terraform experience.',
    );
    expect(signals.hasExplicitSections).toBe(false); // no explicit "Requirements" heading
    // Kubernetes/Terraform were under "Preferred" → must be preferred, never required.
    expect(signals.preferredSkills).toEqual(expect.arrayContaining(['Kubernetes', 'Terraform']));
    expect(signals.requiredSkills).not.toEqual(expect.arrayContaining(['Kubernetes', 'Terraform']));
  });

  it('ignores "combined team experience" and takes the lowest real bar (#5)', () => {
    const signals = extractJobSignals(
      'Our team has 20 years of combined experience.\nRequirements\n3+ years of experience with Python.',
    );
    expect(signals.minYears).toBe(3);
  });

  it('takes the low end of a stated range (#5)', () => {
    expect(extractJobSignals('Requirements\n0-2 years of experience.').minYears).toBe(0);
    expect(extractJobSignals('Requirements\n3-5 years of experience.').minYears).toBe(3);
  });
});

describe('negotiable requirements (Phase B)', () => {
  it('experience within a couple years of the bar is a near-miss, not a crater', () => {
    const junior = { ...techProfile, yearsExperience: 3 };
    const demands5 = techJob({ descriptionClean: 'Requirements\n5+ years of experience with React.' });
    const c = scoreJob(demands5, junior, techPrefs).components.experience;
    expect(c.score).toBeGreaterThanOrEqual(0.6); // gap of 2 → tolerant
  });

  it('adjacent/transferable roles get credit instead of a zero', () => {
    // A data-engineering role (shares the "engineering"/"data" family) whose exact
    // required skills the résumé only partly lists still clears the off-profile gate.
    const dataRole = techJob({
      title: 'Data Engineer',
      descriptionClean: 'Requirements\nSpark, Airflow, and dbt pipelines. 4+ years of experience.',
    });
    const result = scoreJob(dataRole, techProfile, techPrefs);
    expect(result.overall).toBeGreaterThan(34); // not gated as off-profile
  });

  it('a truly unrelated role is still gated out (relevance floor holds)', () => {
    const lineCook = techJob({
      title: 'Line Cook',
      company: 'Harbor Diner',
      descriptionClean: 'Prepare food on the grill station and keep the kitchen clean.',
      remoteType: 'onsite',
      salaryMin: 40000,
      salaryMax: 45000,
    });
    const result = scoreJob(lineCook, techProfile, techPrefs);
    expect(['bad', 'weak']).toContain(result.label);
  });

  it('a remote role is not punished when the user stated no work-mode preference', () => {
    const noPref = { ...techPrefs, remotePreferences: [] as string[] };
    const c = scoreJob(techJob({ remoteType: 'remote' }), techProfile, noPref).components.location;
    expect(c.score).toBeGreaterThanOrEqual(0.6);
  });

  it('industry match is word-boundary (no "art" inside "start")', () => {
    const artPrefs = { ...techPrefs, industries: ['art'] };
    const c = scoreJob(
      techJob({ descriptionClean: 'Requirements\nWe move fast and start strong. React, SQL.' }),
      techProfile,
      artPrefs,
    ).components.industry;
    expect(c.score).toBeLessThan(1); // "start" must not count as an "art" industry hit
  });
});

describe('requirement listing (Phase C)', () => {
  it('lists met requirements, negotiable gaps, and recommended-qual coverage', () => {
    const job = techJob({
      descriptionClean:
        'Requirements\n8+ years of experience with JavaScript, Node.js, React, SQL, and Go.\nPreferred qualifications\nAWS and Docker.',
    });
    const result = scoreJob(job, techProfile, techPrefs);
    // Met: skills the résumé covers. Missing (negotiable): Go + the 8y bar (résumé shows 7).
    expect(result.listing.requirementsMet).toEqual(expect.arrayContaining(['JavaScript', 'SQL']));
    expect(result.listing.requirementsMissing.join(' ')).toMatch(/Go|years/);
    // AWS is a nice-to-have the résumé covers; Docker is a nice-to-have gap.
    expect(result.listing.preferredMet).toContain('AWS');
    expect(result.listing.preferredMissing).toContain('Docker');
  });
});
