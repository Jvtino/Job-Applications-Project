// src/ingestion/parse-resume.ts
//
// Turn raw resume text into structured, UNAPPROVED facts for the user to review. Two paths:
//   - heuristic (default, fully offline, deterministic): section + pattern parsing.
//   - llm (optional): used when an Anthropic key is configured AND opts.preferLlm; the model
//     is instructed to extract ONLY what the text states and never invent.
// Either way, parsing errors are expected — every fact lands as `approved: false` and the
// user corrects/approves them before anything is usable for generation.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  CertificationFact,
  EducationFact,
  EmploymentFact,
  Fact,
  GenericFact,
} from "../types/facts-ledger";
import { getLlmClient, extractJson, type LlmClient } from "../llm/anthropic";
import { cachedComplete, getDefaultLlmCache } from "../llm/cache";

export interface ParseResult {
  facts: Fact[];
  method: "llm" | "heuristic";
  warnings: string[];
}

const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*";
const YEAR = "\\d{4}";
const DATE = `(?:${MONTH}\\.?\\s+)?${YEAR}`;
const PRESENT = "(?:present|current|now|ongoing)";
const DATE_RANGE = new RegExp(`(${DATE})\\s*(?:-|–|—|to)\\s*(${DATE}|${PRESENT})`, "i");
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE = /(\+?\d[\d().\-\s]{8,}\d)/;
const URL = /\bhttps?:\/\/[^\s)]+|(?:linkedin\.com|github\.com)\/[^\s)]+/i;
const BULLET = /^\s*(?:[-•*▪◦‣·]|–)\s+/;
const DEGREE =
  /\b(bachelor|master|associate|doctorate|ph\.?\s?d|b\.?s\.?c?|m\.?s\.?c?|b\.?a\.?|m\.?a\.?|m\.?b\.?a|b\.?eng|m\.?eng)\b/i;

type Section =
  | "summary"
  | "experience"
  | "education"
  | "skills"
  | "certifications"
  | "languages"
  | "other";

function classifyHeader(line: string): Section | null {
  const t = line.trim().toLowerCase().replace(/[:\-—]+$/, "").trim();
  if (t.length === 0 || t.length > 40) return null;
  // Allow an optional leading qualifier ("professional summary", "career profile", etc.) so the
  // keyword need not be the very first word.
  if (/^(professional|career|executive|personal)\s+(summary|profile|statement)\b/.test(t)) return "summary";
  if (/^(summary|profile|objective|about|summary of qualifications)\b/.test(t)) return "summary";
  if (/^(experience|work experience|employment|professional experience|work history|relevant experience|professional background|career history)\b/.test(t))
    return "experience";
  if (/^education\b/.test(t)) return "education";
  if (/^(skills|technical skills|core skills|key skills|core competencies|competencies|areas of expertise|technical proficiencies|technical competencies|expertise)\b/.test(t)) return "skills";
  if (/^(certifications?|licenses?|credentials?)\b/.test(t)) return "certifications";
  if (/^languages?\b/.test(t)) return "languages";
  return null;
}

/**
 * Headers that share a line with their content, e.g. "Languages: Turkish | English" or
 * "Skills: SQL, Python". Returns the matched section plus the inline content so the caller can both
 * switch sections and emit the listed items (these lines are skipped by classifyHeader's length
 * guard and never start a clean header line otherwise).
 */
function classifyInlineHeader(line: string): { section: Section; rest: string } | null {
  const m = line.match(/^([A-Za-z][A-Za-z /&]{1,28}?)\s*:\s*(\S.+)$/);
  if (!m) return null;
  const section = classifyHeader(m[1]!.trim());
  if (!section) return null;
  return { section, rest: m[2]!.trim() };
}

