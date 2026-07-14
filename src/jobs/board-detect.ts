// src/jobs/board-detect.ts
//
// Browser-free board/source detection from a URL, built on the SOURCE_CATALOG
// host table. Replaces the old scraper-backed discovery/registry: it detects
// the ATS, extracts the board slug, and normalizes a pasted board URL. The
// homepage-sniffing path (which browsed a company site to find its board) is
// intentionally dropped — the user pastes a recognized board URL directly.

import type { AtsType } from "./types";
import { sourceForUrl } from "./source-catalog";

export interface ResolvedCompany {
  name: string;
  boardUrl: string;
  atsType: AtsType;
  via: "direct" | "homepage-link" | "careers-page";
}

/** The ATS/source a URL belongs to, or "unknown". */
export function detectAts(url: string): AtsType {
  try {
    return sourceForUrl(new URL(url))?.id ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Extract the board slug / account / companyId from a board URL (best-effort per ATS). */
export function slugFromBoardUrl(atsType: AtsType | string, boardUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(boardUrl);
  } catch {
    return /^[A-Za-z0-9_.-]+$/.test(boardUrl.trim()) ? boardUrl.trim() : null;
  }
  const seg = url.pathname.split("/").filter(Boolean);
  switch (atsType) {
    case "greenhouse": {
      const forParam = url.searchParams.get("for");
      if (forParam) return forParam;
      return seg[0] === "embed" ? null : (seg[0] ?? null);
    }
    default:
      // lever/ashby/smartrecruiters/jobvite/workday/… — the first path segment.
      return seg[0] ?? null;
  }
}

function displayName(slug: string): string {
  return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Normalize a recognized board URL to {name, boardUrl, atsType}, or null if unrecognized. */
export function normalizeBoard(
  url: string,
): { name: string; boardUrl: string; atsType: AtsType } | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  const source = sourceForUrl(u);
  if (!source) return null;
  const boardUrl = `${u.origin}${u.pathname}`.replace(/\/+$/, "");
  const slug = slugFromBoardUrl(source.id, url);
  return { name: slug ? displayName(slug) : source.name, boardUrl, atsType: source.id };
}

/**
 * Resolve a pasted URL to a target company. Only direct board URLs are
 * supported (no homepage browsing); returns null for anything unrecognized.
 */
export function resolveCompanyBoard(inputUrl: string, nameOverride?: string): ResolvedCompany | null {
  const t = inputUrl.trim();
  const url = /^https?:\/\//i.test(t) ? t : `https://${t}`;
  const n = normalizeBoard(url);
  if (!n) return null;
  return { name: nameOverride ?? n.name, boardUrl: n.boardUrl, atsType: n.atsType, via: "direct" };
}
