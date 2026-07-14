// src/finder/pipeline/discovery-run-types.ts
//
// The DiscoveryRun / CompanyDiscovery result shapes the API (handleDiscover)
// and the apply orchestrator (automation-cycle) read. Declared here (neutral,
// finder-owned) so they survive the removal of the old discovery engine; the
// structural shape matches the legacy src/discovery/discover.ts declarations,
// so existing consumers keep type-checking during the transition.

import type { ScoredPosting } from "../../jobs/types";

export interface CompanyDiscovery {
  company: string;
  /** Raw postings the source returned, before filtering/scoring. */
  found: number;
  added: number;
  errors: string[];
  roleFocused?: number;
  scored?: number;
  knockoutFree?: number;
  /** True when fetched via a no-auth API (always true for the finder). */
  viaApi?: boolean;
  skippedByPolicy?: boolean;
}

export interface DiscoveryRun {
  traceId: string;
  perCompany: CompanyDiscovery[];
  scored: ScoredPosting[];
  newlyAdded: ScoredPosting[];
  rescoredExisting: ScoredPosting[];
  scoredVisible: ScoredPosting[];
  targetsAdded: string[];
  targetsResolvedOpen: number;
}