/** Deterministic, offline heuristic parser. */
export function parseResumeHeuristic(text: string): ParseResult {
  const warnings: string[] = [];
  const facts: Fact[] = [];
  const lines = text.split("\n");

  // --- Contact facts (top-of-document scan) ---
  const head = lines.slice(0, 12).join("\n");
  const email = head.match(EMAIL)?.[0];
  const phone = head.match(PHONE)?.[0]?.trim();
  if (email) facts.push(contactFact(`Email: ${email}`, email));
  if (phone) facts.push(contactFact(`Phone: ${phone}`, phone));
  for (const url of head.match(new RegExp(URL, "gi")) ?? []) {
    facts.push(contactFact(url, url));
  }

  // --- Section walk ---
  let section: Section = "other";
  let pendingEmployment: EmploymentFact | null = null;
  // A professional summary is usually one paragraph that PDF extraction wraps across several
  // physical lines. Buffer those lines and emit ONE summary_point, so a single narrative claim
  // is not fragmented mid-sentence into many review items.
  let summaryLines: string[] = [];

  const flushSummary = () => {
    if (summaryLines.length === 0) return;
    const text = summaryLines.join(" ").replace(/\s+/g, " ").trim();
    if (text) facts.push(generic("summary_point", text, text));
    summaryLines = [];
  };

  const flush = () => {
    flushSummary();
    if (pendingEmployment) {
      facts.push(pendingEmployment);
      pendingEmployment = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed) continue;

    // "Header: inline content" (e.g. "Languages: Turkish | English", "Skills: SQL, Python") —
    // switch sections AND emit the listed items, since the content rides on the header line.
    const inline = classifyInlineHeader(trimmed);
    if (inline) {
      flush();
      section = inline.section;
      if (inline.section === "skills") {
        for (const skill of splitList(inline.rest)) facts.push(generic("skill", skill, trimmed));
      } else if (inline.section === "languages") {
        for (const lang of splitList(inline.rest)) facts.push(generic("language", lang, trimmed));
      } else if (inline.section === "summary") {
        const sp = inline.rest.trim();
        if (sp) summaryLines.push(sp);
      } else if (inline.section === "certifications") {
        const cleaned = inline.rest.replace(BULLET, "").trim();
        if (cleaned) facts.push(certificationFact(cleaned));
      }
      continue;
    }

    const header = classifyHeader(trimmed);
    if (header) {
      flush();
      section = header;
      continue;
    }

    if (section === "summary") {
      if (BULLET.test(line)) {
        // An explicitly bulleted summary line is its own claim — flush the running paragraph
        // first so it doesn't absorb the bullet.
        flushSummary();
        const cleaned = trimmed.replace(BULLET, "").trim();
        if (cleaned) facts.push(generic("summary_point", cleaned, trimmed));
      } else {
        // Plain (wrapped) text: keep accumulating into one paragraph-level summary point.
        summaryLines.push(trimmed);
      }
      continue;
    }

    if (section === "experience") {
      const dm = trimmed.match(DATE_RANGE);
      if (dm && !BULLET.test(line)) {
        // New employment header with an inline date range.
        flush();
        const { employer, title } = splitEmployerTitle(trimmed, dm[0]);
        pendingEmployment = {
          id: randomUUID(),
          type: "employment",
          approved: false,
          sourceText: trimmed,
          employer,
          title,
          startDate: dm[1]!.trim(),
          endDate: /present|current|now|ongoing/i.test(dm[2]!) ? "present" : dm[2]!.trim(),
          bullets: [],
        };
        continue;
      }
      // Layout where the date range wraps to the NEXT line (common in PDF extraction):
      //   "Senior Operations Analyst — Northwind Logistics"
      //   "2021 - Present"
      if (!BULLET.test(line) && isLikelyEmploymentHeader(trimmed)) {
        const nextIdx = nextNonEmptyIndex(lines, i + 1);
        const next = nextIdx >= 0 ? lines[nextIdx]!.trim() : "";
        const ndm = next.match(DATE_RANGE);
        if (ndm && !BULLET.test(next)) {
          flush();
          // Two layouts where the date wraps to the next line:
          //   A) "Title — Employer" / "2021 - Present"      (next line is essentially just the date)
          //   B) "Title" / "Employer | Location | 2021 - Present"  (employer on the date line)
          const nextWithoutDate = next.replace(ndm[0]!, "").replace(/[|,–—-]\s*$/, "").trim();
          let employer: string;
          let title: string;
          if (nextWithoutDate.length > 1) {
            // Layout B: this line is the title; the next line's leading segment is the employer.
            title = trimmed.replace(/[|,–—-]\s*$/, "").trim();
            const fromNext = splitEmployerTitle(next, ndm[0]!);
            employer = fromNext.title || fromNext.employer;
          } else {
            // Layout A: this line carries both; the next line is only the date.
            ({ employer, title } = splitEmployerTitle(trimmed, ""));
          }
          pendingEmployment = {
            id: randomUUID(),
            type: "employment",
            approved: false,
            sourceText: `${trimmed} ${next}`,
            employer,
            title,
            startDate: ndm[1]!.trim(),
            endDate: /present|current|now|ongoing/i.test(ndm[2]!) ? "present" : ndm[2]!.trim(),
            bullets: [],
          };
          i = nextIdx; // consume the date line
          continue;
        }
      }
      if (pendingEmployment && BULLET.test(line)) {
        // A resume bullet is a single source claim. Keep it inside the employment fact only —
        // do NOT also emit a standalone metric fact, or one bullet shows up as two review items.
        const bullet = trimmed.replace(BULLET, "").trim();
        pendingEmployment.bullets.push(bullet);
        continue;
      }
      // A wrapped bullet: the tail of a bullet that PDF extraction pushed onto its own line
      // (lower-case start / hyphenated wrap). Join it back onto the last bullet instead of
      // dropping it, so one accomplishment stays one claim.
      if (pendingEmployment && pendingEmployment.bullets.length > 0) {
        const last = pendingEmployment.bullets.length - 1;
        if (isWrapContinuation(pendingEmployment.bullets[last]!, trimmed)) {
          pendingEmployment.bullets[last] = joinWrapped(pendingEmployment.bullets[last]!, trimmed);
          continue;
        }
      }
      // Non-bullet, non-dated line inside experience: treat as continuation/company line.
      continue;
    }

    if (section === "education") {
      if (DEGREE.test(trimmed)) {
        facts.push(educationFact(trimmed, lines[i + 1]?.trim()));
      }
      continue;
    }

    if (section === "skills") {
      for (const skill of splitList(trimmed)) {
        facts.push(generic("skill", skill, trimmed));
      }
      continue;
    }

    if (section === "certifications") {
      const isBullet = BULLET.test(line);
      const cleaned = trimmed.replace(BULLET, "").trim();
      if (!cleaned) continue;
      const CERT_META = /^(?:issued|expires?|expiry|credential|id|number|license|level|provider|authority)\s*:/i;
      const lastFact = facts.length > 0 ? facts[facts.length - 1] : null;
      const lastCert = !isBullet && lastFact?.type === "certification" ? (lastFact as CertificationFact) : null;
      const stampYear = (cert: CertificationFact) => {
        if (!("dateEarned" in cert) && !("inProgress" in cert)) {
          const dm = cleaned.match(new RegExp(YEAR));
          if (dm) cert.dateEarned = dm[0];
        }
      };
      if (lastCert && CERT_META.test(cleaned)) {
        // Explicit metadata continuation — append to the previous cert's name.
        lastCert.name += ` · ${cleaned}`;
        stampYear(lastCert);
      } else if (lastCert && isWrapContinuation(lastCert.name, cleaned)) {
        // A single certification/credential wrapped across several physical lines — join it back
        // into one reviewable item instead of emitting a fragment per line.
        lastCert.name = joinWrapped(lastCert.name, cleaned);
        if (typeof lastCert.sourceText === "string") {
          lastCert.sourceText = joinWrapped(lastCert.sourceText, cleaned);
        }
        stampYear(lastCert);
      } else {
        facts.push(certificationFact(cleaned));
      }
      continue;
    }

    if (section === "languages") {
      for (const lang of splitList(trimmed)) {
        facts.push(generic("language", lang, trimmed));
      }
      continue;
    }
  }
  flush();

  if (facts.filter((f) => f.type === "employment").length === 0) {
    warnings.push(
      "No employment entries detected heuristically. Review the parsed ledger and add them manually if needed."
    );
  }
  return { facts, method: "heuristic", warnings };
}

