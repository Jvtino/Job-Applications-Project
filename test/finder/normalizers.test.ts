import { describe, expect, it } from 'vitest';
import { normalizeCompany, normalizeLocation, normalizeTitle, parseSalaryText } from '../../src/finder/normalization/index';

describe('normalizeTitle (≥30 table cases)', () => {
  const cases: Array<[string, string]> = [
    ['Software Engineer', 'software engineer'],
    ['  Software  Engineer  ', 'software engineer'],
    ['Sr. Software Engineer', 'senior software engineer'],
    ['Sr Software Engineer', 'senior software engineer'],
    ['Jr. Developer', 'junior developer'],
    ['Software Engineer II', 'software engineer ii'],
    ['Software Engineer III', 'software engineer iii'],
    ['KYC Analyst (Remote)', 'kyc analyst'],
    ['KYC Analyst (Remote - US)', 'kyc analyst'],
    ['Account Executive (Hybrid)', 'account executive'],
    ['Warehouse Associate (On-Site)', 'warehouse associate'],
    ['Nurse (Multiple Locations)', 'nurse'],
    ['Compliance Analyst - 84321', 'compliance analyst'],
    ['Compliance Analyst — Req 10042', 'compliance analyst'],
    ['Compliance Analyst #12345', 'compliance analyst'],
    ['Backend Engineer — Payments', 'backend engineer payments'],
    ['Backend Engineer – Payments', 'backend engineer payments'],
    ['Backend Engineer - Payments', 'backend engineer payments'],
    ['Engineer/Analyst', 'engineer analyst'],
    ['Ops | Finance Lead', 'ops finance lead'],
    ['Mgr, Customer Support', 'manager, customer support'],
    ['Assoc. Product Manager', 'associate product manager'],
    ['Sales Rep', 'sales representative'],
    ['HR Coord.', 'hr coordinator'],
    ['C++ Developer', 'c++ developer'],
    ['C# Engineer', 'c# engineer'],
    ['.NET Developer', '.net developer'],
    ['Registered Nurse (RN)', 'registered nurse rn'],
    ['Forklift Operator – 2nd Shift', 'forklift operator 2nd shift'],
    ['Data Entry Clerk.', 'data entry clerk'],
    ['Spec. Projects Lead', 'specialist projects lead'],
    ['Customer Support Engr', 'customer support engineer'],
  ];
  it.each(cases)('%s → %s', (input, expected) => {
    expect(normalizeTitle(input)).toBe(expected);
  });
});

describe('normalizeLocation (≥30 table cases)', () => {
  const cases: Array<[string | null, string, string]> = [
    // [input, locationNormalized, remoteType]
    ['New York, NY', 'new york, ny', 'unknown'],
    ['new york, ny', 'new york, ny', 'unknown'],
    ['New York, New York', 'new york, ny', 'unknown'],
    ['New York, New York, United States', 'new york, ny', 'unknown'],
    ['New York, NY, USA', 'new york, ny', 'unknown'],
    ['Columbus, Ohio, United States', 'columbus, oh', 'unknown'],
    ['San Francisco, CA (Hybrid)', 'san francisco, ca', 'hybrid'],
    ['Austin, Texas (Remote Eligible)', 'austin, tx', 'remote'],
    ['NYC', 'new york, ny', 'unknown'],
    ['SF', 'san francisco, ca', 'unknown'],
    ['Remote', 'remote', 'remote'],
    ['Remote - US', 'remote', 'remote'],
    ['Remote (US)', 'remote', 'remote'],
    ['US Remote', 'remote', 'remote'],
    ['Remote, United States', 'remote', 'remote'],
    ['Work From Home', 'remote', 'remote'],
    ['Anywhere', 'remote', 'remote'],
    ['Remote - New York, NY', 'new york, ny', 'remote'],
    ['Hybrid - Chicago, IL', 'chicago, il', 'hybrid'],
    ['Chicago, IL; Austin, TX', 'chicago, il', 'unknown'],
    ['Chicago, IL / Austin, TX', 'chicago, il', 'unknown'],
    ['Seattle, WA or Remote', 'seattle, wa', 'remote'],
    ['Washington, District of Columbia', 'washington, dc', 'unknown'],
    ['Boston, Massachusetts, US', 'boston, ma', 'unknown'],
    ['Phoenix, AZ, United States of America', 'phoenix, az', 'unknown'],
    ['Salt Lake City, Utah', 'salt lake city, ut', 'unknown'],
    ['St. Louis, Missouri', 'st. louis, mo', 'unknown'],
    ['Texas', 'tx', 'unknown'],
    ['California', 'ca', 'unknown'],
    ['United States', '', 'unknown'],
    ['', '', 'unknown'],
    [null, '', 'unknown'],
  ];
  it.each(cases)('%s → %s (%s)', (input, expectedLocation, expectedRemote) => {
    const result = normalizeLocation(input);
    expect(result.locationNormalized).toBe(expectedLocation);
    expect(result.remoteType).toBe(expectedRemote);
  });
});

