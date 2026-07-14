// src/ats/field-matcher.ts
//
// Layered FieldMatcher: resolve a rendered form field to a profile value with confidence +
// provenance. Order (to bound both error rate and LLM cost):
//   1. deterministic synonym/exact map (no model call)         -> confidence ~0.82..1.0
//   2. fuzzy string similarity against the rendered options
//   3. LLM proposal as a LAST resort (low_stakes free-text only, opt-in)
// The LLM layer never reports high confidence for self_id / authorization / knockout fields,
// and decideFillAction (adapter.ts) refuses to auto-submit those unless step 1 matched AND the
// value is user-confirmed. High-stakes fields therefore pause by policy, never by accident.

import {
  DECLINE,
  type Answer,
  type ApplicantProfile,
  type ContactInfo,
  type DynamicQA,
} from "../types/applicant-profile";
import type { FieldMatcher, FieldRisk, FormField, MatchMethod, MatchResult } from "./adapter";
import { normalizeQuestionSignature } from "../profile/dynamic-qa";
import {
  RISK_KEYWORDS,
  US_STATE_NAMES,
  boolTargets,
  disabilityTargets,
  genderTargets,
  raceTargets,
  veteranTargets,
  DECLINE_SYNONYMS,
} from "./synonyms";
import { getLlmClient, type LlmClient } from "../llm/anthropic";

export interface MatcherOptions {
  /** Allow the LLM last-resort layer for low-stakes free-text fields only. */
  useLlm?: boolean;
}

export class LayeredFieldMatcher implements FieldMatcher {
  private readonly client: LlmClient | null;
  constructor(opts: MatcherOptions = {}) {
    this.client = opts.useLlm ? getLlmClient() : null;
  }

  classifyRisk(field: FormField): FieldRisk {
    const l = field.label.toLowerCase();
    const has = (kws: readonly string[]) => kws.some((k) => l.includes(k));
    if (has(RISK_KEYWORDS.self_id)) return "self_id";
    if (has(RISK_KEYWORDS.authorization)) return "authorization";
    if (has(RISK_KEYWORDS.knockout)) return "knockout";
    if (has(RISK_KEYWORDS.compensation)) return "compensation";
    if (has(RISK_KEYWORDS.identity)) return "identity";
    return "low_stakes";
  }

  async match(field: FormField, profile: ApplicantProfile, dynamic: DynamicQA[]): Promise<MatchResult> {
    const risk = this.classifyRisk(field);
    const label = field.label.toLowerCase();
    const hasOptions = Boolean(field.options && field.options.length);

    if (risk === "identity") {
      const r = resolveIdentity(label, profile.contact);
      if (r) {
        if (hasOptions && r.targets) {
          const m = resolveOption(r.targets, field.options!);
          if (m) return ok(field, risk, m.value, "user", m.method, m.confidence, `identity: ${label}`);
        } else if (r.value) {
          return ok(field, risk, r.value, "user", "exact", 0.97, `identity: ${label}`);
        }
      }
      return this.fallback(field, risk, dynamic);
    }

    if (risk === "authorization") {
      return this.fromBoolean(field, risk, resolveAuthorization(label, profile), dynamic);
    }

    if (risk === "self_id") {
      return this.fromOptionAnswer(field, risk, resolveSelfId(label, profile), dynamic);
    }

    if (risk === "knockout") {
      return this.fromBoolean(field, risk, resolveScreening(label, profile), dynamic);
    }

    if (risk === "compensation") {
      const v = resolveCompensation(profile);
      if (v) return ok(field, risk, v, "user", "synonym", 0.8, "compensation from preferences");
      return this.fallback(field, risk, dynamic);
    }

    // low_stakes
    if (/how did you hear/.test(label)) {
      const a = profile.screening.hearAboutSource;
      if (a && typeof a.value === "string") {
        return mapStringOrText(field, risk, a.value, a.source, hasOptions, "hearAboutSource");
      }
    }
    return this.fallback(field, risk, dynamic);
  }

  private async fromBoolean(
    field: FormField,
    risk: FieldRisk,
    ans: Answer<boolean> | undefined,
    dynamic: DynamicQA[]
  ): Promise<MatchResult> {
    if (!ans || ans.value === null) return this.fallback(field, risk, dynamic);
    const targets = ans.value === DECLINE ? DECLINE_SYNONYMS : boolTargets(ans.value);
    if (field.options && field.options.length) {
      const m = resolveOption(targets, field.options);
      if (m) return ok(field, risk, m.value, ans.source, m.method, m.confidence, `${risk}: mapped to option`);
      return unmapped(field, risk, ans.source, `${risk}: value present but no matching option`);
    }
    const text = ans.value === DECLINE ? "Decline to answer" : ans.value ? "Yes" : "No";
    return ok(field, risk, text, ans.source, "exact", 0.9, `${risk}: free-text Yes/No`);
  }