// ---- heuristic helpers ----------------------------------------------------------------

function contactFact(statement: string, sourceText: string): GenericFact {
  return { id: randomUUID(), type: "contact", approved: false, sourceText, statement };
}
function generic(
  type: GenericFact["type"],
  statement: string,
  sourceText: string
): GenericFact {
  return { id: randomUUID(), type, approved: false, sourceText, statement };
}

// A physical line is a WRAPPED CONTINUATION of the item above it — not a new item — when the
// running text ends mid-word on a hyphen ("public-" + "trust") or this line starts lower-case
// (a sentence continuing across a PDF line break). New résumé items start with a capital, a
// digit, or a bullet, so this stays conservative and does not merge two distinct items.
const HYPHEN_END = /[-‐‑]$/;
function isWrapContinuation(runningText: string, nextLine: string): boolean {
  if (HYPHEN_END.test(runningText.trimEnd())) return true;
  return /^[a-z]/.test(nextLine.trim());
}
// Join a wrapped line onto the running text: no space after a hyphen ("public-" + "trust" ->
// "public-trust"), a single space otherwise.
function joinWrapped(runningText: string, nextLine: string): string {
  const base = runningText.trimEnd();
  const add = nextLine.trim();
  return HYPHEN_END.test(base) ? base + add : `${base} ${add}`;
}
function educationFact(line: string, next?: string): EducationFact {
  const dateM = line.match(new RegExp(YEAR));
  const degreeM = line.match(DEGREE);
  // Institution guess: the line if it lacks a degree word, else the following line.
  const institution = degreeM ? (next && !DEGREE.test(next) ? next : line) : line;
  return {
    id: randomUUID(),
    type: "education",
    approved: false,
    sourceText: line,
    institution: institution.replace(/\s{2,}/g, " ").trim(),
    degree: degreeM ? line.trim() : line.trim(),
    ...(dateM ? { graduationDate: dateM[0] } : {}),
  };
}
function certificationFact(line: string): CertificationFact {
  const inProgress = /in progress|expected|pursuing|candidate/i.test(line);
  const dateM = line.match(new RegExp(YEAR));
  return {
    id: randomUUID(),
    type: "certification",
    approved: false,
    sourceText: line,
    name: line.replace(/\s{2,}/g, " ").trim(),
    ...(inProgress ? { inProgress: true } : dateM ? { dateEarned: dateM[0] } : {}),
  };
}
function splitEmployerTitle(line: string, dateStr: string): { employer: string; title: string } {
  const withoutDate = (dateStr ? line.replace(dateStr, "") : line).replace(/[|,–—-]\s*$/, "").trim();
  const parts = withoutDate.split(/\s+(?:at|@|-|–|—|\|)\s+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) return { title: parts[0]!, employer: parts[1]! };
  return { title: withoutDate || "Unknown title", employer: parts[0] ?? "Unknown employer" };
}

