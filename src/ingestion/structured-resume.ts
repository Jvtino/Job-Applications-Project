// Structured resume parsing and conversion.
//
// This is intentionally separate from the facts-ledger parser: the ledger is the closed,
// reviewable claim store used for generation, while this richer shape is for import review and
// app-field mapping. AI parsing is optional and server-side only; offline fallback keeps the same
// contract without inventing missing details.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { extractJson, getLlmClient, type LlmClient } from "../llm/client";
import type {
  CertificationFact,
  EducationFact,
  EmploymentFact,
  Fact,
  GenericFact,
} from "../types/facts-ledger";
import { extractProfileFromResume } from "./profile-from-resume";
import { cachedComplete, getDefaultLlmCache } from "../llm/cache";

const asString = z.preprocess((v) => (v == null ? "" : String(v)), z.string()).catch("");
const asStringArray = z
  .preprocess((v) => (Array.isArray(v) ? v : []), z.array(asString))
  .transform((items) => uniqueStrings(items.map((s) => s.trim()).filter(Boolean)))
  .catch([]);
const asBoolean = z
  .preprocess((v) => v === true || String(v).toLowerCase() === "true", z.boolean())
  .catch(false);

const PersonalInformationSchema = z.object({
  full_name: asString,
  email: asString,
  phone: asString,
  location: asString,
  linkedin: asString,
  github: asString,
  portfolio: asString,
  other_links: asStringArray,
});

const WorkExperienceSchema = z.object({
  job_title: asString,
  company: asString,
  location: asString,
  start_date: asString,
  end_date: asString,
  is_current: asBoolean,
  responsibilities: asStringArray,
  achievements: asStringArray,
  technologies_or_tools: asStringArray,
});

const EducationSchema = z.object({
  degree: asString,
  field_of_study: asString,
  institution: asString,
  location: asString,
  start_date: asString,
  end_date: asString,
  graduation_date: asString,
  honors: asString,
});

const SkillsSchema = z.object({
  technical_skills: asStringArray,
  soft_skills: asStringArray,
  tools: asStringArray,
  programming_languages: asStringArray,
  frameworks: asStringArray,
  platforms: asStringArray,
  industry_skills: asStringArray,
});

const CertificationSchema = z.object({
  name: asString,
  issuer: asString,
  issue_date: asString,
  expiration_date: asString,
  credential_id: asString,
  credential_url: asString,
});

const ProjectSchema = z.object({
  name: asString,
  description: asString,
  role: asString,
  technologies: asStringArray,
  outcomes: asStringArray,
  url: asString,
});

export const ParsedResumeDataSchema = z.object({
  personal_information: PersonalInformationSchema.default({
    full_name: "",
    email: "",
    phone: "",
    location: "",
    linkedin: "",
    github: "",
    portfolio: "",
    other_links: [],
  }),
  professional_summary: asString,
  work_experience: z.array(WorkExperienceSchema).default([]).catch([]),
  education: z.array(EducationSchema).default([]).catch([]),
  skills: SkillsSchema.default({
    technical_skills: [],
    soft_skills: [],
    tools: [],
    programming_languages: [],
    frameworks: [],
    platforms: [],
    industry_skills: [],
  }),
  certifications: z.array(CertificationSchema).default([]).catch([]),
  projects: z.array(ProjectSchema).default([]).catch([]),
  awards: asStringArray,
  publications: asStringArray,
  languages: asStringArray,
  volunteer_experience: asStringArray,
  missing_or_uncertain_information: asStringArray,
});

export type ParsedResumeData = z.infer<typeof ParsedResumeDataSchema>;

export interface StructuredResumeParseResult {
  data: ParsedResumeData;
  method: "llm" | "heuristic";
  warnings: string[];
}

const STRUCTURED_RESUME_SYSTEM = [
  "You extract structured resume data as strict JSON.",
  "Use only information explicitly present in the resume.",
  "Do not infer, embellish, or invent missing details.",
  "Normalize dates consistently when the resume provides enough information.",
  "Use empty strings or empty arrays for missing values.",
  "Separate responsibilities from achievements where possible.",
  "Detect current jobs.",
  "Remove duplicates.",
  "Return valid JSON only, with no prose or Markdown.",
].join(" ");