  private async fromOptionAnswer(
    field: FormField,
    risk: FieldRisk,
    r: { targets: string[]; source: Answer<unknown>["source"] } | null,
    dynamic: DynamicQA[]
  ): Promise<MatchResult> {
    if (!r) return this.fallback(field, risk, dynamic);
    if (field.options && field.options.length) {
      const m = resolveOption(r.targets, field.options);
      if (m) return ok(field, risk, m.value, r.source, m.method, m.confidence, `${risk}: mapped to option`);
      return unmapped(field, risk, r.source, `${risk}: value present but no matching option`);
    }
    // self-id on a free-text field is unusual; surface the canonical first synonym.
    return ok(field, risk, r.targets[0]!, r.source, "synonym", 0.7, `${risk}: free-text`);
  }

  private async fallback(field: FormField, risk: FieldRisk, dynamic: DynamicQA[]): Promise<MatchResult> {
    const key = normalizeQuestionSignature(field.label);
    const hit = dynamic.find((d) => d.key === key);
    if (hit && hit.answer !== null) {
      const a = hit.answer;
      if (Array.isArray(a)) {
        return ok(field, risk, a, "dynamic_qa", "synonym", 0.85, "dynamic Q&A (ask once, reuse)");
      }
      const text = a === DECLINE ? "Decline to answer" : typeof a === "boolean" ? (a ? "Yes" : "No") : String(a);
      return mapStringOrText(field, risk, text, "dynamic_qa", Boolean(field.options?.length), "dynamic Q&A");
    }
    // LLM last resort — low_stakes free-text only, and only when explicitly enabled.
    if (this.client && risk === "low_stakes" && !field.options?.length) {
      const proposed = await this.llmPropose(field).catch(() => null);
      if (proposed) return ok(field, risk, proposed, "none", "llm", 0.5, "LLM proposal (low-stakes)");
    }
    return unmapped(field, risk, "none", "no profile value for this field");
  }

  private async llmPropose(field: FormField): Promise<string | null> {
    if (!this.client) return null;
    const out = await this.client.complete(
      `A job application asks: "${field.label}". Give a brief, generic, truthful answer (or reply NONE if you cannot).`,
      { maxTokens: 200, feature: "field-match" }
    );
    const t = out.text.trim();
    return t && !/^none$/i.test(t) ? t.split("\n")[0]!.slice(0, 300) : null;
  }
}

// ----------------------------------------------------------------------------------------
// Builders + resolvers
// ----------------------------------------------------------------------------------------

function ok(
  field: FormField,
  risk: FieldRisk,
  resolvedValue: string | string[],
  source: MatchResult["source"],
  method: MatchMethod,
  confidence: number,
  rationale: string
): MatchResult {
  return { field, risk, resolvedValue, source, method, confidence, rationale };
}

function unmapped(field: FormField, risk: FieldRisk, source: MatchResult["source"], rationale: string): MatchResult {
  return { field, risk, resolvedValue: null, source, method: "unmapped", confidence: 0, rationale };
}

function mapStringOrText(
  field: FormField,
  risk: FieldRisk,
  value: string,
  source: MatchResult["source"],
  hasOptions: boolean,
  rationale: string
): MatchResult {
  if (hasOptions && field.options) {
    const m = resolveOption([value], field.options);
    if (m) return ok(field, risk, m.value, source, m.method, m.confidence, rationale);
    return unmapped(field, risk, source, `${rationale}: no matching option for "${value}"`);
  }
  return ok(field, risk, value, source, "synonym", 0.85, rationale);
}

interface IdentityResolution {
  value?: string;
  targets?: string[];
}

