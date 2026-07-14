import { z } from 'zod';
import { ConnectorError } from '../shared';
import type { EmploymentType, RawJob, RemoteType, SourceDescriptor } from '../shared';
import type { Connector, ConnectorContext } from './connector';

/**
 * Lever Postings API (§8.2): public JSON, no key.
 * GET https://api.lever.co/v0/postings/{site}?mode=json
 */

const leverPostingSchema = z.object({
  id: z.string(),
  text: z.string(), // title
  categories: z
    .object({
      commitment: z.string().nullish(),
      department: z.string().nullish(),
      location: z.string().nullish(),
      team: z.string().nullish(),
      allLocations: z.array(z.string()).nullish(),
    })
    .nullish(),
  workplaceType: z.string().nullish(), // 'remote' | 'hybrid' | 'on-site' | 'unspecified'
  createdAt: z.number().nullish(), // epoch ms
  description: z.string().nullish(), // HTML
  descriptionPlain: z.string().nullish(),
  hostedUrl: z.string().nullish(),
  applyUrl: z.string().nullish(),
  salaryRange: z
    .object({
      min: z.number().nullish(),
      max: z.number().nullish(),
      currency: z.string().nullish(),
      interval: z.string().nullish(), // e.g. 'per-year-salary'
    })
    .nullish(),
});

const leverResponseSchema = z.array(leverPostingSchema);

export const leverConnector: Connector = {
  sourceType: 'ats_lever',

  async fetchJobs(source: SourceDescriptor, ctx: ConnectorContext): Promise<RawJob[]> {
    const site = typeof source.config.site === 'string' ? source.config.site : null;
    if (!site) {
      throw new ConnectorError(`Source ${source.slug} has no Lever site.`, 'schema_mismatch');
    }
    const company =
      typeof source.config.company === 'string' ? source.config.company : source.sourceName;
    const url = `https://api.lever.co/v0/postings/${encodeURIComponent(site)}?mode=json`;

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
      throw new ConnectorError(`Lever rate-limited ${source.slug}.`, 'rate_limited', 429);
    }
    if (statusCode !== 200) {
      throw new ConnectorError(
        `Lever returned HTTP ${statusCode} for site '${site}'.`,
        'http_error',
        statusCode,
      );
    }

    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      throw new ConnectorError(
        `Lever site '${site}' returned non-JSON (HTML error page?).`,
        'schema_mismatch',
        statusCode,
      );
    }

    const parsed = leverResponseSchema.safeParse(json);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ConnectorError(
        `schema_mismatch: ${first ? `${first.path.join('.')}: ${first.message}` : 'unknown'}`,
        'schema_mismatch',
        statusCode,
      );
    }

    return parsed.data.map((posting): RawJob => {
      const applyUrl = posting.applyUrl ?? posting.hostedUrl;
      const salary = posting.salaryRange;
      return {
        externalJobId: posting.id,
        company,
        title: posting.text,
        locationRaw: posting.categories?.location ?? posting.categories?.allLocations?.[0] ?? null,
        descriptionRaw: posting.description ?? posting.descriptionPlain ?? '',
        applyUrl: applyUrl ?? '',
        canonicalUrl: posting.hostedUrl ?? null,
        postedAt:
          typeof posting.createdAt === 'number' ? new Date(posting.createdAt).toISOString() : null,
        salaryMin: salary?.min ?? null,
        salaryMax: salary?.max ?? null,
        salaryCurrency: salary?.currency ?? null,
        salaryPeriod: salaryPeriodFromInterval(salary?.interval),
        remoteType: remoteTypeFromWorkplace(posting.workplaceType),
        employmentType: employmentFromCommitment(posting.categories?.commitment),
        extra: {
          team: posting.categories?.team ?? null,
          department: posting.categories?.department ?? null,
          commitment: posting.categories?.commitment ?? null,
        },
      };
    });
  },
};

function remoteTypeFromWorkplace(workplaceType: string | null | undefined): RemoteType {
  switch ((workplaceType ?? '').toLowerCase()) {
    case 'remote':
      return 'remote';
    case 'hybrid':
      return 'hybrid';
    case 'on-site':
    case 'onsite':
      return 'onsite';
    default:
      return 'unknown';
  }
}

function employmentFromCommitment(commitment: string | null | undefined): EmploymentType {
  const lower = (commitment ?? '').toLowerCase();
  if (lower.includes('full')) return 'full_time';
  if (lower.includes('part')) return 'part_time';
  if (lower.includes('contract')) return 'contract';
  if (lower.includes('intern')) return 'internship';
  if (lower.includes('temp')) return 'temporary';
  return 'unknown';
}

function salaryPeriodFromInterval(interval: string | null | undefined): RawJob['salaryPeriod'] {
  const lower = (interval ?? '').toLowerCase();
  if (lower.includes('year')) return 'year';
  if (lower.includes('month')) return 'month';
  if (lower.includes('hour')) return 'hour';
  if (lower.includes('week')) return 'week';
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
