// Role/skill normalization for discovery matching — expands common synonyms and function families.
//
// CANONICAL TAXONOMY NOTE: role-family classification lives in ONE place — taxonomy.ts. This module
// keeps the synonym-expansion + seniority helpers (which taxonomy imports), and `roleFamilies` here
// simply DELEGATES to the canonical classifier so scoring, discovery, and the new intent/query/fit
// layer can never disagree about what family a title belongs to.

import { roleFamilies as canonicalRoleFamilies } from "./taxonomy";

const ROLE_SYNONYMS: Record<string, string[]> = {
  pm: ["product", "manager", "productmanager"],
  product: ["pm", "productmanager", "roadmap"],
  engineer: ["engineering", "developer", "software", "swe"],
  developer: ["engineer", "engineering", "software", "swe"],
  swe: ["software", "engineer", "developer"],
  frontend: ["front", "end", "react", "ui", "web"],
  backend: ["back", "end", "api", "server"],
  fullstack: ["full", "stack", "software", "engineer"],
  data: ["analytics", "analyst", "science", "sql"],
  analyst: ["analytics", "data", "operations", "ops"],
  operations: ["ops", "operational", "analyst"],
  gtm: ["go", "market", "revenue", "sales", "growth"],
  revenue: ["gtm", "sales", "growth", "operations"],
  design: ["designer", "ux", "ui"],
  marketing: ["growth", "demand", "brand", "content"],
  security: ["infosec", "cyber", "appsec"],
  devops: ["sre", "platform", "infrastructure", "cloud"],
  sre: ["devops", "reliability", "platform"],
};

const SENIORITY = ["intern", "junior", "associate", "mid", "senior", "staff", "principal", "lead", "head", "director", "vp"];

export function expandTokens(tokens: string[]): Set<string> {
  const out = new Set(tokens.map((t) => t.toLowerCase()));
  for (const t of tokens) {
    const key = t.toLowerCase();
    for (const syn of ROLE_SYNONYMS[key] ?? []) out.add(syn);
    for (const [k, syns] of Object.entries(ROLE_SYNONYMS)) {
      if (syns.includes(key)) out.add(k);
    }
  }
  return out;
}

export function seniorityLevel(title: string): number {
  const t = title.toLowerCase();
  if (/\b(intern|internship)\b/.test(t)) return 0;
  if (/\b(junior|jr|associate|entry)\b/.test(t)) return 1;
  if (/\b(senior|sr|iii)\b/.test(t)) return 3;
  if (/\b(staff|principal|lead)\b/.test(t)) return 4;
  if (/\b(head|director)\b/.test(t)) return 5;
  if (/\b(vp|vice president)\b/.test(t)) return 6;
  return 2; // mid / unspecified
}

export function seniorityCompatible(resumeTitle: string, postingTitle: string): boolean {
  const r = seniorityLevel(resumeTitle);
  const p = seniorityLevel(postingTitle);
  // Allow one level up/down; block large jumps (e.g. intern → director).
  return Math.abs(r - p) <= 2;
}

/** DEPRECATED shim — delegates to the canonical classifier in taxonomy.ts. Do not add rules here. */
export function roleFamilies(title: string): Set<string> {
  return canonicalRoleFamilies(title);
}
