# Discovery Audit Migration

ApplyPilot now writes discovery provenance into additive SQLite tables while keeping
`discovered_jobs` as the dashboard and automation read model.

New discovery runs create a local `trace_id`, record source queries, store raw job observations
before filtering or scoring, normalize each job into `normalized_jobs`, link observations through
`job_observation_links`, and write deterministic filter decisions plus scorecards. URL dedupe still
protects the existing read model, but duplicate provenance now also records confidence signals from
URL, ATS identifiers, company/title/location, and description similarity.

Compatibility notes:

- Existing `discovered_jobs` rows remain valid and are not migrated into the new tables until they
  are seen again in a discovery run.
- Manual tier assignments, generated/applied/skipped states, and the current dashboard job list are
  preserved.
- The new tables are local-only SQLite state. They do not introduce external network calls or send
  profile, ledger, or resume data to outside services.
- `/api/discovered-jobs/explain?id=<jobId>` exposes the local audit trail for a discovered job when
  provenance exists; older rows may return an empty explanation until re-discovered.
