// src/jobs/job-url.ts
//
// Posting URL validation. This protects automation from opening demo/stale/null placeholders while
// allowing supported employer ATS and public job-search posting URLs into the review queue. The set
// of supported sources and their per-source posting checks live in the single SOURCE_CATALOG
// (source-catalog.ts) — this gate just applies the matched source's `isPostingUrl`.

import type { AtsType } from "./types";
import { sourceForUrl } from "./source-catalog";

export interface JobUrlCheck {
  ok: boolean;
  atsType?: AtsType;
  reason?: string;
}

export function checkEmployerJobUrl(raw: string | undefined | null): JobUrlCheck {
  const value = (raw ?? "").trim();
  if (!value) return { ok: false, reason: "missing job URL" };
  if (/^(about:blank|null|undefined)$/i.test(value)) return { ok: false, reason: "blank placeholder URL" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "invalid job URL" };
  }
  if (!/^https?:$/i.test(url.protocol)) return { ok: false, reason: "job URL must be http or https" };

  const source = sourceForUrl(url);
  if (!source) return { ok: false, reason: "unsupported employer ATS URL" };
  if (source.isPostingUrl(url)) return { ok: true, atsType: source.id };
  // Known host but a board root / search page rather than a posting -> report the source so callers
  // can label it, but keep ok:false (matches the prior per-source behavior, incl. a/an grammar).
  const article = /^[aeiou]/i.test(source.name) ? "an" : "a";
  return { ok: false, atsType: source.id, reason: `not ${article} ${source.name} posting URL` };
}

export function isEmployerJobUrl(raw: string | undefined | null): boolean {
  return checkEmployerJobUrl(raw).ok;
}
