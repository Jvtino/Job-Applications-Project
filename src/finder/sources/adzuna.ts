import { z } from 'zod';
import { ConnectorError } from '../shared';
import type { RawJob, RemoteType, SourceDescriptor } from '../shared';
import type { Connector, ConnectorContext } from './connector';

/**
 * Adzuna Jobs API (§8.4): US aggregator, requires a free user-supplied
 * app_id + app_key. Aggregator copies get a lower source_quality downstream so
 * dedupe prefers direct employer postings (§17).
 * GET https://api.adzuna.com/v1/api/jobs/us/search/{page}?app_id=..&app_key=..
 */

const resultSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullish(),
  redirect_url: z.string().nullish(),
  created: z.string().nullish(),
  salary_min: z.number().nullish(),
  salary_max: z.number().nullish(),
  contract_time: z.string().nullish(), // 'full_time' | 'part_time'
  company: z.object({ display_name: z.string().nullish() }).nullish(),
  location: z.object({ display_name: z.string().nullish() }).nullish(),
});

const responseSchema = z.object({ results: z.array(resultSchema) });

export const REQUIRED_ADZUNA_SECRETS = ['keys.adzuna.app_id', 'keys.adzuna.app_key'];

export const adzunaConnector: Connector = {
  sourceType: 'api_adzuna',

  async fetchJobs(source: SourceDescriptor, ctx: ConnectorContext): Promise<RawJob[]> {
    const appId = ctx.getSecret?.('keys.adzuna.app_id');
    const appKey = ctx.getSecret?.('keys.adzuna.app_key');
    if (!appId || !appKey) {
      throw new ConnectorError('Adzuna requires an app ID and app key.', 'needs_key');
    }

    const what =
      typeof source.config.keyword === 'string' && source.config.keyword.length > 0
        ? source.config.keyword
        : 'analyst';
    const perPage =
      typeof source.config.results_per_page === 'number' ? source.config.results_per_page : 50;
    const params = new URLSearchParams({
      app_id: appId,
      app_key: appKey,
      results_per_page: String(perPage),
      what,
      'content-type': 'application/json',
    });
    const url = `https://api.adzuna.com/v1/api/jobs/us/search/1?${params.toString()}`;

    let statusCode: number;
    let text: string;
    try {
      const res = await ctx.net.get(url, { signal: ctx.signal });
      statusCode = res.statusCode;
      text = res.text;
    } catch (err) {
      throw classifyTransportError(err);
    }

    if (statusCode === 429) throw new ConnectorError('Adzuna rate-limited.', 'rate_limited', 429);
    if (statusCode === 401 || statusCode === 403) {
      throw new ConnectorError('Adzuna rejected the credentials.', 'needs_key', statusCode);
    }
    if (statusCode !== 200) {
      throw new ConnectorError(`Adzuna returned HTTP ${statusCode}.`, 'http_error', statusCode);
    }

    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      throw new ConnectorError('Adzuna returned non-JSON.', 'schema_mismatch', statusCode);
    }
    const parsed = responseSchema.safeParse(json);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ConnectorError(
        `schema_mismatch: ${first ? `${first.path.join('.')}: ${first.message}` : 'unknown'}`,
        'schema_mismatch',
        statusCode,
      );
    }

    return parsed.data.results.map((r): RawJob => {
      const location = r.location?.display_name ?? null;
      return {
        externalJobId: r.id,
        company: r.company?.display_name ?? 'Unknown',
        title: r.title,
        locationRaw: location,
        descriptionRaw: r.description ?? '',
        applyUrl: r.redirect_url ?? '',
        canonicalUrl: r.redirect_url ?? null,
        postedAt: r.created ?? null,
        salaryMin: r.salary_min ? Math.round(r.salary_min) : null,
        salaryMax: r.salary_max ? Math.round(r.salary_max) : null,
        salaryCurrency: 'USD',
        salaryPeriod: 'year',
        remoteType: inferRemote(location, r.title),
        employmentType:
          r.contract_time === 'full_time'
            ? 'full_time'
            : r.contract_time === 'part_time'
              ? 'part_time'
              : 'unknown',
        extra: {},
      };
    });
  },
};

function inferRemote(location: string | null, title: string): RemoteType {
  const text = `${location ?? ''} ${title}`.toLowerCase();
  if (text.includes('remote')) return 'remote';
  if (text.includes('hybrid')) return 'hybrid';
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
