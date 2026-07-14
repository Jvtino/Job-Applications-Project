import { normalizeCompany, normalizeTitle } from '../normalization';
import type { DedupeKeyType, NormalizedJob } from '../shared';
import { atsKey, ctlKey, descriptionHash, urlHash } from './hashUtils';

/** What the engine needs to know about a job's origin. */
export interface SourceMeta {
  sourceId: string;
  sourceType: string;
}

export interface DedupeKey {
  keyType: DedupeKeyType;
  keyValue: string;
}

export interface ComputedIdentity {
  keys: DedupeKey[];
  canonicalCompany: string;
  canonicalTitle: string;
  canonicalLocation: string;
}

/** A candidate the incoming job might duplicate (owner of a matched key). */
export interface ExistingJobMeta {
  jobId: string;
  sourceId: string;
  sourceType: string;
  externalJobId: string | null;
  canonicalCompany: string;
}

export type MergeDecision =
  /** Same posting re-seen from the same source: bump last_seen, refresh ref. */
  | { action: 'refresh'; jobId: string }
  /** Cross-source duplicate: keep one row, add a secondary ref, maybe promote primary. */
  | { action: 'merge'; jobId: string }
  /** A distinct job — insert it. */
  | { action: 'insert' };

/**
 * §17 cascade, exactly as locked in the plan:
 *   1. ats_key — identity on its own board (refresh, not merge)
 *   2. url_hash — same canonical apply URL (identity across listings)
 *   3. description_hash — merge ONLY with the same canonical company
 *      (guards against cross-company boilerplate descriptions)
 *   4. company+title+location — CANDIDATE ONLY, with the veto rule:
 *      two jobs from the same source with different external ids are NEVER
 *      merged (same company/title/location but different requisitions is the
 *      most common false-merge trap). Cross-source hits additionally require
 *      a different source_type OR a matching description hash.
 *
 * A false merge hides a real opening from the user; a missed merge shows a
 * duplicate card. When in doubt: insert.
 */
export function computeIdentity(job: NormalizedJob, source: SourceMeta): ComputedIdentity {
  const canonicalCompany = normalizeCompany(job.company);
  const canonicalTitle = normalizeTitle(job.title);
  const canonicalLocation = job.locationNormalized;

  const keys: DedupeKey[] = [];
  if (job.externalJobId) {
    keys.push({
      keyType: 'ats_key',
      keyValue: atsKey(source.sourceType, source.sourceId, job.externalJobId),
    });
  }
  if (job.applyUrl) {
    keys.push({ keyType: 'url_hash', keyValue: urlHash(job.applyUrl) });
  }
  const descHash = descriptionHash(job.descriptionClean);
  if (descHash) {
    keys.push({ keyType: 'description_hash', keyValue: descHash });
  }
  const ctl = ctlKey(canonicalCompany, canonicalTitle, canonicalLocation);
  if (ctl) {
    keys.push({ keyType: 'company_title_location', keyValue: ctl });
  }
  return { keys, canonicalCompany, canonicalTitle, canonicalLocation };
}

export function decideForMatch(
  matchedKeyType: DedupeKeyType,
  incoming: { source: SourceMeta; externalJobId: string | null; canonicalCompany: string },
  existing: ExistingJobMeta,
  incomingHasDescriptionMatch: boolean,
): MergeDecision {
  const sameSource = existing.sourceId === incoming.source.sourceId;
  const differentRequisition =
    sameSource &&
    incoming.externalJobId !== null &&
    existing.externalJobId !== null &&
    incoming.externalJobId !== existing.externalJobId;

  switch (matchedKeyType) {
    case 'ats_key':
      // Board identity: it IS the same posting.
      return { action: 'refresh', jobId: existing.jobId };

    case 'url_hash':
      // Same apply URL is identity — but same source + different requisition
      // ids sharing one URL means a generic apply link, not a duplicate.
      if (differentRequisition) return { action: 'insert' };
      return sameSource
        ? { action: 'refresh', jobId: existing.jobId }
        : { action: 'merge', jobId: existing.jobId };

    case 'description_hash':
      // Identical content from a different company: boilerplate, not a dup.
      if (existing.canonicalCompany !== incoming.canonicalCompany) return { action: 'insert' };
      // VETO: same board, different requisitions — two real openings that
      // share a description (e.g. two seats). Never merge.
      if (differentRequisition) return { action: 'insert' };
      return sameSource
        ? { action: 'refresh', jobId: existing.jobId }
        : { action: 'merge', jobId: existing.jobId };

    case 'company_title_location':
      // Candidate signal only.
      if (differentRequisition) return { action: 'insert' }; // the veto rule
      if (sameSource) return { action: 'refresh', jobId: existing.jobId };
      // Cross-source: merges only when the two sightings sit in DIFFERENT
      // priority classes (aggregator copy of a direct posting) — two direct
      // ATS listings (e.g. Greenhouse vs Lever) can be two real openings and
      // need description proof.
      if (
        sourcePriority(existing.sourceType) !== sourcePriority(incoming.source.sourceType) ||
        incomingHasDescriptionMatch
      ) {
        return { action: 'merge', jobId: existing.jobId };
      }
      return { action: 'insert' };
  }
}

/** §7 source priority: direct employer/official APIs beat aggregators and email leads. */
export function sourcePriority(sourceType: string): number {
  switch (sourceType) {
    case 'ats_greenhouse':
    case 'ats_lever':
    case 'ats_ashby':
    case 'ats_smartrecruiters':
      return 1; // direct employer ATS
    case 'api_usajobs':
      return 1; // official government API
    case 'career_page':
      return 2;
    case 'assisted_linkedin':
    case 'assisted_indeed':
      return 3; // job-alert email leads: they link out to the employer's own posting
    case 'api_adzuna':
    case 'api_jooble':
      return 3; // aggregators
    default:
      return 4;
  }
}

/** Cascade order for resolving multiple key hits. */
export const CASCADE_ORDER: DedupeKeyType[] = [
  'ats_key',
  'url_hash',
  'description_hash',
  'company_title_location',
];
