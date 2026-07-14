import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NetGuard } from '../../src/finder/net';
import { MockAgent } from '../../src/finder/net/testing';
import { ConnectorError, type SourceDescriptor } from '../../src/finder/shared';
import { greenhouseConnector } from '../../src/finder/sources/index';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'connectors');
const okFull = readFileSync(join(FIXTURES, 'greenhouse', 'ok_full.json'), 'utf8');

const source: SourceDescriptor = {
  id: 'src-acme',
  slug: 'greenhouse:acme',
  sourceName: 'Acme (Greenhouse)',
  sourceType: 'ats_greenhouse',
  baseUrl: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs',
  config: { board_token: 'acme', company: 'Acme Corp' },
};

const BOARD_PATH = '/v1/boards/acme/jobs?content=true';

function ctx(
  reply: (pool: ReturnType<MockAgent['get']>) => void,
  opts: { headersTimeoutMs?: number } = {},
) {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  reply(mockAgent.get('https://boards-api.greenhouse.io'));
  const net = new NetGuard({ dispatcher: mockAgent, minIntervalMs: 0, ...opts });
  return { net };
}

async function connectorErrorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'no_error';
  } catch (err) {
    if (err instanceof ConnectorError) return err.code;
    throw err;
  }
}

describe('greenhouseConnector — success', () => {
  it('maps the full fixture to RawJobs', async () => {
    const jobs = await greenhouseConnector.fetchJobs(
      source,
      ctx((pool) =>
        pool.intercept({ path: BOARD_PATH, method: 'GET' }).reply(200, okFull, {
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    expect(jobs).toHaveLength(3);
    const kyc = jobs[0]!;
    expect(kyc.externalJobId).toBe('4011001');
    expect(kyc.company).toBe('Acme Corp');
    expect(kyc.title).toBe('KYC Analyst');
    expect(kyc.locationRaw).toBe('New York, NY');
    expect(kyc.applyUrl).toBe('https://boards.greenhouse.io/acme/jobs/4011001');
    expect(kyc.postedAt).toBe('2026-06-20T09:00:00-04:00');
    expect(kyc.descriptionRaw).toContain('AML');

    expect(jobs[1]!.remoteType).toBe('remote');
    expect(jobs[2]!.remoteType).toBe('hybrid');
  });

  it('returns [] for an empty board', async () => {
    const jobs = await greenhouseConnector.fetchJobs(
      source,
      ctx((pool) => pool.intercept({ path: BOARD_PATH, method: 'GET' }).reply(200, '{"jobs":[]}')),
    );
    expect(jobs).toEqual([]);
  });
});

describe('greenhouseConnector — failure modes (§24 connector matrix)', () => {
  it('malformed: HTML 200 error page → schema_mismatch', async () => {
    const code = await connectorErrorCode(
      greenhouseConnector.fetchJobs(
        source,
        ctx((pool) =>
          pool
            .intercept({ path: BOARD_PATH, method: 'GET' })
            .reply(200, '<html><body>Something went wrong</body></html>'),
        ),
      ),
    );
    expect(code).toBe('schema_mismatch');
  });

  it('schema drift: renamed field → schema_mismatch', async () => {
    const drifted = JSON.stringify({
      postings: JSON.parse(okFull).jobs, // 'jobs' renamed
    });
    const code = await connectorErrorCode(
      greenhouseConnector.fetchJobs(
        source,
        ctx((pool) => pool.intercept({ path: BOARD_PATH, method: 'GET' }).reply(200, drifted)),
      ),
    );
    expect(code).toBe('schema_mismatch');
  });

  it('404 (board gone) → http_error with status', async () => {
    try {
      await greenhouseConnector.fetchJobs(
        source,
        ctx((pool) => pool.intercept({ path: BOARD_PATH, method: 'GET' }).reply(404, 'not found')),
      );
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectorError);
      expect((err as ConnectorError).code).toBe('http_error');
      expect((err as ConnectorError).httpStatus).toBe(404);
    }
  });

  it('429 → rate_limited', async () => {
    const code = await connectorErrorCode(
      greenhouseConnector.fetchJobs(
        source,
        ctx((pool) => pool.intercept({ path: BOARD_PATH, method: 'GET' }).reply(429, 'slow down')),
      ),
    );
    expect(code).toBe('rate_limited');
  });

  it('500 → http_error', async () => {
    const code = await connectorErrorCode(
      greenhouseConnector.fetchJobs(
        source,
        ctx((pool) => pool.intercept({ path: BOARD_PATH, method: 'GET' }).reply(500, 'boom')),
      ),
    );
    expect(code).toBe('http_error');
  });

  it('network failure → network_error', async () => {
    const code = await connectorErrorCode(
      greenhouseConnector.fetchJobs(
        source,
        ctx((pool) =>
          pool
            .intercept({ path: BOARD_PATH, method: 'GET' })
            .replyWithError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })),
        ),
      ),
    );
    expect(code).toBe('network_error');
  });

  it('timeout → timeout', async () => {
    // MockAgent does not enforce client timeouts, so emit the exact error the
    // undici core raises when headersTimeout fires.
    const code = await connectorErrorCode(
      greenhouseConnector.fetchJobs(
        source,
        ctx((pool) =>
          pool.intercept({ path: BOARD_PATH, method: 'GET' }).replyWithError(
            Object.assign(new Error('Headers Timeout Error'), {
              code: 'UND_ERR_HEADERS_TIMEOUT',
            }),
          ),
        ),
      ),
    );
    expect(code).toBe('timeout');
  });

  it('missing board_token config → schema_mismatch', async () => {
    const code = await connectorErrorCode(
      greenhouseConnector.fetchJobs(
        { ...source, config: {} },
        ctx(() => {}),
      ),
    );
    expect(code).toBe('schema_mismatch');
  });
});
