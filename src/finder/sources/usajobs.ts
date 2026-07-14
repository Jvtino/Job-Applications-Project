import { z } from 'zod';
import { ConnectorError } from '../shared';
import type { EmploymentType, RawJob, RemoteType, SourceDescriptor } from '../shared';
import type { Connector, ConnectorContext } from './connector';

/**
 * USAJOBS Search API (§8.3): requires a free user-supplied Authorization-Key
 * plus the registered email in the User-Agent header. Keys are read from the
 * injected getSecret (safeStorage-backed, main process only).
 * GET https://data.usajobs.gov/api/search?Keyword=...&ResultsPerPage=...
 */

const positionSchema = z.object({
  MatchedObjectId: z.string(),
  MatchedObjectDescriptor: z.object({
    PositionID: z.string().nullish(),
    PositionTitle: z.string(),
    PositionURI: z.string().nullish(),
    ApplyURI: z.array(z.string()).nullish(),
    OrganizationName: z.string().nullish(),
    DepartmentName: z.string().nullish(),
    PositionLocationDisplay: z.string().nullish(),
    PositionRemuneration: z
      .array(
        z.object({
          MinimumRange: z.string().nullish(),
          MaximumRange: z.string().nullish(),
          RateIntervalCode: z.string().nullish(), // 'Per Year' | 'Per Hour' | ...
        }),
      )
      .nullish(),
    PositionStartDate: z.string().nullish(),
    PublicationStartDate: z.string().nullish(),
    UserArea: z
      .object({
        Details: z
          .object({
            JobSummary: z.string().nullish(),
            TeleworkEligible: z.boolean().nullish(),
            RemoteIndicator: z.boolean().nullish(),
          })
          .nullish(),
      })
      .nullish(),
    PositionSchedule: z.array(z.object({ Name: z.string().nullish() })).nullish(),
  }),
});

const responseSchema = z.object({
  SearchResult: z.object({
    SearchResultItems: z.array(positionSchema).nullish(),
  }),
});

export const REQUIRED_USAJOBS_SECRETS = ['keys.usajobs.api_key', 'keys.usajobs.user_agent_email'];

export const usajobsConnector: Connector = {
  sourceType: 'api_usajobs',

  async fetchJobs(source: SourceDescriptor, ctx: ConnectorContext): Promise<RawJob[]> {
    const apiKey = ctx.getSecret?.('keys.usajobs.api_key');
    const email = ctx.getSecret?.('keys.usajobs.user_agent_email');
    if (!apiKey || !email) {
      throw new ConnectorError('USAJOBS requires an API key and registered email.', 'needs_key');
    }

    const keyword =
      typeof source.config.keyword === 'string' && source.config.keyword.length > 0
        ? source.config.keyword
        : 'analyst';
    const perPage =
      typeof source.config.results_per_page === 'number' ? source.config.results_per_page : 250;
    const url = `https://data.usajobs.gov/api/search?Keyword=${encodeURIComponent(keyword)}&ResultsPerPage=${perPage}`;

    let statusCode: number;
    let text: string;
    try {
      const res = await ctx.net.get(url, {
        signal: ctx.signal,
        headers: {
          'Authorization-Key': apiKey,
          'User-Agent': email,
          Host: 'data.usajobs.gov',
        },
      });
      statusCode = res.statusCode;
      text = res.text;
    } catch (err) {
      throw classifyTransportError(err);
    }

    if (statusCode === 429) {
      throw new ConnectorError('USAJOBS rate-limited.', 'rate_limited', 429);
    }
    if (statusCode === 401 || statusCode === 403) {
      throw new ConnectorError('USAJOBS rejected the API key.', 'needs_key', statusCode);
    }
    if (statusCode !== 200) {
      throw new ConnectorError(`USAJOBS returned HTTP ${statusCode}.`, 'http_error', statusCode);
    }

    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      throw new ConnectorError('USAJOBS returned non-JSON.', 'schema_mismatch', statusCode);
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

    const items = parsed.data.SearchResult.SearchResultItems ?? [];
    return items.map((item): RawJob => {
      const d = item.MatchedObjectDescriptor;
      const pay = d.PositionRemuneration?.[0];
      const remote = d.UserArea?.Details?.RemoteIndicator
        ? 'remote'
        : d.UserArea?.Details?.TeleworkEligible
          ? 'hybrid'
          : 'unknown';
      return {
        externalJobId: d.PositionID ?? item.MatchedObjectId,
        company: d.OrganizationName ?? d.DepartmentName ?? 'U.S. Government',
        title: d.PositionTitle,
        locationRaw: d.PositionLocationDisplay ?? null,
        descriptionRaw: d.UserArea?.Details?.JobSummary ?? '',
        applyUrl: d.ApplyURI?.[0] ?? d.PositionURI ?? '',
        canonicalUrl: d.PositionURI ?? null,
        postedAt: d.PublicationStartDate ?? d.PositionStartDate ?? null,
        salaryMin: pay?.MinimumRange ? Math.round(Number(pay.MinimumRange)) : null,
        salaryMax: pay?.MaximumRange ? Math.round(Number(pay.MaximumRange)) : null,
        salaryCurrency: 'USD',
        salaryPeriod: payPeriod(pay?.RateIntervalCode),
        remoteType: remote as RemoteType,
        employmentType: scheduleType(d.PositionSchedule?.[0]?.Name),
        extra: { department: d.DepartmentName ?? null },
      };
    });
  },
};

function payPeriod(code: string | null | undefined): RawJob['salaryPeriod'] {
  const lower = (code ?? '').toLowerCase();
  if (lower.includes('year')) return 'year';
  if (lower.includes('hour')) return 'hour';
  if (lower.includes('month')) return 'month';
  return 'unknown';
}

function scheduleType(name: string | null | undefined): EmploymentType {
  const lower = (name ?? '').toLowerCase();
  if (lower.includes('full')) return 'full_time';
  if (lower.includes('part')) return 'part_time';
  if (lower.includes('intermittent') || lower.includes('temporary')) return 'temporary';
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
