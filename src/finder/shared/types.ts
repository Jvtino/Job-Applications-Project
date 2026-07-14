/**
 * Domain types shared across every package. The const arrays double as the
 * source of truth for SQLite CHECK constraints (@jd/database keeps its enums
 * in sync with these — the schema snapshot test guards drift).
 */

export const TRACKS = [
  'entry_level',
  'office_admin',
  'finance_compliance',
  'tech',
  'healthcare_admin',
  'government',
  'blue_collar_hourly',
  'sales',
  'customer_support',
  'general_professional',
] as const;
export type Track = (typeof TRACKS)[number];

export const SEARCH_DEPTHS = ['fast', 'balanced', 'deep', 'exhaustive'] as const;
export type SearchDepth = (typeof SEARCH_DEPTHS)[number];

export const SOURCE_TYPES = [
  'ats_greenhouse',
  'ats_lever',
  'ats_ashby',
  'ats_smartrecruiters',
  'ats_workable',
  'ats_workday',
  'api_usajobs',
  'api_adzuna',
  'api_jooble',
  'career_page',
  'assisted_linkedin',
  'assisted_indeed',
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const API_TYPES = ['json', 'html', 'link_out'] as const;
export type ApiType = (typeof API_TYPES)[number];

export const ACCESS_METHODS = ['api', 'public_page', 'assisted_link'] as const;
export type AccessMethod = (typeof ACCESS_METHODS)[number];

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const CONNECTOR_STATUSES = [
  'active',
  'needs_key',
  'degraded',
  'broken',
  'unsupported',
] as const;
export type ConnectorStatus = (typeof CONNECTOR_STATUSES)[number];

export const MATCH_LABELS = ['strong', 'good', 'possible', 'weak', 'bad'] as const;
export type MatchLabel = (typeof MATCH_LABELS)[number];

export const SCAN_STATUSES = [
  'queued',
  'running',
  'enriching',
  'scoring',
  'completed',
  'completed_with_warnings',
  'failed',
  'cancelled',
] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

export const SCAN_TRIGGERS = ['scheduled', 'manual'] as const;
export type ScanTrigger = (typeof SCAN_TRIGGERS)[number];

export const CRAWL_STATUSES = [
  'running',
  'success',
  'empty',
  'failed',
  'skipped',
  'rate_limited',
  'timeout',
] as const;
export type CrawlStatus = (typeof CRAWL_STATUSES)[number];

export const USER_ACTION_TYPES = [
  'viewed',
  'favorited',
  'hidden',
  'rejected',
  'opened_apply_link',
  'restored',
  'cleared_low_match',
  'marked_not_relevant',
  'marked_good_match',
] as const;
export type UserActionType = (typeof USER_ACTION_TYPES)[number];

export const REMOTE_TYPES = ['remote', 'hybrid', 'onsite', 'unknown'] as const;
export type RemoteType = (typeof REMOTE_TYPES)[number];

export const EMPLOYMENT_TYPES = [
  'full_time',
  'part_time',
  'contract',
  'temporary',
  'internship',
  'unknown',
] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const SALARY_PERIODS = ['year', 'month', 'week', 'day', 'hour', 'unknown'] as const;
export type SalaryPeriod = (typeof SALARY_PERIODS)[number];

export const JOB_STATUSES = ['active', 'expired', 'removed_by_source'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const USER_STATES = ['none', 'favorited', 'hidden', 'rejected'] as const;
export type UserState = (typeof USER_STATES)[number];

export const RESUME_SOURCE_TYPES = ['pdf', 'docx', 'txt', 'manual'] as const;
export type ResumeSourceType = (typeof RESUME_SOURCE_TYPES)[number];

export const PRIVACY_MODES = ['local_only', 'local_optin_telemetry'] as const;
export type PrivacyMode = (typeof PRIVACY_MODES)[number];

export const DEDUPE_KEY_TYPES = [
  'url_hash',
  'ats_key',
  'company_title_location',
  'description_hash',
] as const;
export type DedupeKeyType = (typeof DEDUPE_KEY_TYPES)[number];

/** A job as returned by a connector, before normalization. */
export interface RawJob {
  externalJobId: string | null;
  company: string;
  title: string;
  locationRaw: string | null;
  descriptionRaw: string;
  applyUrl: string;
  canonicalUrl: string | null;
  postedAt: string | null; // ISO-8601
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: SalaryPeriod;
  remoteType: RemoteType;
  employmentType: EmploymentType;
  /** Connector-specific extras preserved for enrichment (departments, teams, …). */
  extra: Record<string, unknown>;
}

/** A job after normalization, ready for dedupe + persistence. */
export interface NormalizedJob extends RawJob {
  locationNormalized: string;
  descriptionClean: string;
  requirements: string[];
  responsibilities: string[];
}

/** Row shape the dashboard list consumes (job + latest score projection). */
export interface JobListItem {
  id: string;
  company: string;
  title: string;
  locationNormalized: string;
  remoteType: RemoteType;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryPeriod: SalaryPeriod;
  sourceSlug: string;
  applyUrl: string;
  firstSeenAt: string;
  lastSeenAt: string;
  userState: UserState;
  overallScore: number | null;
  matchLabel: MatchLabel | null;
  /** First "why this matched" bullet from the latest score, for list rows. */
  topWhy: string | null;
}

/** Dashboard filter (all optional; empty = "All jobs"). */
export interface JobFilter {
  /** 'hidden' shows hidden+rejected; otherwise those are excluded. */
  view?: 'all' | 'strong' | 'possible' | 'hidden' | 'favorites';
  remoteType?: RemoteType;
  minSalary?: number;
  sourceType?: string;
  /** FTS query string (raw user input; sanitized before MATCH). */
  search?: string;
  limit?: number;
}

/** Full job-detail projection for the detail panel (job + refs + latest score). */
export interface JobDetail {
  id: string;
  company: string;
  title: string;
  locationNormalized: string;
  remoteType: RemoteType;
  employmentType: EmploymentType;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryPeriod: SalaryPeriod;
  descriptionClean: string;
  applyUrl: string;
  postedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  userState: UserState;
  sourceSlug: string;
  sources: Array<{ slug: string; url: string; isPrimary: boolean }>;
  score: {
    overall: number;
    label: MatchLabel;
    components: Record<string, number>;
    explanation: { why: string[]; concerns: string[] };
  } | null;
}

/** §10 scan metrics, persisted in scan_runs.stats_json. */
export interface ScanStats {
  sourcesSearched: number;
  jobsFound: number;
  newJobs: number;
  duplicatesRemoved: number;
  failedSources: number;
  strongMatches: number;
  possibleMatches: number;
  timeSpentMs: number;
  sourcesSkipped: number;
  skipReasons: Record<string, string>;
  /** Postings dropped before ingest because their location is confidently non-US (§2 US-only scope). */
  nonUsSkipped: number;
}

/** Parsed resume shape (§14 fields). Fleshed out fully in M4; this is the stable core. */
export interface ParsedResumeProfile {
  name: string | null;
  location: string | null;
  email: string | null;
  phone: string | null;
  summary: string | null;
  workHistory: Array<{
    title: string | null;
    company: string | null;
    startDate: string | null;
    endDate: string | null;
    description: string | null;
  }>;
  jobTitles: string[];
  companies: string[];
  skills: string[];
  tools: string[];
  certifications: string[];
  education: Array<{ degree: string | null; institution: string | null; year: string | null }>;
  industries: string[];
  yearsExperience: number | null;
  achievements: string[];
  languages: string[];
  workAuthorizationStatus: string | null;
}

export interface DbHealth {
  ok: boolean;
  schemaVersion: number;
  tables: number;
  jobs: number;
}

/** Parsed, renderer-facing view of the active search profile row. */
export interface SearchProfileView {
  track: Track;
  targetTitles: string[];
  excludedTitles: string[];
  preferredLocations: string[];
  remotePreferences: string[];
  salaryMin: number | null;
  employmentTypes: string[];
  industries: string[];
  dealbreakers: string[];
  searchDepth: SearchDepth;
  scanIntervalHours: number;
}

/** What 'searchProfile:suggest' returns for the onboarding screen (§13). */
export interface SearchProfileSuggestion {
  view: SearchProfileView;
  trackConfidence: number;
  trackCandidates: Array<{ track: Track; score: number }>;
  /** Skill/industry/stretch queries not already in targetTitles — "add these?" chips. */
  extraSuggestions: string[];
}

/** Connector-facing view of a job_sources row (keeps ../sources DB-free). */
export interface SourceDescriptor {
  id: string;
  slug: string;
  sourceName: string;
  sourceType: SourceType;
  baseUrl: string;
  config: Record<string, unknown>;
  etag?: string | null;
}

/** Pushed main → renderer while a scan runs (channel 'scan:progress'). */
export interface ScanProgressEvent {
  scanId: string;
  phase: 'source_start' | 'source_done' | 'scoring';
  sourceSlug: string;
  sourceIndex: number;
  sourceCount: number;
  status?: CrawlStatus;
  jobsFound?: number;
  jobsNew?: number;
  /** scoring phase only: jobs scored so far. */
  jobsScored?: number;
}

/** Final scan outcome (channel 'scan:done'), message per §10 honesty rules. */
export interface ScanSummary {
  scanId: string;
  status: ScanStatus;
  stats: ScanStats;
  message: string;
}
