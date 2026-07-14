/**
 * LinkedIn/Indeed assisted discovery — the ONLY permitted interaction with
 * these hosts (§8.6): build a search URL string; the user opens it in their
 * own browser via shell.openExternal. The app never fetches these hosts
 * (hard-denied in ../net), never scrapes, never automates.
 *
 * This file is allowlisted in scripts/check-banned.mjs for host literals.
 */

export interface AssistedSearchInput {
  keywords: string;
  location?: string;
}

export function buildLinkedInJobSearchUrl({ keywords, location }: AssistedSearchInput): string {
  const url = new URL('https://www.linkedin.com/jobs/search/');
  url.searchParams.set('keywords', keywords);
  if (location) url.searchParams.set('location', location);
  return url.toString();
}

export function buildIndeedJobSearchUrl({ keywords, location }: AssistedSearchInput): string {
  const url = new URL('https://www.indeed.com/jobs');
  url.searchParams.set('q', keywords);
  if (location) url.searchParams.set('l', location);
  return url.toString();
}
