import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NetGuard } from '../../src/finder/net';
import { MockAgent } from '../../src/finder/net/testing';
import { ConnectorError, type SourceDescriptor } from '../../src/finder/shared';
import { connectorFor, leverConnector } from '../../src/finder/sources/index';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'connectors');
const okFull = readFileSync(join(FIXTURES, 'lever', 'ok_full.json'), 'utf8');

const source: SourceDescriptor = {
  id: 'src-acmepay',
  slug: 'lever:acmepay',
  sourceName: 'AcmePay (Lever)',
  sourceType: 'ats_lever',
  baseUrl: 'https://api.lever.co/v0/postings/acmepay',
  config: { site: 'acmepay', company: 'AcmePay' },
};

const SITE_PATH = '/v0/postings/acmepay?mode=json';

function ctx(reply: (pool: ReturnType<MockAgent['get']>) => void) {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  reply(mockAgent.get('https://api.lever.co'));
  return { net: new NetGuard({ dispatcher: mockAgent, minIntervalMs: 0 }) };
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'no_error';
  } catch (err) {
    if (err instanceof ConnectorError) return err.code;
    throw err;
  }
}

describe('leverConnector — success', () => {
  it('is registered for ats_lever', () => {
    expect(connectorFor('ats_lever')).toBe(leverConnector);
  });

  it('maps the full fixture to RawJobs (§8.2 fields)', async () => {
    const jobs = await leverConnector.fetchJobs(
      source,
      ctx((pool) => pool.intercept({ path: SITE_PATH, method: 'GET' }).reply(200, okFull)),
    );
    expect(jobs).toHaveLength(3);

    const aml = jobs[0]!;
    expect(aml.externalJobId).toBe('a1b2c3d4-1111-4abc-9def-000000000001');
    expect(aml.company).toBe('AcmePay');
    expect(aml.title).toBe('AML Compliance Analyst');
    expect(aml.locationRaw).toBe('New York, NY');
    expect(aml.remoteType).toBe('hybrid');
    expect(aml.employmentType).toBe('full_time');
    expect(aml.salaryMin).toBe(85000);
    expect(aml.salaryMax).toBe(110000);
    expect(aml.salaryPeriod).toBe('year');
    expect(aml.applyUrl).toContain('/apply');
    expect(aml.canonicalUrl).toBe(
      'https://jobs.lever.co/acmepay/a1b2c3d4-1111-4abc-9def-000000000001',
    );
    expect(aml.postedAt).toMatch(/^2026-/);

    expect(jobs[1]!.employmentType).toBe('part_time');
    expect(jobs[1]!.remoteType).toBe('onsite');
    expect(jobs[2]!.remoteType).toBe('remote');
  });

  it('returns [] for an empty site', async () => {
    const jobs = await leverConnector.fetchJobs(
      source,
      ctx((pool) => pool.intercept({ path: SITE_PATH, method: 'GET' }).reply(200, '[]')),
    );
    expect(jobs).toEqual([]);
  });
});

describe('leverConnector — failure modes (§24 connector matrix)', () => {
  it('HTML 200 error page → schema_mismatch', async () => {
    expect(
      await code(
        leverConnector.fetchJobs(
          source,
          ctx((pool) =>
            pool.intercept({ path: SITE_PATH, method: 'GET' }).reply(200, '<html>oops</html>'),
          ),
        ),
      ),
    ).toBe('schema_mismatch');
  });

  it('schema drift (object instead of array) → schema_mismatch', async () => {
    expect(
      await code(
        leverConnector.fetchJobs(
          source,
          ctx((pool) =>
            pool.intercept({ path: SITE_PATH, method: 'GET' }).reply(200, '{"postings":[]}'),
          ),
        ),
      ),
    ).toBe('schema_mismatch');
  });

  it('404 → http_error; 429 → rate_limited; 500 → http_error', async () => {
    for (const [status, expected] of [
      [404, 'http_error'],
      [429, 'rate_limited'],
      [500, 'http_error'],
    ] as const) {
      expect(
        await code(
          leverConnector.fetchJobs(
            source,
            ctx((pool) => pool.intercept({ path: SITE_PATH, method: 'GET' }).reply(status, 'x')),
          ),
        ),
      ).toBe(expected);
    }
  });

  it('timeout → timeout', async () => {
    expect(
      await code(
        leverConnector.fetchJobs(
          source,
          ctx((pool) =>
            pool.intercept({ path: SITE_PATH, method: 'GET' }).replyWithError(
              Object.assign(new Error('Headers Timeout Error'), {
                code: 'UND_ERR_HEADERS_TIMEOUT',
              }),
            ),
          ),
        ),
      ),
    ).toBe('timeout');
  });

  it('missing site config → schema_mismatch', async () => {
    expect(
      await code(
        leverConnector.fetchJobs(
          { ...source, config: {} },
          ctx(() => {}),
        ),
      ),
    ).toBe('schema_mismatch');
  });
});
