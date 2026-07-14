import { describe, expect, it } from 'vitest';
import { keywordSources } from '../../src/finder/pipeline/company-sources';
import type { ScoringPreferences } from '../../src/finder/scoring/scoreJob';

const prefs: ScoringPreferences = {
  track: 'finance_compliance',
  targetTitles: ['AML Analyst', 'KYC Analyst', 'Sanctions Analyst'],
  excludedTitles: [],
  preferredLocations: ['New York, NY'],
  remotePreferences: ['hybrid', 'onsite'],
  salaryMin: 65000,
  industries: ['banking'],
};

const withKey = (key: string): string | null =>
  key === 'keys.usajobs.api_key'
    ? 'test-key'
    : key === 'keys.usajobs.user_agent_email'
      ? 'me@example.com'
      : null;

describe('keywordSources — USAJOBS (opt-in)', () => {
  it('emits nothing when no USAJOBS key is configured', () => {
    expect(keywordSources(prefs)).toEqual([]);
    expect(keywordSources(prefs, () => null)).toEqual([]);
    // key present but email missing → still off
    expect(keywordSources(prefs, (k) => (k === 'keys.usajobs.api_key' ? 'x' : null))).toEqual([]);
  });

  it('emits USAJOBS sources once the key + email are present', () => {
    const sources = keywordSources(prefs, withKey);
    expect(sources.length).toBeGreaterThan(0);
    for (const s of sources) {
      expect(s.sourceType).toBe('api_usajobs');
      expect(s.baseUrl).toBe('https://data.usajobs.gov/api/search');
      expect(typeof s.config.keyword).toBe('string');
      expect((s.config.keyword as string).length).toBeGreaterThan(1);
    }
  });

  it('includes the user target titles and compliance-pack terms, deduped and capped at 8', () => {
    const keywords = keywordSources(prefs, withKey).map((s) => s.config.keyword as string);
    expect(keywords).toEqual(expect.arrayContaining(['AML Analyst', 'KYC Analyst']));
    // compliance role-family pack contributes federal-relevant terms
    expect(keywords.join(' | ').toLowerCase()).toMatch(/financial crimes|aml|bsa|sanctions/);
    // and entry/associate + federal titles, so early-career roles are queried too
    expect(keywords.join(' | ').toLowerCase()).toMatch(/associate|intelligence analyst/);
    expect(keywords.length).toBeLessThanOrEqual(8);
    expect(new Set(keywords.map((k) => k.toLowerCase())).size).toBe(keywords.length); // no dups
  });

  it('falls back to a generic keyword when no titles/pack terms exist', () => {
    const bare: ScoringPreferences = { ...prefs, track: 'entry_level', targetTitles: [] };
    const keywords = keywordSources(bare, withKey).map((s) => s.config.keyword as string);
    expect(keywords).toEqual(['analyst']);
  });
});