const STRUCTURED_RESUME_PROMPT = `Return exactly one JSON object with this shape:
{
  "personal_information": {
    "full_name": "",
    "email": "",
    "phone": "",
    "location": "",
    "linkedin": "",
    "github": "",
    "portfolio": "",
    "other_links": []
  },
  "professional_summary": "",
  "work_experience": [
    {
      "job_title": "",
      "company": "",
      "location": "",
      "start_date": "",
      "end_date": "",
      "is_current": false,
      "responsibilities": [],
      "achievements": [],
      "technologies_or_tools": []
    }
  ],
  "education": [
    {
      "degree": "",
      "field_of_study": "",
      "institution": "",
      "location": "",
      "start_date": "",
      "end_date": "",
      "graduation_date": "",
      "honors": ""
    }
  ],
  "skills": {
    "technical_skills": [],
    "soft_skills": [],
    "tools": [],
    "programming_languages": [],
    "frameworks": [],
    "platforms": [],
    "industry_skills": []
  },
  "certifications": [
    {
      "name": "",
      "issuer": "",
      "issue_date": "",
      "expiration_date": "",
      "credential_id": "",
      "credential_url": ""
    }
  ],
  "projects": [
    {
      "name": "",
      "description": "",
      "role": "",
      "technologies": [],
      "outcomes": [],
      "url": ""
    }
  ],
  "awards": [],
  "publications": [],
  "languages": [],
  "volunteer_experience": [],
  "missing_or_uncertain_information": []
}`;

export async function parseStructuredResume(
  text: string,
  facts: Fact[],
  opts: { preferLlm?: boolean; client?: LlmClient | null } = {}
): Promise<StructuredResumeParseResult> {
  if (opts.preferLlm) {
    const client = opts.client === undefined ? getLlmClient() : opts.client;
    if (client) {
      try {
        const data = await parseStructuredResumeLLM(text, client);
        return { data, method: "llm", warnings: [] };
      } catch (err) {
        return {
          data: structuredResumeFromFacts(text, facts),
          method: "heuristic",
          warnings: [`AI structured parsing failed (${safeMessage(err)}); used the local parser.`],
        };
      }
    }
  }
  return { data: structuredResumeFromFacts(text, facts), method: "heuristic", warnings: [] };
}

export async function parseStructuredResumeLLM(
  text: string,
  client: LlmClient
): Promise<ParsedResumeData> {
  const prompt = `${STRUCTURED_RESUME_PROMPT}\n\nResume text:\n<resume>\n${text}\n</resume>`;
  const raw = await cachedComplete(getDefaultLlmCache(), client, "structured-parse@v1", prompt, {
    system: STRUCTURED_RESUME_SYSTEM,
    maxTokens: 8192,
    feature: "structured-parse",
    validate: (t) => void ParsedResumeDataSchema.parse(extractJson(t)),
  });
  return ParsedResumeDataSchema.parse(extractJson(raw));
}

