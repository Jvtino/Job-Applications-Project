import { describe, expect, it } from 'vitest';
import type { RawJob } from '../../src/finder/shared';
import { htmlToText, normalizeJob } from '../../src/finder/normalization/index';

describe('htmlToText', () => {
  it('strips tags and collapses whitespace', () => {
    expect(htmlToText('<p>Hello   <strong>world</strong></p>')).toBe('Hello world');
  });

  it('turns block boundaries into line breaks', () => {
    expect(htmlToText('<p>One</p><p>Two</p><ul><li>A</li><li>B</li></ul>')).toBe('One\nTwo\nA\nB');
  });

  it('decodes double-escaped Greenhouse content', () => {
    expect(htmlToText('&lt;p&gt;AML &amp;amp; KYC work&lt;/p&gt;')).toBe('AML & KYC work');
  });

  it('decodes numeric entities', () => {
    expect(htmlToText('caf&#233; &#x2014; nice')).toBe('café — nice');
  });
});

describe('normalizeJob (v0)', () => {
  const raw: RawJob = {
    externalJobId: '1',
    company: '  Acme Corp ',
    title: ' KYC Analyst ',
    locationRaw: '  New   York, NY ',
    descriptionRaw: '<p>Sanctions &amp; screening</p>',
    applyUrl: 'https://x/1',
    canonicalUrl: null,
    postedAt: null,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    salaryPeriod: 'unknown',
    remoteType: 'unknown',
    employmentType: 'unknown',
    extra: {},
  };

  it('trims, lowercases location, and cleans the description', () => {
    const job = normalizeJob(raw);
    expect(job.company).toBe('Acme Corp');
    expect(job.title).toBe('KYC Analyst');
    expect(job.locationNormalized).toBe('new york, ny');
    expect(job.descriptionClean).toBe('Sanctions & screening');
    expect(job.requirements).toEqual([]);
  });

  it('handles missing location', () => {
    expect(normalizeJob({ ...raw, locationRaw: null }).locationNormalized).toBe('');
  });
});
