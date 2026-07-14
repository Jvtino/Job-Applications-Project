// src/finder/dedupe/collect.ts
//
// In-run cross-source de-duplication for ONE discovery pass. Wraps the identity + decision cascade
// (engine.ts) so the same posting seen through two sources — e.g. an employer ATS feed and a
// LinkedIn/Indeed job-alert email — collapses into a single record. It replaces the previous
// canonical-URL-only in-run dedupe, which could not collapse two sources that point at the same
// role under different apply URLs (an ATS board URL vs a linkedin.com/indeed.com link).
//
// Semantics: the first distinct job wins its slot; a later duplicate merges into it. When the later
// sighting comes from a HIGHER-priority source (lower sourcePriority number — a direct ATS beats an
// email lead) its representation replaces the stored one, so the kept record carries the best apply
// URL + description. Cross-run persistence is still handled by DiscoveredJobsRepo's URL dedup key.

import type { NormalizedJob } from '../shared';
import {
  CASCADE_ORDER,
  computeIdentity,
  decideForMatch,
  sourcePriority,
  type ComputedIdentity,
  type SourceMeta,
} from './engine';

export interface CollectSource {
  /** Finder SourceType, e.g. "ats_greenhouse" | "assisted_linkedin". */
  sourceType: string;
  /** Stable per-source id (board slug / source slug) — the board identity for ats_key dedup. */
  sourceId: string;
  /** Display name, carried through for run reporting. */
  sourceName: string;
}

export interface CollectedJob {
  job: NormalizedJob;
  sourceType: string;
  sourceName: string;
}

interface Entry {
  job: NormalizedJob;
  source: CollectSource;
  identity: ComputedIdentity;
}

function descriptionHashOf(identity: ComputedIdentity): string | null {
  return identity.keys.find((k) => k.keyType === 'description_hash')?.keyValue ?? null;
}

/**
 * Accumulates normalized jobs across sources within a single discovery pass, collapsing duplicates
 * via the §17 cascade. Use `add()` per job as sources are fetched, then `values()` for the deduped
 * set to score + persist.
 */
export class JobCollector {
  private entries: Entry[] = [];
  /** "keyType:keyValue" -> entry index. First writer of a key wins it. */
  private index = new Map<string, number>();

  add(job: NormalizedJob, source: CollectSource): void {
    const meta: SourceMeta = { sourceId: source.sourceId, sourceType: source.sourceType };
    const identity = computeIdentity(job, meta);

    // Walk keys strongest-first; the first key that already belongs to an existing job decides.
    for (const keyType of CASCADE_ORDER) {
      const key = identity.keys.find((k) => k.keyType === keyType);
      if (!key) continue;
      const idx = this.index.get(`${key.keyType}:${key.keyValue}`);
      if (idx === undefined) continue;

      const existing = this.entries[idx]!;
      const existingDesc = descriptionHashOf(existing.identity);
      const incomingDesc = descriptionHashOf(identity);
      const hasDescriptionMatch =
        incomingDesc !== null && existingDesc !== null && incomingDesc === existingDesc;

      const decision = decideForMatch(
        keyType,
        {
          source: meta,
          externalJobId: job.externalJobId,
          canonicalCompany: identity.canonicalCompany,
        },
        {
          jobId: String(idx),
          sourceId: existing.source.sourceId,
          sourceType: existing.source.sourceType,
          externalJobId: existing.job.externalJobId,
          canonicalCompany: existing.identity.canonicalCompany,
        },
        hasDescriptionMatch,
      );

      // A stronger key that resolves to "insert" is a veto (distinct openings that share a weaker
      // signal) — stop and treat the incoming job as new rather than merging on a weaker key.
      if (decision.action === 'insert') break;

      // refresh | merge -> collapse into the existing slot. Keep the higher-priority representation.
      if (sourcePriority(source.sourceType) < sourcePriority(existing.source.sourceType)) {
        this.entries[idx] = { job, source, identity };
        this.registerKeys(identity, idx);
      }
      return;
    }

    // No matching key (or a veto): a new distinct job.
    const idx = this.entries.push({ job, source, identity }) - 1;
    this.registerKeys(identity, idx);
  }

  private registerKeys(identity: ComputedIdentity, idx: number): void {
    for (const k of identity.keys) {
      const id = `${k.keyType}:${k.keyValue}`;
      if (!this.index.has(id)) this.index.set(id, idx);
    }
  }

  /** The deduped set, in first-seen order. */
  values(): CollectedJob[] {
    return this.entries.map((e) => ({
      job: e.job,
      sourceType: e.source.sourceType,
      sourceName: e.source.sourceName,
    }));
  }

  get size(): number {
    return this.entries.length;
  }
}
