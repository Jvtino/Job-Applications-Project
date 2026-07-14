/**
 * The complete network surface of the app. Adding a host here is a reviewed,
 * deliberate act (plan §10 standing rule). This file is allowlisted in
 * scripts/check-banned.mjs for the denied-host literals below.
 */

/** The only hosts the app may ever contact. Exact hostname match. */
export const ALLOWED_HOSTS = [
  'boards-api.greenhouse.io',
  'api.lever.co',
  'api.ashbyhq.com',
  'api.smartrecruiters.com',
  'apply.workable.com',
  'data.usajobs.gov',
  'api.adzuna.com',
] as const;

/**
 * Host SUFFIXES the app may contact when an exact hostname can't be pinned. Used only for Workday,
 * whose careers boards are served per-tenant from `{tenant}.wd{N}.myworkdayjobs.com` (the tenant +
 * datacenter vary per employer), so an exact allowlist can't work. Matches the apex domain and any
 * subdomain; still subject to the denylist-first check. Kept deliberately tiny.
 */
export const ALLOWED_HOST_SUFFIXES = ['myworkdayjobs.com', 'myworkdaysite.com'] as const;

/**
 * Hard-denied host suffixes, checked BEFORE the allowlist so they can never be
 * "accidentally allowlisted". Matches the host itself and any subdomain.
 * LinkedIn/Indeed interaction is link-out only (shell.openExternal), never fetched.
 */
export const DENIED_HOST_SUFFIXES = [
  'linkedin.com',
  'licdn.com',
  'indeed.com',
  'glassdoor.com',
] as const;
