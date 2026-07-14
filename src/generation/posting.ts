// src/generation/posting.ts
//
// Parse a raw job-posting into a JobPosting: pull requirement lines and rank keywords. Purely
// deterministic and offline; this only drives which approved facts get emphasized.

import type { JobPosting } from "../types/job-posting";

// Words too generic to help rank facts.
const STOP = new Set(
  [
    "the","a","an","and","or","but","for","to","of","in","on","at","by","with","from","as","is",
    "are","be","will","you","your","we","our","they","their","this","that","these","those","it",
    "have","has","had","not","can","may","must","should","who","what","when","where","which","how",
    "experience","experienced","work","working","ability","able","strong","excellent","good","plus",
    "preferred","required","requirements","qualifications","responsibilities","role","position",
    "job","team","teams","company","candidate","candidates","including","etc","years","year","per",
    "about","into","over","across","using","use","help","make","new","more","most","such","other",
    "skills","knowledge","understanding","duties","apply","applicant","us","day","days","week",
  ].map((w) => w)
);

const REQ_HEADER =
  /^(requirements|qualifications|what you('|’)?ll (need|bring|do)|responsibilities|who you are|must have|nice to have|basic qualifications|preferred qualifications)\b/i;
const BULLET = /^\s*(?:[-•*▪◦‣·]|–|\d+[.)])\s+/;

export function parsePosting(
  rawText: string,
  meta: { title?: string; company?: string; location?: string; applyUrl?: string; source?: string } = {}
): JobPosting {
  const lines = rawText.split("\n").map((l) => l.trim());
  const requirements: string[] = [];
  let inReqSection = false;

  for (const line of lines) {
    if (!line) continue;
    if (REQ_HEADER.test(line)) {
      inReqSection = true;
      continue;
    }
    // A new non-bullet header-like line ends the requirements section.
    if (inReqSection && !BULLET.test(line) && /^[A-Z][A-Za-z ]{0,30}:?$/.test(line) && line.length < 32) {
      inReqSection = false;
    }
    if (BULLET.test(line)) {
      const text = line.replace(BULLET, "").trim();
      if (text && (inReqSection || /\b(experience|proficien|degree|years|knowledge|skill)/i.test(text))) {
        requirements.push(text);
      }
    }
  }

  return {
    title: meta.title?.trim() || guessTitle(lines) || "the role",
    company: meta.company?.trim() || "the company",
    ...(meta.location ? { location: meta.location } : {}),
    ...(meta.applyUrl ? { applyUrl: meta.applyUrl } : {}),
    ...(meta.source ? { source: meta.source } : {}),
    rawText,
    requirements: requirements.slice(0, 30),
    keywords: rankKeywords(rawText),
  };
}

function guessTitle(lines: string[]): string | undefined {
  // First non-empty line is often the title.
  return lines.find((l) => l.length > 0 && l.length < 80);
}

/** Frequency-ranked significant keywords (and notable bigrams) from the posting. */
export function rankKeywords(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9+#.\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP.has(t) && !/^\d+$/.test(t));

  const freq = new Map<string, number>();
  for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 30)
    .map(([w]) => w);
}

/**
 * A 0..1 relevance score of arbitrary text against the posting's keywords. Keywords that appear in
 * the posting's REQUIREMENTS section count double, so matching what the role actually demands
 * (vs. boilerplate company copy) is rewarded.
 */
export function relevanceScore(text: string, posting: JobPosting): number {
  if (posting.keywords.length === 0) return 0;
  const hay = text.toLowerCase();
  const reqText = posting.requirements.join(" \n ").toLowerCase();
  let weightedHits = 0;
  let weightTotal = 0;
  for (const kw of posting.keywords) {
    const weight = reqText.includes(kw) ? 2 : 1;
    weightTotal += weight;
    if (hay.includes(kw)) weightedHits += weight;
  }
  return weightTotal === 0 ? 0 : weightedHits / weightTotal;
}
