/**
 * Recognition of LinkedIn/Indeed job-alert emails and canonicalization of the
 * job links inside them. This is the "reads only alert mail" guard: anything
 * that isn't a recognized alert sender (or a recognized alert domain with an
 * alert-shaped subject) resolves to `null` and is ignored downstream.
 *
 * All host literals here are string-parsing only — this module never fetches
 * LinkedIn or Indeed (assisted discovery only, per §8.6).
 */

export type Provider = 'linkedin' | 'indeed';

/** Known LinkedIn alert From-addresses (matched case-insensitively as substrings). */
const LINKEDIN_SENDERS: RegExp[] = [
  /jobalerts-noreply@linkedin\.com/i,
  /jobs-noreply@linkedin\.com/i,
  /jobs-listings@linkedin\.com/i,
];

/** Known Indeed alert From-addresses. */
const INDEED_SENDERS: RegExp[] = [
  /alert@indeed\.com/i,
  /donotreply@indeed\.com/i,
  /invitetoapply@indeed\.com/i,
  /noreply@indeed\.com/i,
];

/**
 * Secondary subject patterns for alert-shaped mail. Only consulted when the
 * From-address is on a recognized alert domain but not an exact known sender,
 * so a job-y subject from an unrelated domain can never register as an alert.
 */
const SUBJECT_ALERT_PATTERNS: RegExp[] = [
  /jobs? for/i,
  /new jobs?/i,
  /job alert/i,
  /jobs? you may be interested/i,
  /recommended jobs?/i,
];

const LINKEDIN_DOMAIN = /@([a-z0-9-]+\.)*linkedin\.com\b/i;
const INDEED_DOMAIN = /@([a-z0-9-]+\.)*indeed\.com\b/i;

/**
 * Decide whether these headers belong to a LinkedIn or Indeed job alert.
 * Primary signal is the From-address; a recognized alert domain plus an
 * alert-shaped subject is the secondary fallback. Returns `null` for anything
 * that is not a recognized alert (personal mail, marketing, etc.).
 */
export function detectProvider(headers: Map<string, string>): Provider | null {
  const from = (headers.get('from') ?? '').toLowerCase();
  const subject = headers.get('subject') ?? '';

  if (LINKEDIN_SENDERS.some((re) => re.test(from))) return 'linkedin';
  if (INDEED_SENDERS.some((re) => re.test(from))) return 'indeed';

  const subjectLooksLikeAlert = SUBJECT_ALERT_PATTERNS.some((re) => re.test(subject));
  if (subjectLooksLikeAlert) {
    if (LINKEDIN_DOMAIN.test(from)) return 'linkedin';
    if (INDEED_DOMAIN.test(from)) return 'indeed';
  }
  return null;
}

export interface CanonicalJobLink {
  id: string;
  canonicalUrl: string;
}

const LINKEDIN_JOB_RE = /https?:\/\/[a-z0-9.-]*linkedin\.com\/(?:comm\/)?jobs\/view\/(\d+)/i;

/**
 * Canonicalize a LinkedIn job link, stripping all tracking params:
 * `linkedin.com/(comm/)?jobs/view/<digits>` → `https://www.linkedin.com/jobs/view/<id>`.
 */
export function canonicalizeLinkedIn(url: string): CanonicalJobLink | null {
  const m = url.match(LINKEDIN_JOB_RE);
  const id = m?.[1];
  if (!id) return null;
  return { id, canonicalUrl: `https://www.linkedin.com/jobs/view/${id}` };
}

const INDEED_JK_RE = /[?&]jk=([A-Za-z0-9]+)/;

/**
 * Canonicalize an Indeed job link, stripping all tracking params. Handles
 * `viewjob?jk=<id>`, `rc/clk?jk=<id>`, and `pagead/clk?...jk=<id>` (jk may sit
 * anywhere in the query). → `https://www.indeed.com/viewjob?jk=<id>`.
 */
export function canonicalizeIndeed(url: string): CanonicalJobLink | null {
  if (!/indeed\.com/i.test(url)) return null;
  const m = url.match(INDEED_JK_RE);
  const id = m?.[1];
  if (!id) return null;
  return { id, canonicalUrl: `https://www.indeed.com/viewjob?jk=${id}` };
}

/** Canonicalize a link with the correct helper for the given provider. */
export function canonicalizeJobLink(provider: Provider, url: string): CanonicalJobLink | null {
  return provider === 'linkedin' ? canonicalizeLinkedIn(url) : canonicalizeIndeed(url);
}

/** Global regex that finds every candidate job URL for a provider in a blob of HTML/text. */
export function jobUrlPattern(provider: Provider): RegExp {
  return provider === 'linkedin'
    ? /https?:\/\/[^\s"'<>]*linkedin\.com\/(?:comm\/)?jobs\/view\/\d+[^\s"'<>]*/gi
    : /https?:\/\/[^\s"'<>]*indeed\.com\/[^\s"'<>]*[?&]jk=[A-Za-z0-9]+[^\s"'<>]*/gi;
}

/** Map a detected provider to the finder SourceType tag. */
export const providerToSourceType: Record<Provider, 'assisted_linkedin' | 'assisted_indeed'> = {
  linkedin: 'assisted_linkedin',
  indeed: 'assisted_indeed',
};
