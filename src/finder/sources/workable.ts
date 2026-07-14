import { z } from 'zod';
import { ConnectorError } from '../shared';
import type { EmploymentType, RawJob, SourceDescriptor } from '../shared';
import type { Connector, ConnectorContext } from './connector';

/**
 * Workable public careers-widget API: no key, GET.
 *   GET https://apply.workable.com/api/v1/widget/accounts/{account}?details=true
 * This is the same no-auth request a Workable careers page issues. The authenticated REST API
 * (spi/v3, bearer token) is intentionally NOT used — the single-user refocus stores no API keys.
 *
 * NOTE: response fields are validated defensively (mostly nullish) so board-to-board variation
 * degrades gracefully instead of throwing. Verify against a real board once before relying on it.
 */

const workableLocationSchema = z
  .object({
    country: z.string().nullish(),
    country_code: z.string().nullish(),
    region: z.string().nullish(),
    region_code: z.string().nullish(),
    city: z.string().nullish(),
    telecommuting: z.boolean().nullish(),
  })
  .nullish();

const workableJobSchema = z.object({
  title: z.string(),
  shortcode: z.string().nullish(),
  employment_type: z.string().nullish(),
  telecommuting: z.boolean().nullish(),
  department: z.string().nullish(),
  url: z.string().nullish(),
  application_url: z.string().nullish(),
  shortlink: z.string().nullish(),
  description: z.string().nullish(),
  full_description: z.string().nullish(),
  location: workableLocationSchema,
  created_at: z.string().nullish(),
  published_on: z.string().nullish(),
});

const workableResponseSchema = z.object({ jobs: z.array(workableJobSchema).nullish() });

export const workableConnector: Connector = {
  sourceType: 'ats_workable',

  async fetchJobs(source: SourceDescriptor, ctx: ConnectorContext): Promise<RawJob[]> {
    const account =
      typeof source.config.subdomain === 'string'
        ? source.config.subdomain
        : typeof source.config.slug === 'string'
          ? source.config.slug
          : null;
    if (!account) {
      throw new ConnectorError(`Source ${source.slug} has no Workable account slug.`, 'schema_mismatch');
    }
    const company =
      typeof source.config.company === 'string' ? source.config.company : source.sourceName;
    const url = `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(account)}?details=true`;

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
      throw new ConnectorError(`Workable rate-limited ${source.slug}.`, 'rate_limited', 429);
    }
    if (statusCode !== 200) {
      throw new ConnectorError(
        `Workable returned HTTP ${statusCode} for account '${account}'.`,
        'http_error',
        statusCode,
      );
    }

    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      throw new ConnectorError(`Workable account '${account}' returned non-JSON.`, 'schema_mismatch', statusCode);
    }

    const parsed = workableResponseSchema.safeParse(json);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ConnectorError(
        `schema_mismatch: ${first ? `${first.path.join('.')}: ${first.message}` : 'unknown'}`,
        'schema_mismatch',
        statusCode,
      );
    }

    return (parsed.data.jobs ?? [])
      .map((job): RawJob => {
        const applyUrl = job.url ?? job.application_url ?? job.shortlink ?? '';
        const location = joinLocation(job.location);
        const remote = Boolean(job.telecommuting || job.location?.telecommuting);
        return {
          externalJobId: job.shortcode ?? null,
          company,
          title: job.title,
          locationRaw: location,
          descriptionRaw: job.full_description ?? job.description ?? '',
          applyUrl,
          canonicalUrl: applyUrl || null,
          postedAt: job.published_on ?? job.created_at ?? null,
          salaryMin: null,
          salaryMax: null,
          salaryCurrency: null,
          salaryPeriod: 'unknown',
          remoteType: remote ? 'remote' : inferRemoteType(location ?? ''),
          employmentType: mapEmploymentType(job.employment_type),
          extra: job.department ? { department: job.department } : {},
        };
      })
      .filter((j) => j.applyUrl.length > 0);
  },
};

function joinLocation(loc: z.infer<typeof workableJobSchema>['location']): string | null {
  if (!loc) return null;
  const parts = [loc.city, loc.region, loc.country].filter(
    (p): p is string => typeof p === 'string' && p.trim().length > 0,
  );
  return parts.length ? parts.join(', ') : null;
}

function mapEmploymentType(raw: string | null | undefined): EmploymentType {
  switch ((raw ?? '').toLowerCase().replace(/[\s_-]+/g, '')) {
    case 'fulltime':
      return 'full_time';
    case 'parttime':
      return 'part_time';
    case 'contract':
    case 'contractor':
      return 'contract';
    case 'temporary':
    case 'temp':
      return 'temporary';
    case 'internship':
    case 'intern':
      return 'internship';
    default:
      return 'unknown';
  }
}

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
