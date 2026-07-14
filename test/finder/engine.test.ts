import { describe, expect, it } from 'vitest';
import { canonicalizeUrl, decideForMatch, descriptionHash, sourcePriority } from '../../src/finder/dedupe/index';
import type { ExistingJobMeta } from '../../src/finder/dedupe/index';

describe('canonicalizeUrl', () => {
  const cases: Array<[string, string]> = [
    [
      'https://boards.greenhouse.io/acme/jobs/123?utm_source=x&utm_campaign=y',
      'https://boards.greenhouse.io/acme/jobs/123',
    ],
    [
      'https://boards.greenhouse.io/acme/jobs/123?gh_src=abc',
      'https://boards.greenhouse.io/acme/jobs/123',
    ],
    ['https://jobs.lever.co/acme/xyz?lever-source=linkedin', 'https://jobs.lever.co/acme/xyz'],
    ['https://Example.com/Jobs/', 'https://example.com/Jobs'],
    ['https://example.com/jobs#apply', 'https://example.com/jobs'],
    ['https://example.com/jobs?b=2&a=1', 'https://example.com/jobs?a=1&b=2'],
    ['https://example.com/jobs?fbclid=zzz&page=2', 'https://example.com/jobs?page=2'],
    ['https://example.com:443/jobs', 'https://example.com/jobs'],
    ['https://example.com/jobs?ref=homepage', 'https://example.com/jobs'],
    ['not a url at all', 'not a url at all'],
  ];
  it.each(cases)('%s → %s', (input, expected) => {
    expect(canonicalizeUrl(input)).toBe(expected);
  });

  it('identical postings with different tracking params hash equal', () => {
    expect(canonicalizeUrl('https://x.io/j/1?utm_source=a')).toBe(
      canonicalizeUrl('https://x.io/j/1?utm_source=b&gh_src=c#top'),
    );
  });
});

describe('descriptionHash', () => {
  it('normalizes whitespace and case', () => {
    expect(descriptionHash('Run  AML   investigations daily. '.repeat(10))).toBe(
      descriptionHash('run aml investigations daily. '.repeat(10).trim()),
    );
  });
  it('refuses short blurbs (no identity in them)', () => {
    expect(descriptionHash('Apply now!')).toBeNull();
  });
});

describe('sourcePriority (§7: employer beats aggregator)', () => {
  it('ranks direct ATS above aggregators', () => {
    expect(sourcePriority('ats_greenhouse')).toBeLessThan(sourcePriority('api_adzuna'));
    expect(sourcePriority('ats_lever')).toBeLessThan(sourcePriority('api_jooble'));
    expect(sourcePriority('api_usajobs')).toBeLessThan(sourcePriority('career_page'));
  });
});

describe('decideForMatch — the veto rules', () => {
  const gh = { sourceId: 'src-gh', sourceType: 'ats_greenhouse' };
  const agg = { sourceId: 'src-agg', sourceType: 'api_adzuna' };

  const existing = (over: Partial<ExistingJobMeta>): ExistingJobMeta => ({
    jobId: 'j-existing',
    sourceId: 'src-gh',
    sourceType: 'ats_greenhouse',
    externalJobId: 'gh-1',
    canonicalCompany: 'acme',
    ...over,
  });

  it('ats_key hit → refresh (board identity)', () => {
    expect(
      decideForMatch(
        'ats_key',
        { source: gh, externalJobId: 'gh-1', canonicalCompany: 'acme' },
        existing({}),
        false,
      ).action,
    ).toBe('refresh');
  });

  it('VETO: same source, different requisition ids never merge — any key type', () => {
    for (const keyType of ['url_hash', 'description_hash', 'company_title_location'] as const) {
      const decision = decideForMatch(
        keyType,
        { source: gh, externalJobId: 'gh-2', canonicalCompany: 'acme' },
        existing({ externalJobId: 'gh-1' }),
        true,
      );
      expect(decision.action, keyType).toBe('insert');
    }
  });

  it('url_hash across sources → merge', () => {
    expect(
      decideForMatch(
        'url_hash',
        { source: agg, externalJobId: 'adz-9', canonicalCompany: 'acme' },
        existing({}),
        false,
      ).action,
    ).toBe('merge');
  });

  it('description_hash guards against cross-company boilerplate', () => {
    expect(
      decideForMatch(
        'description_hash',
        { source: agg, externalJobId: 'adz-9', canonicalCompany: 'globex' },
        existing({ canonicalCompany: 'acme' }),
        true,
      ).action,
    ).toBe('insert');
  });

  it('description_hash same company across sources → merge', () => {
    expect(
      decideForMatch(
        'description_hash',
        { source: agg, externalJobId: 'adz-9', canonicalCompany: 'acme' },
        existing({}),
        true,
      ).action,
    ).toBe('merge');
  });

  it('ctl across source TYPES (aggregator vs ATS) → merge', () => {
    expect(
      decideForMatch(
        'company_title_location',
        { source: agg, externalJobId: 'adz-9', canonicalCompany: 'acme' },
        existing({}),
        false,
      ).action,
    ).toBe('merge');
  });

  it('ctl across two boards of the SAME type needs description proof', () => {
    const incoming = {
      source: { sourceId: 'src-gh2', sourceType: 'ats_greenhouse' },
      externalJobId: 'gh2-5',
      canonicalCompany: 'acme',
    };
    expect(decideForMatch('company_title_location', incoming, existing({}), false).action).toBe(
      'insert',
    );
    expect(decideForMatch('company_title_location', incoming, existing({}), true).action).toBe(
      'merge',
    );
  });

  it('ctl across two DIRECT ATS types (Greenhouse vs Lever) also needs description proof', () => {
    const incoming = {
      source: { sourceId: 'src-lever', sourceType: 'ats_lever' },
      externalJobId: 'lv-5',
      canonicalCompany: 'acme',
    };
    expect(decideForMatch('company_title_location', incoming, existing({}), false).action).toBe(
      'insert',
    );
    expect(decideForMatch('company_title_location', incoming, existing({}), true).action).toBe(
      'merge',
    );
  });
});
