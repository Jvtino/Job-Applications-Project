import { z } from 'zod';
import { ConnectorError } from '../shared';
import type { RawJob, SourceDescriptor } from '../shared';
import type { Connector, ConnectorContext } from './connector';

/**
 * SmartRecruiters public postings API: no key.
 * GET https://api.smartrecruiters.com/v1/companies/{companyId}/postings?limit=100
 * (List only — descriptions require a per-posting detail call, skipped here to
 * stay light; scoring reweights the missing description as non-informative.)
 */

const srPostingSchema = z.object({
  id: z.union([z.string(), z.number()]).nullish(),
  name: z.string(),
  ref: z.string().nullish(),
  releasedDate: z.string().nullish(),
  location: z
    .object({
      city: z.string().nullish(),
      region: z.string().nullish(),
      country: z.string().nullish(),
      remote: z.boolean().nullish(),
    })
    .nullish(),
  company: z.object({ name: z.string().nullish() }).nullish(),
});

const srResponseSchema = z.object({ content: z.array(srPostingSchema) });

export const smartRecruitersConnector: Connector = {
  sourceType: 'ats_smartrecruiters',

  async fetchJobs(source: SourceDescriptor, ctx: ConnectorContext): Promise<RawJob[]> {
    const companyId = typeof source.config.companyId === 'string' ? source.config.companyId : null;
    if (!companyId) {
      throw new ConnectorError(`Source ${source.slug} has no companyId.`, 'schema_mismatch');
    }
    const company =
      typeof source.config.company === 'string' ? source.config.company : source.sourceName;
    const url = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(companyId)}/postings?limit=100`;

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
      throw new ConnectorError(`SmartRecruiters rate-limited ${source.slug}.`, 'rate_limited', 429);
    }
    if (statusCode !== 200) {
      throw new ConnectorError(
        `SmartRecruiters returned HTTP ${statusCode} for '${companyId}'.`,
        'http_error',
        statusCode,
      );
    }

    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      throw new ConnectorError(
        `SmartRecruiters '${companyId}' returned non-JSON.`,
        'schema_mismatch',
        statusCode,
      );
    }

    const parsed = srResponseSchema.safeParse(json);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ConnectorError(
        `schema_mismatch: ${first ? `${first.path.join('.')}: ${first.message}` : 'unknown'}`,
        'schema_mismatch',
        statusCode,
      );
    }

    return parsed.data.content.map((p): RawJob => {
      const loc = [p.location?.city, p.location?.region, p.location?.country]
        .filter((s): s is string => !!s)
        .join(', ');
      const id = p.id != null ? String(p.id) : '';
      const applyUrl =
        p.ref && /^https?:/.test(p.ref)
          ? p.ref
          : `https://jobs.smartrecruiters.com/${companyId}/${id}`;
      return {
        externalJobId: id || null,
        company: p.company?.name ?? company,
        title: p.name,
        locationRaw: loc || null,
        descriptionRaw: '',
        applyUrl,
        canonicalUrl: applyUrl,
        postedAt: p.releasedDate ?? null,
        salaryMin: null,
        salaryMax: null,
        salaryCurrency: null,
        salaryPeriod: 'unknown',
        remoteType: p.location?.remote ? 'remote' : inferRemoteType(loc),
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