function resolveIdentity(label: string, c: ContactInfo): IdentityResolution | null {
  const first = c.preferredName?.trim() || c.legalFirstName;
  if (/preferred name/.test(label)) return val(c.preferredName);
  if (/first name|given name/.test(label)) return val(c.legalFirstName);
  if (/last name|surname|family name/.test(label)) return val(c.legalLastName);
  if (/full name|^name$|your name/.test(label)) return val(`${first} ${c.legalLastName}`.trim());
  if (/email/.test(label)) return val(c.email);
  if (/phone|mobile|telephone/.test(label)) return val(c.phone);
  if (/linkedin/.test(label)) return val(c.links.linkedin);
  if (/github/.test(label)) return val(c.links.github);
  if (/website|portfolio|personal site/.test(label)) return val(c.links.portfolio);
  if (/zip|postal/.test(label)) return val(c.address.postalCode);
  if (/city/.test(label)) return val(c.address.city);
  if (/state|province/.test(label)) {
    const code = c.address.state;
    if (!code) return null;
    const name = US_STATE_NAMES[code.toUpperCase()];
    return { value: code, targets: name ? [code, name] : [code] };
  }
  if (/country/.test(label)) return { value: "United States", targets: ["united states", "usa", "us", "united states of america"] };
  if (/address|street/.test(label)) return val(c.address.line1);
  return null;

  function val(s: string | undefined): IdentityResolution | null {
    return s && s.trim() ? { value: s, targets: [s] } : null;
  }
}

function resolveAuthorization(label: string, profile: ApplicantProfile): Answer<boolean> | undefined {
  const wa = profile.workAuthorization;
  if (/sponsor|visa|work permit/.test(label)) return wa.requiresSponsorshipNowOrFuture;
  return wa.authorizedToWorkInUS;
}

function resolveScreening(label: string, profile: ApplicantProfile): Answer<boolean> | undefined {
  const s = profile.screening;
  if (/18/.test(label)) return s.isAtLeast18;
  if (/essential function/.test(label)) return s.canPerformEssentialFunctions;
  if (/accommodation/.test(label)) return s.requiresAccommodationForProcess;
  if (/previously (employed|worked)|currently employed by/.test(label)) return s.previouslyEmployedHere;
  if (/non-?compete/.test(label)) return s.hasNonCompete;
  return undefined; // clearance, felony, etc. -> dynamic Q&A fallback
}

function resolveSelfId(
  label: string,
  profile: ApplicantProfile
): { targets: string[]; source: Answer<unknown>["source"] } | null {
  const sid = profile.selfId;
  const wrap = <T>(a: Answer<T>, toTargets: (v: T | typeof DECLINE) => string[]) =>
    a.value === null ? null : { targets: toTargets(a.value), source: a.source };

  if (/gender/.test(label)) return wrap(sid.gender, genderTargets);
  if (/race|ethnic|hispanic/.test(label)) return wrap(sid.raceEthnicity, raceTargets);
  if (/veteran/.test(label)) return wrap(sid.veteran.status, veteranTargets);
  if (/disab/.test(label)) return wrap(sid.disability, disabilityTargets);
  return null;
}

function resolveCompensation(profile: ApplicantProfile): string | null {
  const c = profile.preferences.compensation;
  if (c.isNegotiable) return "Negotiable";
  if (c.desiredBaseMin && c.desiredBaseMax) return `${c.desiredBaseMin} - ${c.desiredBaseMax}`;
  if (c.desiredBaseMin) return String(c.desiredBaseMin);
  return null;
}

interface OptionMatch {
  value: string;
  method: MatchMethod;
  confidence: number;
}

/** Deterministic exact/synonym/fuzzy match of target synonyms against rendered options. */
export function resolveOption(targets: string[], options: string[]): OptionMatch | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const opts = options.map((o) => ({ raw: o, n: norm(o) })).filter((o) => o.n);

  for (let i = 0; i < targets.length; i++) {
    const t = norm(targets[i]!);
    const hit = opts.find((o) => o.n === t);
    if (hit) return { value: hit.raw, method: i === 0 ? "exact" : "synonym", confidence: 1.0 };
  }
  for (const t0 of targets) {
    const t = norm(t0);
    if (!t) continue;
    const hit = opts.find((o) => o.n.includes(t) || t.includes(o.n));
    if (hit) return { value: hit.raw, method: "fuzzy", confidence: 0.82 };
  }
  let best: { raw: string } | null = null;
  let score = 0;
  for (const t0 of targets) {
    const tset = new Set(norm(t0).split(" ").filter(Boolean));
    for (const o of opts) {
      const oset = new Set(o.n.split(" ").filter(Boolean));
      const inter = [...tset].filter((x) => oset.has(x)).length;
      const uni = new Set([...tset, ...oset]).size;
      const j = uni ? inter / uni : 0;
      if (j > score) {
        score = j;
        best = o;
      }
    }
  }
  if (best && score >= 0.5) return { value: best.raw, method: "fuzzy", confidence: 0.6 + score * 0.2 };
  return null;
}