export function structuredResumeFromFacts(text: string, facts: Fact[]): ParsedResumeData {
  const extracted = extractProfileFromResume(facts, text);
  const name = [extracted.legalFirstName, extracted.preferredName, extracted.legalLastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  const location = [extracted.city, extracted.state].filter(Boolean).join(", ");
  const summary = facts
    .filter((f): f is GenericFact => f.type === "summary_point")
    .map((f) => f.statement)
    .join(" ");
  const skills = facts
    .filter((f): f is GenericFact => f.type === "skill")
    .map((f) => f.statement);

  return ParsedResumeDataSchema.parse({
    personal_information: {
      full_name: name,
      email: extracted.email ?? "",
      phone: extracted.phone ?? "",
      location,
      linkedin: extracted.linkedin ?? "",
      github: extracted.github ?? "",
      portfolio: extracted.portfolio ?? "",
      other_links: [],
    },
    professional_summary: summary,
    work_experience: facts
      .filter((f): f is EmploymentFact => f.type === "employment")
      .map((f) => {
        const { responsibilities, achievements } = splitBullets(f.bullets);
        return {
          job_title: f.title,
          company: f.employer,
          location: f.location ?? "",
          start_date: f.startDate,
          end_date: f.endDate === "present" ? "" : f.endDate,
          is_current: f.endDate === "present",
          responsibilities,
          achievements,
          technologies_or_tools: [],
        };
      }),
    education: facts
      .filter((f): f is EducationFact => f.type === "education")
      .map((f) => ({
        degree: f.degree,
        field_of_study: f.field ?? "",
        institution: f.institution,
        location: "",
        start_date: "",
        end_date: "",
        graduation_date: f.graduationDate ?? "",
        honors: "",
      })),
    skills: { technical_skills: skills },
    certifications: facts
      .filter((f): f is CertificationFact => f.type === "certification")
      .map((f) => ({
        name: f.name,
        issuer: f.issuer ?? "",
        issue_date: f.dateEarned ?? "",
        expiration_date: "",
        credential_id: "",
        credential_url: "",
      })),
    projects: [],
    awards: [],
    publications: [],
    languages: facts
      .filter((f): f is GenericFact => f.type === "language")
      .map((f) => f.statement),
    volunteer_experience: [],
    missing_or_uncertain_information: [],
  });
}

export function structuredResumeToFacts(data: ParsedResumeData): Fact[] {
  const facts: Fact[] = [];
  const pi = data.personal_information;
  for (const value of [pi.email, pi.phone, pi.linkedin, pi.github, pi.portfolio, ...pi.other_links]) {
    if (value.trim()) facts.push(genericFact("contact", value.trim(), value.trim()));
  }
  if (data.professional_summary.trim()) {
    facts.push(genericFact("summary_point", data.professional_summary.trim(), data.professional_summary.trim()));
  }
  for (const job of data.work_experience) {
    if (!job.job_title && !job.company) continue;
    const bullets = uniqueStrings([...job.responsibilities, ...job.achievements]);
    facts.push({
      id: randomUUID(),
      type: "employment",
      approved: false,
      sourceText: [job.job_title, job.company, job.start_date, job.end_date || (job.is_current ? "present" : "")]
        .filter(Boolean)
        .join(" | "),
      employer: job.company || "Unknown employer",
      title: job.job_title || "Unknown title",
      startDate: job.start_date,
      endDate: job.is_current ? "present" : job.end_date,
      ...(job.location ? { location: job.location } : {}),
      bullets,
    });
    // Achievements already live inside `bullets` above — do NOT re-emit them as standalone
    // achievement facts, or the same claim appears twice in the review ledger.
    for (const tool of job.technologies_or_tools) {
      facts.push(genericFact("skill", tool, tool));
    }
  }
  for (const ed of data.education) {
    if (!ed.degree && !ed.institution) continue;
    facts.push({
      id: randomUUID(),
      type: "education",
      approved: false,
      sourceText: [ed.degree, ed.field_of_study, ed.institution].filter(Boolean).join(" | "),
      institution: ed.institution,
      degree: ed.degree,
      ...(ed.field_of_study ? { field: ed.field_of_study } : {}),
      ...(ed.graduation_date || ed.end_date ? { graduationDate: ed.graduation_date || ed.end_date } : {}),
    });
  }
  const skillGroups = data.skills;
  for (const skill of uniqueStrings([
    ...skillGroups.technical_skills,
    ...skillGroups.soft_skills,
    ...skillGroups.tools,
    ...skillGroups.programming_languages,
    ...skillGroups.frameworks,
    ...skillGroups.platforms,
    ...skillGroups.industry_skills,
  ])) {
    facts.push(genericFact("skill", skill, skill));
  }
  for (const cert of data.certifications) {
    if (!cert.name) continue;
    facts.push({
      id: randomUUID(),
      type: "certification",
      approved: false,
      sourceText: [cert.name, cert.issuer, cert.issue_date].filter(Boolean).join(" | "),
      name: cert.name,
      ...(cert.issuer ? { issuer: cert.issuer } : {}),
      ...(cert.issue_date ? { dateEarned: cert.issue_date } : {}),
    });
  }
  for (const project of data.projects) {
    if (!project.name && !project.description) continue;
    const statement = [project.name, project.description, ...project.outcomes].filter(Boolean).join(" — ");
    facts.push(genericFact("achievement", statement, statement));
    for (const tech of project.technologies) facts.push(genericFact("skill", tech, tech));
  }
  for (const award of data.awards) facts.push(genericFact("achievement", award, award));
  for (const pub of data.publications) facts.push(genericFact("achievement", pub, pub));
  for (const lang of data.languages) facts.push(genericFact("language", lang, lang));
  for (const volunteer of data.volunteer_experience) {
    facts.push(genericFact("achievement", volunteer, volunteer));
  }
  return dedupeFacts(facts);
}

export function dedupeFacts(facts: Fact[]): Fact[] {
  const seen = new Set<string>();
  const out: Fact[] = [];
  for (const fact of facts) {
    const key = factKey(fact);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(fact);
  }
  return out;
}

function genericFact(type: GenericFact["type"], statement: string, sourceText: string): GenericFact {
  return { id: randomUUID(), type, approved: false, statement, sourceText };
}

function factKey(f: Fact): string {
  switch (f.type) {
    case "employment":
      return `employment:${norm(f.title)}:${norm(f.employer)}:${norm(f.startDate)}`;
    case "education":
      return `education:${norm(f.degree)}:${norm(f.institution)}:${norm(f.graduationDate ?? "")}`;
    case "certification":
      return `certification:${norm(f.name)}:${norm(f.issuer ?? "")}`;
    default:
      return `${f.type}:${norm(f.statement)}`;
  }
}

function splitBullets(bullets: string[]): { responsibilities: string[]; achievements: string[] } {
  const responsibilities: string[] = [];
  const achievements: string[] = [];
  for (const bullet of bullets) {
    if (/\d|%|\b(increased|reduced|saved|grew|improved|launched|shipped|delivered|won|led)\b/i.test(bullet)) {
      achievements.push(bullet);
    } else {
      responsibilities.push(bullet);
    }
  }
  return { responsibilities, achievements };
}

function uniqueStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const clean = item.trim();
    const key = norm(clean);
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

function norm(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function safeMessage(err: unknown): string {
  return String(err instanceof Error ? err.message : err).replace(/\s+/g, " ").slice(0, 160);
}
