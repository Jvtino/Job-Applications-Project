import { describe, expect, it } from 'vitest';
import { parseCareersUrl } from '../../src/finder/sources/index';

describe('parseCareersUrl (string parsing only — never fetches)', () => {
  it('recognizes Greenhouse board URLs', () => {
    for (const url of [
      'https://boards.greenhouse.io/stripe',
      'https://boards.greenhouse.io/stripe/jobs/12345',
      'https://job-boards.greenhouse.io/gitlab',
      'https://boards.greenhouse.io/stripe?utm_source=x',
    ]) {
      const detected = parseCareersUrl(url)!;
      expect(detected.sourceType).toBe('ats_greenhouse');
      expect(detected.slug).toMatch(/^greenhouse:(stripe|gitlab)$/);
      expect(detected.config.board_token).toBeTruthy();
    }
  });

  it('recognizes Lever site URLs', () => {
    const detected = parseCareersUrl('https://jobs.lever.co/acmepay/some-posting-id')!;
    expect(detected.sourceType).toBe('ats_lever');
    expect(detected.slug).toBe('lever:acmepay');
    expect(detected.config.site).toBe('acmepay');
    expect(detected.sourceName).toBe('Acmepay (Lever)');
  });

  it('builds display names from multi-word tokens', () => {
    expect(parseCareersUrl('https://boards.greenhouse.io/acme-health')!.sourceName).toBe(
      'Acme Health (Greenhouse)',
    );
  });

  it('rejects everything else', () => {
    for (const url of [
      'https://example.com/careers',
      'https://www.linkedin.com/jobs/view/1',
      'https://greenhouse.io/stripe',
      'https://boards.greenhouse.io/',
      'not a url',
      'https://jobs.lever.co/',
    ]) {
      expect(parseCareersUrl(url)).toBeNull();
    }
  });
});
