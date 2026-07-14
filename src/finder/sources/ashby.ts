import { z } from 'zod';
import { ConnectorError } from '../shared';
import type { RawJob, SourceDescriptor } from '../shared';
import type { Connector, ConnectorContext } from './connector';

/**
 * Ashby public job-board API: no key.
 * GET https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true
 */

const ashbyJobSchema = z.object({
  id: z.union([z.string(), z.number()]).nullish(),
  title: z.string(),
  location: z.string().nullish(),
  isRemote: z.boolean().nullish(),
  applyUrl: z.string().nullish(),
  jobUrl: z.string().nullish(),
  descriptionHtml: z.string().nullish(),
  descriptionPlain: z.string().nullish(),
  publishedAt: z.string().nullish(),
});

const ashbyResponseSchema = z.object({ jobs: z.array(ashbyJobSchema) });

export const ashbyConnector: Connector = {
  sourceType: 'ats_ashby',

  async fetchJobs(source: SourceDescriptor, ctx: ConnectorContext): Promise<RawJob[]> {
    const slug = typeof source.config.slug === 'string' ? source.config.slug : null;
    if (!slug) {
      throw new ConnectorError(`Source ${source.slug} has no slug.`, 'schema_mismatch');
    }
    const company =
      typeof source.config.company === 'string' ? source.config.company : source.sourceName;
    const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`;

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
      throw new ConnectorError(`Ashby rate-limited ${source.slug}.`, 'rate_limited', 429);
    }
    if (statusCode !== 200) {
      throw new ConnectorError(
        `Ashby returned HTTP ${statusCode} for board '${slug}'.`,
        'http_error',
        statusCode,
      );
    }

    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      throw new ConnectorError(`Ashby board '${slug}' returned non-JSON.`, 'schema_mismatch', statusCode);
    }

    const parsed = ashbyResponseSchema.safeParse(json);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ConnectorError(
        `schema_mismatch: ${first ? `${first.path.join('.')}: ${first.message}` : 'unknown'}`,
        'schema_mismatch',
        statusCode,
      );
    }

    return parsed.data.jobs
      .map((job): RawJob => {
        const applyUrl = job.applyUrl ?? job.jobUrl ?? '';
        const location = job.location ?? '';
        return {
          externalJobId: job.id != null ? String(job.id) : null,
          company,
          title: job.title,
          locationRaw: location || null,
          descriptionRaw: job.descriptionHtml ?? job.descriptionPlain ?? '',
          applyUrl,
          canonicalUrl: applyUrl || null,
          postedAt: job.publishedAt ?? null,
          salaryMin: null,
          salaryMax: null,
          salaryCurrency: null,
          salaryPeriod: 'unknown',
          remoteType: job.isRemote ? 'remote' : inferRemoteType(location),
          employmentType: 'unknown',
          extra: {},
        };
      })
      .filter((j) => j.applyUrl.length > 0);
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
