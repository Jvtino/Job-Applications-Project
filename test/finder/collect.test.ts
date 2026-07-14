import { describe, expect, it } from 'vitest';
import { JobCollector, type CollectSource } from '../../src/finder/dedupe/index';
import type { NormalizedJob } from '../../src/finder/shared';

function mkJob(o: Partial<NormalizedJob>): NormalizedJob {
  return {
    externalJobId: null,
    company: 'Acme Corp',
    title: 'AML Analyst',
    locationRaw: 'New York, NY',
    descriptionRaw: '',
    applyUrl: 'https://example.com/j/1',
    canonicalUrl: null,
    postedAt: null,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    salaryPeriod: 'unknown',
    remoteType: 'unknown',
    employmentType: 'unknown',
    extra: {},
    locationNormalized: 'New York, NY',
    descriptionClean: '',
    requirements: [],
    responsibilities: [],
    ...o,
  };
}

const ats: CollectSource = {
  sourceType: 'ats_greenhouse',
  sourceId: 'greenhouse:acme',
  sourceName: 'Acme (Greenhouse)',
};
const email: CollectSource = {
  sourceType: 'assisted_linkedin',
  sourceId: 'linkedin-email',
  sourceName: 'LinkedIn alerts',
};

const LONG_DESC =
  'Investigate AML alerts, file SARs, and perform EDD on high-risk customers across the firm. '.repeat(3);

describe('JobCollector cross-source dedupe', () => {
  it('collapses the same role seen via an ATS feed and a LinkedIn alert email into one record (ATS wins)', () => {
    const gh = mkJob({
      externalJobId: 'gh-123',
      applyUrl: 'https://boards.greenhouse.io/acme/jobs/123',
      descriptionClean: LONG_DESC,
    });
    const li = mkJob({
      externalJobId: null,
      applyUrl: 'https://www.linkedin.com/jobs/view/456',
      descriptionClean: '',
    });

    // Order 1: the email lead arrives first, then the ATS posting.
    const a = new JobCollector();
    a.add(li, email);
    a.add(gh, ats);
    expect(a.size).toBe(1);
    expect(a.values()[0]!.job.applyUrl).toContain('greenhouse.io');
    expect(a.values()[0]!.sourceType).toBe('ats_greenhouse');

    // Order 2: the ATS posting first, then the email lead — same collapse, ATS still wins.
    const b = new JobCollector();
    b.add(gh, ats);
    b.add(li, email);
    expect(b.size).toBe(1);
    expect(b.values()[0]!.job.applyUrl).toContain('greenhouse.io');
    expect(b.values()[0]!.sourceType).toBe('ats_greenhouse');
  });

  it('keeps genuinely distinct roles separate', () => {
    const c = new JobCollector();
    c.add(
      mkJob({ company: 'Acme Corp', title: 'AML Analyst', applyUrl: 'https://a.co/1', locationNormalized: 'New York, NY' }),
      ats,
    );
    c.add(
      mkJob({ company: 'Globex', title: 'Data Scientist', applyUrl: 'https://b.co/2', locationNormalized: 'Austin, TX' }),
      email,
    );
    expect(c.size).toBe(2);
  });

  it('refreshes (does not duplicate) the same posting re-seen from the same board', () => {
    const c = new JobCollector();
    c.add(mkJob({ externalJobId: 'gh-9', applyUrl: 'https://boards.greenhouse.io/acme/jobs/9', descriptionClean: LONG_DESC }), ats);
    c.add(mkJob({ externalJobId: 'gh-9', applyUrl: 'https://boards.greenhouse.io/acme/jobs/9', descriptionClean: LONG_DESC }), ats);
    expect(c.size).toBe(1);
  });

  it('collapses two sources that share one apply URL', () => {
    const c = new JobCollector();
    c.add(
      mkJob({ applyUrl: 'https://jobs.acme.com/x' }),
      { sourceType: 'career_page', sourceId: 'acme-careers', sourceName: 'Acme careers' },
    );
    c.add(mkJob({ applyUrl: 'https://jobs.acme.com/x' }), email);
    expect(c.size).toBe(1);
  });
});
