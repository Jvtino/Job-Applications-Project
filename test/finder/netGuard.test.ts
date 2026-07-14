import { describe, expect, it } from 'vitest';
import { MockAgent } from 'undici';
import { NetGuard, NetGuardError } from '../../src/finder/net/index';

function mockedGuard(overrides: ConstructorParameters<typeof NetGuard>[0] = {}) {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  const guard = new NetGuard({ dispatcher: mockAgent, minIntervalMs: 0, ...overrides });
  return { guard, mockAgent };
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'no_error';
  } catch (err) {
    if (err instanceof NetGuardError) return err.code;
    throw err;
  }
}

describe('NetGuard — reads only (GET + a read-only search POST; never submits)', () => {
  it('rejects mutating methods (PUT/PATCH/DELETE) without touching the network', async () => {
    const { guard } = mockedGuard();
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      expect(
        await errorCode(guard.get('https://boards-api.greenhouse.io/v1/boards/x/jobs', { method })),
      ).toBe('method_not_allowed');
    }
  });

  it('allows a read-only search POST to an allowlisted (Workday) host', async () => {
    const { guard, mockAgent } = mockedGuard();
    mockAgent
      .get('https://acme.wd1.myworkdayjobs.com')
      .intercept({ path: '/wday/cxs/acme/External/jobs', method: 'POST' })
      .reply(200, JSON.stringify({ total: 0, jobPostings: [] }), {
        headers: { 'content-type': 'application/json' },
      });
    const res = await guard.postJson(
      'https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/External/jobs',
      { appliedFacets: {}, limit: 20, offset: 0, searchText: '' },
    );
    expect(res.statusCode).toBe(200);
  });

  it('still refuses a POST to a denied host and to a non-allowlisted host', async () => {
    const { guard } = mockedGuard();
    expect(await errorCode(guard.postJson('https://www.linkedin.com/x', {}))).toBe('host_denied');
    expect(await errorCode(guard.postJson('https://evil.example.com/x', {}))).toBe(
      'host_not_allowlisted',
    );
  });

  it('accepts an explicit GET', async () => {
    const { guard, mockAgent } = mockedGuard();
    mockAgent
      .get('https://boards-api.greenhouse.io')
      .intercept({ path: '/v1/boards/acme/jobs', method: 'GET' })
      .reply(200, JSON.stringify({ jobs: [] }), {
        headers: { 'content-type': 'application/json' },
      });
    const res = await guard.getJson('https://boards-api.greenhouse.io/v1/boards/acme/jobs', {
      method: 'GET',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ jobs: [] });
  });
});

describe('NetGuard — host rules', () => {
  it('denylist wins even when the host is explicitly allowlisted', async () => {
    const { guard } = mockedGuard({ allowedHosts: ['www.linkedin.com'] });
    expect(await errorCode(guard.get('https://www.linkedin.com/jobs'))).toBe('host_denied');
  });

  it('denies subdomains of denied hosts', async () => {
    const { guard } = mockedGuard();
    expect(await errorCode(guard.get('https://careers.indeed.com/x'))).toBe('host_denied');
    expect(await errorCode(guard.get('https://media.licdn.com/x'))).toBe('host_denied');
    expect(await errorCode(guard.get('https://www.glassdoor.com/x'))).toBe('host_denied');
  });

  it('does not deny lookalike hosts that merely end with the same letters', async () => {
    // notlinkedin.com is NOT a subdomain of linkedin.com — it must fall through
    // to the allowlist check instead of the denylist.
    const { guard } = mockedGuard();
    expect(await errorCode(guard.get('https://notlinkedin.com/x'))).toBe('host_not_allowlisted');
  });

  it('rejects hosts missing from the allowlist', async () => {
    const { guard } = mockedGuard();
    expect(await errorCode(guard.get('https://example.com/'))).toBe('host_not_allowlisted');
  });

  it('rejects plain http', async () => {
    const { guard } = mockedGuard();
    expect(await errorCode(guard.get('http://boards-api.greenhouse.io/x'))).toBe(
      'insecure_protocol',
    );
  });

  it('rejects garbage URLs', async () => {
    const { guard } = mockedGuard();
    expect(await errorCode(guard.get('not a url'))).toBe('invalid_url');
  });
});

describe('NetGuard — per-host pacing', () => {
  it('spaces consecutive requests to the same host by ~minIntervalMs', async () => {
    const { guard, mockAgent } = mockedGuard({ minIntervalMs: 60, jitterRatio: 0 });
    const pool = mockAgent.get('https://api.lever.co');
    pool.intercept({ path: '/v0/postings/a', method: 'GET' }).reply(200, '{}').times(3);
    const start = Date.now();
    await Promise.all([
      guard.get('https://api.lever.co/v0/postings/a'),
      guard.get('https://api.lever.co/v0/postings/a'),
      guard.get('https://api.lever.co/v0/postings/a'),
    ]);
    // 3 requests with 60ms spacing → at least ~120ms total.
    expect(Date.now() - start).toBeGreaterThanOrEqual(100);
  });
});
