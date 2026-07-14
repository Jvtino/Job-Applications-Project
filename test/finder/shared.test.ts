import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCORE_WEIGHTS,
  IPC_CHANNELS,
  labelForScore,
  buildLinkedInJobSearchUrl,
  type IpcChannel,
  type IpcRequest,
} from '../../src/finder/shared/index';

describe('labelForScore (§15 bands)', () => {
  it('maps band edges exactly', () => {
    expect(labelForScore(100)).toBe('strong');
    expect(labelForScore(85)).toBe('strong');
    expect(labelForScore(84.9)).toBe('good');
    expect(labelForScore(70)).toBe('good');
    expect(labelForScore(69)).toBe('possible');
    expect(labelForScore(55)).toBe('possible');
    expect(labelForScore(54)).toBe('weak');
    expect(labelForScore(40)).toBe('weak');
    expect(labelForScore(39)).toBe('bad');
    expect(labelForScore(0)).toBe('bad');
  });
});

describe('default scorecard weights', () => {
  it('sum to 1.0', () => {
    const sum = Object.values(DEFAULT_SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 10);
  });
});

describe('IPC contract', () => {
  it('runtime channel list matches the contract', () => {
    expect(IPC_CHANNELS).toContain('db:health');
  });

  it('rejects unknown channels at compile time', () => {
    // Type-level negative test: if either line stops erroring, tsc fails the
    // build with "Unused '@ts-expect-error' directive".
    // @ts-expect-error — 'nope:nope' is not an IpcChannel
    const bad: IpcChannel = 'nope:nope';
    // @ts-expect-error — jobs:list request has no `foo` field
    const badReq: IpcRequest<'jobs:list'> = { foo: 1 };
    expect(bad).toBeDefined();
    expect(badReq).toBeDefined();
  });
});

describe('assisted links (§8.6 — link-out only)', () => {
  it('builds a LinkedIn search URL with encoded params', () => {
    const url = buildLinkedInJobSearchUrl({ keywords: 'KYC Analyst', location: 'New York, NY' });
    expect(url).toMatch(/^https:\/\/www\.linkedin\.com\/jobs\/search\/\?/);
    expect(url).toContain('keywords=KYC+Analyst');
    expect(url).toContain('location=New+York%2C+NY');
  });
});
