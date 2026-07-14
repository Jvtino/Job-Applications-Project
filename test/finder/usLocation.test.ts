import { describe, expect, it } from 'vitest';
import { classifyUsLocation, normalizeLocation } from '../../src/finder/normalization/index';

/** Classify straight from raw text, deriving the normalized form the way the scan does. */
function classify(raw: string | null) {
  return classifyUsLocation(raw, normalizeLocation(raw).locationNormalized);
}

describe('classifyUsLocation — US postings are kept', () => {
  it.each([
    'New York, NY',
    'San Francisco, CA',
    'Austin, TX, United States',
    'Washington, DC',
    'Seattle, Washington',
    'Chicago, IL, USA',
    'Boston, MA',
    'Remote (US)',
    'Remote - United States',
    'Mexico, MO', // Missouri, not the country
    'New Mexico',
  ])('%s → us', (raw) => {
    expect(classify(raw)).toBe('us');
  });
});

describe('classifyUsLocation — foreign postings are dropped', () => {
  it.each([
    'Kraków, Poland',
    'London, United Kingdom',
    'London, UK',
    'Toronto, Canada',
    'Bengaluru, India',
    'Berlin, Germany',
    'Paris, France',
    'Dublin, Ireland',
    'Remote - EMEA',
    'Remote, Germany',
    'Singapore',
    'Sydney, Australia',
    'São Paulo, Brazil',
    'Tel Aviv, Israel',
    'Dubai, UAE',
    'Amsterdam, Netherlands',
    'Tokyo, Japan',
  ])('%s → non_us', (raw) => {
    expect(classify(raw)).toBe('non_us');
  });
});

describe('classifyUsLocation — ambiguous is kept (never a false drop)', () => {
  it.each([
    ['Remote', 'unknown'],
    ['', 'unknown'],
    [null, 'unknown'],
    ['Anywhere', 'unknown'],
    ['Work from home', 'unknown'],
  ])('%s → %s', (raw, expected) => {
    expect(classify(raw as string | null)).toBe(expected);
  });

  it('does not mistake substrings for countries (Indiana ≠ India, Newark ≠ UK)', () => {
    expect(classify('Indianapolis, IN')).toBe('us');
    expect(classify('Newark, NJ')).toBe('us');
    expect(classify('Chinatown, San Francisco, CA')).toBe('us');
  });

  it('a bare foreign city with no country stays unknown (kept, not guessed)', () => {
    // We only drop on positively-named countries/regions; a lone city is kept.
    expect(classify('Manchester')).toBe('unknown');
  });
});