function nextNonEmptyIndex(lines: string[], from: number): number {
  for (let i = from; i < lines.length; i++) {
    if (lines[i]!.trim()) return i;
  }
  return -1;
}

/**
 * A non-bullet experience line that plausibly names a role/company (so we can pair it with a date
 * range on the following line). Conservative: rejects sentences and over-long lines to avoid noise.
 */
function isLikelyEmploymentHeader(line: string): boolean {
  if (!line || line.length > 90) return false;
  if (BULLET.test(line)) return false;
  if (/[.!?]$/.test(line)) return false; // sentences aren't headers
  const words = line.split(/\s+/).filter(Boolean);
  if (words.length > 14) return false;
  const hasSeparator = /\s+(?:at|@|-|–|—|\|)\s+/.test(line) || /,/.test(line);
  const titleCaseWords = words.filter((w) => /^[A-Z][A-Za-z.&/]*$/.test(w)).length;
  return hasSeparator || titleCaseWords >= 2;
}
function splitList(line: string): string[] {
  return line
    .replace(BULLET, "")
    .split(/[,;•|]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

// ---- LLM path -------------------------------------------------------------------------

const draftFactSchema = z.array(
  z.object({
    type: z.enum([
      "employment",
      "education",
      "certification",
      "skill",
      "achievement",
      "metric",
      "language",
      "summary_point",
      "contact",
    ]),
    employer: z.string().optional(),
    title: z.string().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    location: z.string().optional(),
    bullets: z.array(z.string()).optional(),
    institution: z.string().optional(),
    degree: z.string().optional(),
    field: z.string().optional(),
    graduationDate: z.string().optional(),
    name: z.string().optional(),
    issuer: z.string().optional(),
    dateEarned: z.string().optional(),
    inProgress: z.boolean().optional(),
    statement: z.string().optional(),
    value: z.number().optional(),
    unit: z.string().optional(),
    sourceText: z.string().optional(),
  })
);

const LLM_SYSTEM =
  "You extract a strict, literal facts ledger from a resume. Extract ONLY claims explicitly " +
  "present in the text. Never infer, embellish, round, or invent employers, titles, dates, " +
  "degrees, certifications, metrics, or skills. If a detail is absent, omit the field. Return " +
  "ONLY a JSON array, no prose.";

export async function parseResumeLLM(text: string, client: LlmClient): Promise<ParseResult> {
  const prompt =
    `Resume text between <resume> tags. Return a JSON array of fact objects with a "type" ` +
    `field (employment|education|certification|skill|achievement|metric|language|summary_point|` +
    `contact) and the relevant fields for that type (employer/title/startDate/endDate/bullets; ` +
    `institution/degree/field/graduationDate; name/issuer/dateEarned/inProgress; statement/value/` +
    `unit). Include a short sourceText quoting the span each fact came from.\n\n<resume>\n${text}\n</resume>`;
  const raw = await cachedComplete(getDefaultLlmCache(), client, "resume-parse@v1", prompt, {
    system: LLM_SYSTEM,
    maxTokens: 8192,
    feature: "resume-parse",
    // Never cache a completion the schema rejects — a retry deserves a fresh sample.
    validate: (t) => void draftFactSchema.parse(extractJson(t)),
  });
  const drafts = draftFactSchema.parse(extractJson(raw));
  const facts: Fact[] = drafts.map((d): Fact => {
    const base = { id: randomUUID(), approved: false as const, ...(d.sourceText ? { sourceText: d.sourceText } : {}) };
    switch (d.type) {
      case "employment":
        return {
          ...base,
          type: "employment",
          employer: d.employer ?? "Unknown employer",
          title: d.title ?? "Unknown title",
          startDate: d.startDate ?? "",
          endDate: (d.endDate as EmploymentFact["endDate"]) ?? "present",
          ...(d.location ? { location: d.location } : {}),
          bullets: d.bullets ?? [],
        };
      case "education":
        return {
          ...base,
          type: "education",
          institution: d.institution ?? "",
          degree: d.degree ?? "",
          ...(d.field ? { field: d.field } : {}),
          ...(d.graduationDate ? { graduationDate: d.graduationDate } : {}),
        };
      case "certification":
        return {
          ...base,
          type: "certification",
          name: d.name ?? d.statement ?? "",
          ...(d.issuer ? { issuer: d.issuer } : {}),
          ...(d.dateEarned ? { dateEarned: d.dateEarned } : {}),
          ...(d.inProgress ? { inProgress: d.inProgress } : {}),
        };
      case "metric":
        return {
          ...base,
          type: "metric",
          statement: d.statement ?? "",
          ...(d.value !== undefined ? { value: d.value } : {}),
          ...(d.unit ? { unit: d.unit } : {}),
        };
      default:
        return { ...base, type: d.type, statement: d.statement ?? "" };
    }
  });
  return { facts, method: "llm", warnings: [] };
}

/** Default entry point: LLM when configured and requested, else the heuristic parser. */
export async function parseResume(
  text: string,
  opts: { preferLlm?: boolean } = {}
): Promise<ParseResult> {
  if (opts.preferLlm) {
    const client = getLlmClient();
    if (client) {
      try {
        return await parseResumeLLM(text, client);
      } catch (err) {
        const heur = parseResumeHeuristic(text);
        heur.warnings.push(`LLM parse failed (${(err as Error).message}); used heuristic parser.`);
        return heur;
      }
    }
  }
  return parseResumeHeuristic(text);
}