describe('parseSalaryText (≥20 table cases)', () => {
  const cases: Array<[string, { min: number | null; max: number | null; period: string } | null]> =
    [
      ['Pay: $80,000 - $100,000 per year', { min: 80000, max: 100000, period: 'year' }],
      ['$80k–$100k', { min: 80000, max: 100000, period: 'year' }],
      ['$80K - $100K annually', { min: 80000, max: 100000, period: 'year' }],
      ['$80,000 to $100,000 a year', { min: 80000, max: 100000, period: 'year' }],
      ['Pay $18.50 - $22.00 per hour', { min: 18.5, max: 22, period: 'hour' }],
      ['$18.50-$22.00/hr', { min: 18.5, max: 22, period: 'hour' }],
      ['$18 - $22 an hour', { min: 18, max: 22, period: 'hour' }],
      ['$35/hour', null], // single amount without starting-at phrasing: too ambiguous
      ['starting at $65,000', { min: 65000, max: null, period: 'year' }],
      ['Starting at $22.50', { min: 22.5, max: null, period: 'hour' }],
      ['up to $120,000', { min: 120000, max: null, period: 'year' }],
      ['from $95k', { min: 95000, max: null, period: 'year' }],
      ['salary range $110,000 – $135,000', { min: 110000, max: 135000, period: 'year' }],
      ['The range is $142,000—$188,000 + equity', { min: 142000, max: 188000, period: 'year' }],
      ['$100,000-$90,000 (typo range swaps)', { min: 90000, max: 100000, period: 'year' }],
      ['We pay competitively', null],
      ['401k match and equity', null], // '401k' must not parse as $401,000
      ['Earn $19 per hour plus tips', null], // single bare amount: skipped
      ['comp range: $150k-190k', { min: 150000, max: 190000, period: 'year' }],
      ['$55,000 - $65,000', { min: 55000, max: 65000, period: 'year' }],
      ['$30 - $38 hourly', { min: 30, max: 38, period: 'hour' }],
      ['no dollar amounts here at all', null],
    ];
  it.each(cases)('%s', (input, expected) => {
    const result = parseSalaryText(input);
    if (expected === null) {
      expect(result).toBeNull();
    } else {
      expect(result).not.toBeNull();
      expect(result!.min).toBe(expected.min);
      expect(result!.max).toBe(expected.max);
      expect(result!.period).toBe(expected.period);
    }
  });
});

describe('normalizeCompany', () => {
  const cases: Array<[string, string]> = [
    ['Acme Corp', 'acme'],
    ['Acme Corporation', 'acme'],
    ['Acme, Inc.', 'acme'],
    ['Acme Inc', 'acme'],
    ['Acme LLC', 'acme'],
    ['Acme Holdings, Inc.', 'acme'],
    ['ACME LTD', 'acme'],
    ['Smith & Sons Co.', 'smith & sons'],
    ['  Stripe  ', 'stripe'],
    ["O'Reilly Media", 'o reilly media'],
  ];
  it.each(cases)('%s → %s', (input, expected) => {
    expect(normalizeCompany(input)).toBe(expected);
  });
});
