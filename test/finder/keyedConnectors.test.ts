import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NetGuard } from '../../src/finder/net';
import { MockAgent } from '../../src/finder/net/testing';
import { ConnectorError, type SourceDescriptor } from '../../src/finder/shared';
import { adzunaConnector, connectorFor, requiredSecretsFor, usajobsConnector } from '../../src/finder/sources/index';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'connectors');

function ctx(
  host: string,
  reply: (pool: ReturnType<MockAgent['get']>) => void,
  secrets: Record<string, string> = {},
) {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  reply(mockAgent.get(host));
  const net = new NetGuard({ dispatcher: mockAgent, minIntervalMs: 0 });
  return { net, getSecret: (k: string) => secrets[k] ?? null };
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

describe('registry wiring', () => {
  it('registers both keyed connectors and their required secrets', () => {
    expect(connectorFor('api_usajobs')).toBe(usajobsConnector);
    expect(connectorFor('api_adzuna')).toBe(adzunaConnector);
    expect(requiredSecretsFor('api_usajobs')).toContain('keys.usajobs.api_key');
    expect(requiredSecretsFor('api_adzuna')).toContain('keys.adzuna.app_key');
    expect(requiredSecretsFor('ats_greenhouse')).toEqual([]);
  });
});

describe('usajobsConnector', () => {
  const source: SourceDescriptor = {
    id: 'usajobs',
    slug: 'usajobs',
    sourceName: 'USAJOBS',
    sourceType: 'api_usajobs',
    baseUrl: 'https://data.usajobs.gov/api/search',
    config: { keyword: 'analyst', results_per_page: 250 },
  };
  const okFull = readFileSync(join(FIXTURES, 'usajobs', 'ok_full.json'), 'utf8');
  const PATH = '/api/search?Keyword=analyst&ResultsPerPage=250';
  const secrets = {
    'keys.usajobs.api_key': 'k',
    'keys.usajobs.user_agent_email': 'me@example.com',
  };

  it('needs_key when credentials are absent — never touches the network', async () => {
    const c = ctx('https://data.usajobs.gov', () => {}, {});
    expect(await code(usajobsConnector.fetchJobs(source, c))).toBe('needs_key');
  });

  it('maps federal positions with credentials present', async () => {
    const c = ctx(
      'https://data.usajobs.gov',
      (pool) => pool.intercept({ path: PATH, method: 'GET' }).reply(200, okFull),
      secrets,
    );
    const jobs = await usajobsConnector.fetchJobs(source, c);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]!.title).toBe('Program Analyst');
    expect(jobs[0]!.company).toBe('Department of Transportation');
    expect(jobs[0]!.locationRaw).toBe('Washington, DC');
    expect(jobs[0]!.salaryMin).toBe(95000);
    expect(jobs[0]!.salaryPeriod).toBe('year');
    expect(jobs[0]!.remoteType).toBe('hybrid'); // telework eligible
    expect(jobs[1]!.remoteType).toBe('remote'); // RemoteIndicator true
  });

  it('401/403 → needs_key (bad key surfaces as a key problem)', async () => {
    const c = ctx(
      'https://data.usajobs.gov',
      (pool) => pool.intercept({ path: PATH, method: 'GET' }).reply(403, 'forbidden'),
      secrets,
    );
    expect(await code(usajobsConnector.fetchJobs(source, c))).toBe('needs_key');
  });
});

describe('adzunaConnector', () => {
  const source: SourceDescriptor = {
    id: 'adzuna:us',
    slug: 'adzuna:us',
    sourceName: 'Adzuna',
    sourceType: 'api_adzuna',
    baseUrl: 'https://api.adzuna.com/v1/api/jobs/us/search',
    config: { keyword: 'analyst', results_per_page: 50 },
  };
  const okFull = readFileSync(join(FIXTURES, 'adzuna', 'ok_full.json'), 'utf8');
  const secrets = { 'keys.adzuna.app_id': 'id', 'keys.adzuna.app_key': 'key' };

  it('needs_key when credentials are absent', async () => {
    const c = ctx('https://api.adzuna.com', () => {}, {});
    expect(await code(adzunaConnector.fetchJobs(source, c))).toBe('needs_key');
  });

  it('maps aggregator results (query string carries the keys)', async () => {
    const c = ctx(
      'https://api.adzuna.com',
      (pool) =>
        pool
          .intercept({
            path: (p) => p.startsWith('/v1/api/jobs/us/search/1') && p.includes('app_key=key'),
            method: 'GET',
          })
          .reply(200, okFull),
      secrets,
    );
    const jobs = await adzunaConnector.fetchJobs(source, c);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]!.title).toBe('KYC Analyst');
    expect(jobs[0]!.company).toBe('Meridian Bank');
    expect(jobs[0]!.salaryMin).toBe(82000);
    expect(jobs[1]!.remoteType).toBe('remote');
  });

  it('malformed JSON → schema_mismatch', async () => {
    const c = ctx(
      'https://api.adzuna.com',
      (pool) =>
        pool
          .intercept({ path: (p) => p.startsWith('/v1/api/jobs/us/search/1'), method: 'GET' })
          .reply(200, '<html>error</html>'),
      secrets,
    );
    expect(await code(adzunaConnector.fetchJobs(source, c))).toBe('schema_mismatch');
  });
});
