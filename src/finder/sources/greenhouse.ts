import { z } from 'zod';
import { ConnectorError } from '../shared';
import type { RawJob, SourceDescriptor } from '../shared';
import type { Connector, ConnectorContext } from './connector';

/**
 * Greenhouse Job Board API (§8.1): public JSON, no key.
 * GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs?content=true
 */

const greenhouseJobSchema = z.object({
  id: z.number(),
  title: z.string(),
  absolute_url: z.string(),
  updated_at: z.string().nullish(),
  first_published: z.string().nullish(),
  location: z.object({ name: z.string().nullish() }).nullish(),
  content: z.string().nullish(),
});

const greenhouseResponseSchema = z.object({
  jobs: z.array(greenhouseJobSchema),
});

export const greenhouseConnector: Connector = {
  sourceType: 'ats_greenhouse',

  async fetchJobs(source: SourceDescriptor, ctx: ConnectorContext): Promise<RawJob[]> {
    const boardToken =
      typeof source.config.board_token === 'string' ? source.config.board_token : null;
    if (!boardToken) {
      throw new ConnectorError(`Source ${source.slug} has no board_token.`, 'schema_mismatch');
    }
    const company =
      typeof source.config.company === 'string' ? source.config.company : source.sourceName;
    const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(boardToken)}/jobs?content=true`;

    let statusCode: number;
    let text: string;
    try {
      const res = await ctx.net.get(url, { signal: ctx.signal });
      statusCode = res.statusCode;
      text = res.text;
    } catch (err) {
      throw classifyTransportError(err);
    }

    if (statusCode === 429) {
      throw new ConnectorError(`Greenhouse rate-limited ${source.slug}.`, 'rate_limited', 429);
    }
    if (statusCode !== 200) {
      throw new ConnectorError(
        `Greenhouse returned HTTP ${statusCode} for board '${boardToken}'.`,
        'http_error',
        statusCode,
      );
    }

    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      throw new ConnectorError(
        `Greenhouse board '${boardToken}' returned non-JSON (HTML error page?).`,
        'schema_mismatch',
        statusCode,
      );
    }

    const parsed = greenhouseResponseSchema.safeParse(json);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ConnectorError(
        `schema_mismatch: ${first ? `${first.path.join('.')}: ${first.message}` : 'unknown'}`,
        'schema_mismatch',
        statusCode,
      );
    }

    return parsed.data.jobs.map((job): RawJob => {
      return {
        externalJobId: String(job.id),
        company,
        title: job.title,
        locationRaw: job.location?.name ?? null,
        descriptionRaw: job.content ?? '',
        applyUrl: job.absolute_url,
        canonicalUrl: job.absolute_url,
        postedAt: job.first_published ?? job.updated_at ?? null,
        salaryMin: null,
        salaryMax: null,
        salaryCurrency: null,
        salaryPeriod: 'unknown',
        remoteType: inferRemoteType(job.location?.name ?? ''),
        employmentType: 'unknown',
        extra: {},
      };
    });
  },
};

function inferRemoteType(locationName: string): RawJob['remoteType'] {
  const lower = locationName.toLowerCase();
  if (lower.includes('remote')) return 'remote';
  if (lower.includes('hybrid')) return 'hybrid';
  return 'unknown';
}

function classifyTransportError(err: unknown): ConnectorError {
  const code = (err as { code?: string })?.code ?? '';
  const name = err instanceof Error ? err.name : '';
  if (
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    name === 'AbortError'
  ) {
    return new ConnectorError('Request timed out.', 'timeout');
  }
  const message = err instanceof Error ? err.message : String(err);
  return new ConnectorError(`Network error: ${message}`, 'network_error');
}
