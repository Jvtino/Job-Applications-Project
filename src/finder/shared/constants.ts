import type { MatchLabel, SearchDepth } from './types';

/** Single-user MVP: every user_id FK points at this seeded row. */
export const LOCAL_USER_ID = 'local-user';

/** §15 match bands. Scores are 0–100; bands are inclusive lower bounds. */
export const MATCH_LABEL_BANDS: ReadonlyArray<{ min: number; label: MatchLabel }> = [
  { min: 85, label: 'strong' },
  { min: 70, label: 'good' },
  { min: 55, label: 'possible' },
  { min: 40, label: 'weak' },
  { min: 0, label: 'bad' },
];

export function labelForScore(score: number): MatchLabel {
  for (const band of MATCH_LABEL_BANDS) {
    if (score >= band.min) return band.label;
  }
  return 'bad';
}

/** §15 default scorecard weights (sum = 1.0). Per-track overrides live in ../scoring. */
export const DEFAULT_SCORE_WEIGHTS = {
  title: 0.15,
  requiredSkills: 0.2,
  preferredSkills: 0.1,
  experience: 0.15,
  industry: 0.1,
  location: 0.1,
  salary: 0.05,
  educationCertification: 0.05,
  sourceQuality: 0.05,
  freshness: 0.05,
} as const;

/** Source circuit breaker (consecutive failures). One place, referenced everywhere. */
export const CIRCUIT_BREAKER = {
  /** consecutive failures → connector_status 'degraded'; retried next scan */
  degradeAfter: 3,
  /** consecutive failures → connector_status 'broken'; skipped until user re-enables or weekly health check passes */
  breakAfter: 8,
} as const;

/** Per-depth scan budgets. `maxSources: null` = all enabled sources. */
export const DEPTH_BUDGETS: Readonly<
  Record<SearchDepth, { maxSources: number | null; maxRuntimeMs: number }>
> = {
  fast: { maxSources: 50, maxRuntimeMs: 2 * 60_000 },
  balanced: { maxSources: 150, maxRuntimeMs: 10 * 60_000 },
  deep: { maxSources: 300, maxRuntimeMs: 30 * 60_000 },
  exhaustive: { maxSources: null, maxRuntimeMs: 60 * 60_000 },
};

/** §10 stopping condition: stop after N consecutive source batches with zero new jobs. */
export const EMPTY_BATCH_EARLY_EXIT = 5;

/** Scheduled scans start with a random offset in this range so installs never synchronize. */
export const SCHEDULE_JITTER_MAX_MS = 20 * 60_000;

/** app_settings keys (secrets under keys.* are safeStorage-encrypted, main process only). */
export const SETTINGS_KEYS = {
  scanIntervalHours: 'scan.interval_hours',
  scanDepth: 'scan.depth',
  scanNextRunAt: 'scan.next_run_at',
  scoringModelVersion: 'scoring.model_version',
  lowMatchHideThreshold: 'ui.low_match_hide_threshold',
  resultsPageSize: 'ui.results_page_size',
  notifyNewStrongMatches: 'notifications.new_strong_matches',
  privacyMode: 'privacy.mode',
  crashReports: 'privacy.crash_reports',
  logRetentionDays: 'logs.retention_days',
  seedBoardsVersion: 'seed.company_boards_version',
  usajobsApiKey: 'keys.usajobs.api_key',
  usajobsUserAgentEmail: 'keys.usajobs.user_agent_email',
  adzunaAppId: 'keys.adzuna.app_id',
  adzunaAppKey: 'keys.adzuna.app_key',
} as const;

export const DEFAULT_SETTINGS: Readonly<Record<string, string>> = {
  [SETTINGS_KEYS.scanIntervalHours]: '6',
  [SETTINGS_KEYS.scanDepth]: 'balanced',
  [SETTINGS_KEYS.scoringModelVersion]: 'scorecard-v2',
  [SETTINGS_KEYS.lowMatchHideThreshold]: '40',
  [SETTINGS_KEYS.resultsPageSize]: '50',
  [SETTINGS_KEYS.notifyNewStrongMatches]: 'true',
  [SETTINGS_KEYS.privacyMode]: 'local_only',
  [SETTINGS_KEYS.crashReports]: 'off',
  [SETTINGS_KEYS.logRetentionDays]: '90',
};

/** Prefix marking a safeStorage-encrypted settings value. */
export const ENCRYPTED_VALUE_PREFIX = 'enc:';
