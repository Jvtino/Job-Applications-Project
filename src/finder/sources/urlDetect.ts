import type { SourceType } from '../shared';

export interface DetectedSource {
  sourceType: Extract<SourceType, 'ats_greenhouse' | 'ats_lever'>;
  slug: string;
  sourceName: string;
  baseUrl: string;
  config: Record<string, unknown>;
}

/**
 * "Add a company" via pasted URL — pure string parsing, NO page fetching
 * (plan decision: HTML sniffing/ATS auto-detection is v1.5; MVP accepts only
 * recognizable board URLs).
 *
 * Recognized:
 *   https://boards.greenhouse.io/<token>[/...]
 *   https://job-boards.greenhouse.io/<token>[/...]
 *   https://jobs.lever.co/<site>[/...]
 */
export function parseCareersUrl(rawUrl: string): DetectedSource | null {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);
  const first = segments[0];
  if (!first) return null;

  if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io') {
    const token = first.toLowerCase();
    if (!/^[a-z0-9][a-z0-9-_]*$/.test(token)) return null;
    return {
      sourceType: 'ats_greenhouse',
      slug: `greenhouse:${token}`,
      sourceName: `${displayName(token)} (Greenhouse)`,
      baseUrl: `https://boards-api.greenhouse.io/v1/boards/${token}/jobs`,
      config: { board_token: token, company: displayName(token) },
    };
  }

  if (host === 'jobs.lever.co') {
    const site = first.toLowerCase();
    if (!/^[a-z0-9][a-z0-9-_.]*$/.test(site)) return null;
    return {
      sourceType: 'ats_lever',
      slug: `lever:${site}`,
      sourceName: `${displayName(site)} (Lever)`,
      baseUrl: `https://api.lever.co/v0/postings/${site}`,
      config: { site, company: displayName(site) },
    };
  }

  return null;
}

function displayName(token: string): string {
  return token
    .split(/[-_.]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
