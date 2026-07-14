export { atsKey, canonicalizeUrl, ctlKey, descriptionHash, urlHash } from './hashUtils';
export {
  CASCADE_ORDER,
  computeIdentity,
  decideForMatch,
  sourcePriority,
  type ComputedIdentity,
  type DedupeKey,
  type ExistingJobMeta,
  type MergeDecision,
  type SourceMeta,
} from './engine';
export { JobCollector, type CollectSource, type CollectedJob } from './collect';
