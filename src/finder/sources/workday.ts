import { z } from 'zod';
import { ConnectorError } from '../shared';
import type { RawJob, SourceDescriptor } from '../shared';
import type { Connector, ConnectorContext } from './connector';

/**
 * Workday "CXS" public jobs feed — no key. This is the SAME request a Workday careers page issues:
 *   POST https://{host}/wday/cxs/{tenant}/{site}/jobs
 *   body { appliedFacets: {}, limit, offset, searchText: "" }
 * It is a read-only SEARCH that happens to require a POST body (there is no GET equivalent), so it
 * goes through NetGuard.postJson — the one read-only POST path. Application submission never flows
 * through here; that is Playwright + the human review gate.
 *
 * The list endpoint returns metadata + a per-job path only (no full description) — which is exactly
 * what the single-user refocus wants (metadata + links, no scraped descriptions).
 */

const workdayJobSchema = z.object({
  title: z.string(),
  externalPath: z.string().nullish(),
  locationsText: z.string().nullish(),
  postedOn: z.string().nullish(),
  bulletFields: z.array(z.string()).nullish(),
});

const workdayResponseSchema = z.object({
  total: z.number().nullish(),
  jobPostings: z.array(workdayJobSchema).nullish(),
});

const PAGE_SIZE = 20;
/** Safety cap: never pull more than this many pages from one board in a single pass. */
const MAX_PAGES = 25;

export const workdayConnector: Connector = {
  sourceType: 'ats_workday',

  async fetchJobs(source: SourceDescriptor, ctx: ConnectorContext): Promise<RawJob[]> {
    const host = str(source.config.host);
    const tenant = str(source.config.tenant);
    const site = str(source.config.site);
    if (!host || !tenant || !site) {
      throw new ConnectorError(
        `Source ${source.slug} is missing Workday host/tenant/site.`,
        'schema_mismatch',
      );
    }
    const company = str(source.config.company) ?? source.sourceName;
    const endpoint = `https://${host}/wday/cxs/${tenant}/${site}/jobs`;

    const out: RawJob[] = [];
    let offset = 0;
    let total = Number.POSITIVE_INFINITY;

    for (let page = 0; page < MAX_PAGES && offset < total; page++) {
      if (ctx.signal?.aborted) break;

      let statusCode: number;
      let text: string;
      try {
        const res = await ctx.net.postJson(
          endpoint,
          { appliedFacets: {}, limit: PAGE_SIZE, offset, searchText: '' },
          { signal: ctx.signal },
        );
        statusCode = res.statusCode;
        text = res.text;
      } catch (err) {
        throw classifyTransportError(err);
      }

      if (statusCode === 429) {
        throw new ConnectorError(`Workday rate-limited ${source.slug}.`, 'rate_limited', 429);
      }
      if (statusCode !== 200) {
        throw new ConnectorError(
          `Workday returned HTTP ${statusCode} for '${tenant}/${site}'.`,
          'http_error',
          statusCode,
        );
      }

      let json: unknown;
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        throw new ConnectorError(`Workday '${tenant}/${site}' returned non-JSON.`, 'schema_mismatch', statusCode);
      }

      const parsed = workdayResponseSchema.safeParse(json);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw new ConnectorError(
          `schema_mismatch: ${first ? `${first.path.join('.')}: ${first.message}` : 'unknown'}`,
          'schema_mismatch',
          statusCode,
        );
      }

      const postings = parsed.data.jobPostings ?? [];
      if (typeof parsed.data.total === 'number') total = parsed.data.total;

      for (const p of postings) {
        if (!p.externalPath) continue;
        const url = `https://${host}/${site}${p.externalPath}`;
        out.push({
          externalJobId: reqIdFromPath(p.externalPath),
          company,
          title: p.title,
          locationRaw: p.locationsText ?? null,
          descriptionRaw: '', // CXS list carries no description; metadata + link only
          applyUrl: url,
          canonicalUrl: url,
          // Workday returns a relative human string ("Posted 3 Days Ago"), not a date — don't fabricate one.
          postedAt: null,
          salaryMin: null,
          salaryMax: null,
          salaryCurrency: null,
          salaryPeriod: 'unknown',
          remoteType: inferRemoteType(p.locationsText ?? ''),
          employmentType: 'unknown',
          extra: {},
        });
      }

      if (postings.length < PAGE_SIZE) break; // short page => last page
      offset += PAGE_SIZE;
    }

    return out;
  },
};

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

/** Workday req ids trail the external path as `..._R-12345`; fall back to the path itself. */
function reqIdFromPath(path: string): string {
  const m = path.match(/_([A-Za-z0-9-]+)\/?$/);
  return m?.[1] ?? path;
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
