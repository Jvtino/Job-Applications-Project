// src/jobs/taxonomy.ts
//
// Domain-general normalization for job-fit matching. Works for ANY résumé/posting — tech, finance,
// compliance, healthcare, legal, ops, sales, etc. — not a single industry. Three jobs:
//
//   1. canonicalize skills (alias + multi-word phrase aware) so "JS"/"Javascript", "AML"/"anti
//      money laundering", "txn monitoring"/"transaction monitoring" collapse to one signal, and
//      noise tokens ("built", "responsible", "team") are dropped.
//   2. detect role FAMILIES and INDUSTRY from a title/skill set (so a posting and a résumé can be
//      compared on function, not just words).
//   3. detect hard CREDENTIAL gates a posting states (licenses, named certs, degree level,
//      clearance, citizenship) — the inputs to deterministic hard filters.
//
// Everything is data-driven and additive: a skill not in the dictionary still passes through as its
// cleaned token, so unfamiliar domains degrade gracefully rather than disappearing.

import { seniorityLevel } from "./role-keywords";

export { seniorityLevel } from "./role-keywords";

// ----------------------------------------------------------------------------------------
// Skill canonicalization
// ----------------------------------------------------------------------------------------

// Multi-word skills/phrases worth preserving as a SINGLE canonical signal. Matched (longest-first)
// before single-token processing so "transaction monitoring" doesn't decay into "transaction".
const SKILL_PHRASES: Record<string, string> = {
  "anti money laundering": "aml",
  "anti-money laundering": "aml",
  "know your customer": "kyc",
  "customer due diligence": "cdd",
  "enhanced due diligence": "edd",
  "due diligence": "due diligence",
  "transaction monitoring": "transaction monitoring",
  "suspicious activity": "sar",
  "sanctions screening": "sanctions screening",
  "financial crime": "financial crime",
  "financial crimes": "financial crime",
  "client onboarding": "client onboarding",
  "regulatory reporting": "regulatory reporting",
  "risk assessment": "risk assessment",
  "internal controls": "internal controls",
  "financial analysis": "financial analysis",
  "financial modeling": "financial modeling",
  "accounts payable": "accounts payable",
  "accounts receivable": "accounts receivable",
  "general ledger": "general ledger",
  "machine learning": "machine learning",
  "deep learning": "deep learning",
  "data analysis": "data analysis",
  "data analytics": "data analytics",
  "data engineering": "data engineering",
  "data science": "data science",
  "data modeling": "data modeling",
  "business intelligence": "business intelligence",
  "natural language processing": "nlp",
  "computer vision": "computer vision",
  "project management": "project management",
  "program management": "program management",
  "product management": "product management",
  "change management": "change management",
  "stakeholder management": "stakeholder management",
  "agile methodologies": "agile",
  "supply chain": "supply chain",
  "quality assurance": "quality assurance",
  "quality control": "quality control",
  "customer success": "customer success",
  "customer service": "customer service",
  "account management": "account management",
  "business development": "business development",
  "lead generation": "lead generation",
  "digital marketing": "digital marketing",
  "content marketing": "content marketing",
  "social media": "social media marketing",
  "search engine optimization": "seo",
  "user experience": "ux",
  "user research": "user research",
  "patient care": "patient care",
  "clinical research": "clinical research",
  "electronic health records": "ehr",
  "revenue cycle": "revenue cycle",
  "human resources": "hr",
  "talent acquisition": "recruiting",
  "employee relations": "employee relations",
  "public speaking": "public speaking",
};

// Single-token aliases → canonical. Keep terse; everything else passes through cleaned.
const SKILL_ALIASES: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  py: "python",
  golang: "go",
  reactjs: "react",
  nodejs: "node",
  postgres: "postgresql",
  k8s: "kubernetes",
  ml: "machine learning",
  ai: "artificial intelligence",
  nlp: "nlp",
  aml: "aml",
  kyc: "kyc",
  cdd: "cdd",
  edd: "edd",
  bsa: "bsa",
  ofac: "sanctions screening",
  sar: "sar",
  fincrime: "financial crime",
  txn: "transaction monitoring",
  gaap: "gaap",
  ap: "accounts payable",
  ar: "accounts receivable",
  excel: "excel",
  sql: "sql",
  powerbi: "power bi",
  tableau: "tableau",
  ux: "ux",
  ui: "ui",
  seo: "seo",
  sem: "sem",
  crm: "crm",
  saas: "saas",
  b2b: "b2b",
  b2c: "b2c",
  ehr: "ehr",
  hr: "hr",
  pmp: "project management",
};

// Tokens that look skill-ish but carry no matching signal. Kept tight and domain-neutral.
const SKILL_STOP = new Set([
  "the","and","for","with","from","that","this","using","used","across","into","over","per","etc",
  "team","teams","work","working","experience","experienced","years","year","skills","skill","including",
  "ability","able","strong","excellent","good","great","proven","solid","plus","preferred","required",
  "requirements","qualifications","responsibilities","duties","knowledge","understanding","role","position",
  "job","company","candidate","candidates","ideal","looking","seeking","join","help","make","build","built",
  "drive","support","ensure","deliver","manage","managed","manager","management","lead","leads","leading","led",
  "responsible","responsibility","various","detail","oriented","fast","paced","environment","environments",
  "new","key","high","highly","etc","via","within","including","include","includes","well","more","most",
  "developed","develop","created","create","provide","provided","perform","performed","conduct","conducted",
  "you","your","our","their","they","will","are","has","have","had","not","but","can","may","must",
  "communication","communications","interpersonal","organizational","analytical","problem","solving","solver",
  // generic JD nouns that masquerade as skills and dilute required-skill coverage
  "documentation","document","documents","review","reviews","reviewing","process","processes",
  "procedure","procedures","project","projects","task","tasks","report","reports","meeting","meetings",
  "customer","client","customers","clients","vendor","vendors","partner","partners","file","files",
  "record","records","system","systems","tool","tools","platform","platforms","stakeholder","stakeholders",
  "initiative","initiatives","function","functions","area","areas","level","levels","quality","assurance",
  "business","department","departments","operation","operations","activity","activities","item","items",
  // industry / geography words that are matched by detectIndustries, never a skill on their own
  "bank","banking","services","institution","financial","company","firm","organization","enterprise",
]);

/** Clean a token: lowercase, strip punctuation, keep + and # (c++, c#). */
function cleanToken(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9+#.]/g, "").replace(/\.+$/, "");
}

/**
 * Map a single surface skill string to its canonical form, or null if it's noise. Handles
 * multi-word phrases, aliases, and plain cleaned tokens.
 */
export function canonicalSkill(raw: string): string | null {
  const lower = raw.toLowerCase().trim();
  if (!lower) return null;
  if (SKILL_PHRASES[lower]) return SKILL_PHRASES[lower]!;
  const tok = cleanToken(lower);
  if (!tok || tok.length < 2 || SKILL_STOP.has(tok) || /^\d+$/.test(tok)) return null;
  return SKILL_ALIASES[tok] ?? tok;
}

/**
 * Extract canonical skills from free text with frequency. Phrases are matched first (and removed)
 * so their tokens don't double-count, then remaining tokens are canonicalized.
 */
export function extractSkillsFromText(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  let hay = ` ${text.toLowerCase()} `;
  const bump = (name: string, by = 1) => counts.set(name, (counts.get(name) ?? 0) + by);

  // Longest phrases first so "enhanced due diligence" wins over "due diligence".
  const phrases = Object.keys(SKILL_PHRASES).sort((a, b) => b.length - a.length);
  for (const phrase of phrases) {
    const re = new RegExp(`(?<![a-z])${phrase.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}(?![a-z])`, "g");
    let n = 0;
    hay = hay.replace(re, () => {
      n++;
      return " ";
    });
    if (n) bump(SKILL_PHRASES[phrase]!, n);
  }

  for (const raw of hay.split(/\s+/)) {
    const c = canonicalSkill(raw);
    if (c) bump(c);
  }
  return counts;
}

// ----------------------------------------------------------------------------------------
// Role families (domain-general function buckets)
// ----------------------------------------------------------------------------------------

// Family → trigger keywords (matched against title + skill tokens). Order independent; a title can
// belong to several. Keys are stable identifiers used across scoring + the candidate profile.
const FAMILY_KEYWORDS: Record<string, string[]> = {
  engineering: ["engineer", "engineering", "developer", "swe", "programmer", "fullstack", "frontend", "backend", "software"],
  // NB: bare "analyst" is deliberately excluded — KYC/Compliance/Financial Analysts are not data
  // analysts. "warehouse" is excluded too (the physical sense); the "data warehouse" skill is matched
  // at the skill level, not the family level.
  data: ["data", "analytics", "scientist", "science", "etl", "ml", "statistician", "dbt"],
  product: ["product", "pm", "roadmap"],
  design: ["design", "designer", "ux", "ui", "creative"],
  finance: ["finance", "financial", "accounting", "accountant", "controller", "treasury", "fp&a", "audit", "auditor", "tax", "bookkeeper", "investment", "banking"],
  compliance: ["compliance", "aml", "kyc", "sanctions", "fraud", "risk", "regulatory", "bsa", "financial crime", "fincrime", "due diligence", "investigations", "investigator", "governance"],
  legal: ["legal", "counsel", "attorney", "paralegal", "contracts", "lawyer", "litigation"],
  healthcare: ["nurse", "clinical", "patient", "medical", "healthcare", "physician", "pharmacy", "therapist", "care"],
  marketing: ["marketing", "growth", "brand", "content", "seo", "demand", "communications", "social"],
  sales: ["sales", "account executive", "business development", "account manager", "revenue", "quota", "partnerships"],
  operations: ["operations", "ops", "operational"],
  logistics: ["logistics", "supply chain", "procurement", "fulfillment", "warehouse", "inventory", "forklift", "shipping", "distribution"],
  hr: ["recruiter", "recruiting", "talent", "human resources", "hr", "people", "benefits", "payroll"],
  customer_success: ["customer success", "customer support", "client services", "account management", "onboarding", "support"],
  security: ["security", "infosec", "cyber", "appsec", "soc", "siem"],
  infrastructure: ["devops", "sre", "platform", "infrastructure", "cloud", "reliability"],
  project_management: ["project manager", "program manager", "scrum", "delivery", "pmo"],
  administrative: ["administrative", "assistant", "coordinator", "receptionist", "clerk", "office manager"],
};

const FAMILY_STOP = new Set([
  "senior", "junior", "associate", "mid", "staff", "principal", "lead", "head", "director", "vp",
  "sr", "jr", "intern", "the", "and", "for", "of", "a", "an", "i", "ii", "iii",
]);

function familyTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9+#&\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !FAMILY_STOP.has(t));
}

/** Function families implied by a title (and optional extra skill text). Domain-general. */
export function roleFamilies(title: string, extraText = ""): Set<string> {
  const hay = ` ${title.toLowerCase()} ${extraText.toLowerCase()} `;
  const tokens = new Set(familyTokens(`${title} ${extraText}`));
  const out = new Set<string>();
  for (const [family, keywords] of Object.entries(FAMILY_KEYWORDS)) {
    for (const kw of keywords) {
      if (kw.includes(" ")) {
        if (hay.includes(` ${kw} `) || hay.includes(`${kw}`)) {
          out.add(family);
          break;
        }
      } else if (tokens.has(kw)) {
        out.add(family);
        break;
      }
    }
  }
  return out;
}

// ----------------------------------------------------------------------------------------
// Industry detection
// ----------------------------------------------------------------------------------------

const INDUSTRY_HINTS: { industry: string; re: RegExp }[] = [
  { industry: "financial services", re: /\b(bank|banking|fintech|payments|lending|brokerage|capital markets|asset management|insurance|trading|hedge fund|financial institution)\b/i },
  { industry: "healthcare", re: /\b(hospital|clinic|patient|health system|pharma|biotech|medical device|payer|provider|ehr)\b/i },
  { industry: "technology", re: /\b(saas|software|platform|cloud|developer|api|infrastructure|startup)\b/i },
  { industry: "ecommerce/retail", re: /\b(retail|ecommerce|e-commerce|marketplace|consumer goods|merchandising)\b/i },
  { industry: "government/public", re: /\b(government|public sector|federal|municipal|agency|defense)\b/i },
  { industry: "consulting", re: /\b(consulting|advisory|professional services)\b/i },
  { industry: "manufacturing/industrial", re: /\b(manufacturing|industrial|automotive|aerospace|logistics|supply chain)\b/i },
  { industry: "education", re: /\b(education|university|edtech|school|academic)\b/i },
];

/** Best-effort industry labels present in arbitrary text (title + description). */
export function detectIndustries(text: string): string[] {
  const out: string[] = [];
  for (const { industry, re } of INDUSTRY_HINTS) if (re.test(text)) out.push(industry);
  return out;
}

// ----------------------------------------------------------------------------------------
// Credential gates (licenses, named certs, degree level, clearance, citizenship)
// ----------------------------------------------------------------------------------------

export interface CredentialRequirements {
  /** Named professional licenses/certs the posting requires (CPA, Series 7, RN, PE, bar, …). */
  requiredCredentials: string[];
  /** Minimum degree level required, 0..5 (none/assoc/bachelor/master/doctorate/professional). */
  requiredDegreeLevel: number;
  requiresSecurityClearance: boolean;
  requiresUsCitizenship: boolean;
}

// Each: a label, a detector for the credential being MENTIONED, and the "required" qualifier nearby.
const CREDENTIALS: { label: string; re: RegExp }[] = [
  { label: "CPA", re: /\bcpa\b|\bcertified public accountant\b/i },
  { label: "CFA", re: /\bcfa\b|\bchartered financial analyst\b/i },
  { label: "CAMS", re: /\bcams\b|\bcertified anti-money laundering\b/i },
  { label: "Series 7", re: /\bseries\s*7\b/i },
  { label: "Series 63", re: /\bseries\s*63\b/i },
  { label: "bar admission", re: /\b(member of the bar|bar admission|admitted to the bar|jd required|juris doctor)\b/i },
  { label: "PE license", re: /\b(professional engineer|pe license|p\.e\.)\b/i },
  { label: "RN license", re: /\b(registered nurse|rn license|\brn\b)\b/i },
  { label: "PMP", re: /\bpmp\b|\bproject management professional\b/i },
  { label: "CISSP", re: /\bcissp\b/i },
  { label: "medical license", re: /\b(medical license|md required|board certified)\b/i },
  { label: "CDL", re: /\b(commercial driver|cdl)\b/i },
];

const REQUIRED_NEAR = /\b(required|must have|must possess|active|current|valid|hold a|holds? an?)\b/i;

const DEGREE_LEVELS: { level: number; re: RegExp }[] = [
  { level: 5, re: /\b(jd|juris doctor|md|professional degree)\b/i },
  { level: 4, re: /\b(phd|ph\.d|doctorate|doctoral)\b/i },
  { level: 3, re: /\b(master'?s|mba|m\.s|m\.a|graduate degree)\b/i },
  { level: 2, re: /\b(bachelor'?s|b\.s|b\.a|undergraduate degree|4-year degree|four year degree|college degree)\b/i },
  { level: 1, re: /\b(associate'?s degree|a\.a|a\.s)\b/i },
];

const DEGREE_REQUIRED_NEAR = /\b(required|must|minimum|need a|hold a|degree in|degree or)\b/i;

/** Parse the hard credential/degree/clearance gates a posting states. */
export function detectCredentialRequirements(text: string): CredentialRequirements {
  const requiredCredentials: string[] = [];
  for (const { label, re } of CREDENTIALS) {
    const m = re.exec(text);
    if (!m) continue;
    // Only treat as REQUIRED when a "required/active/valid" qualifier sits in the same sentence.
    const window = text.slice(Math.max(0, m.index - 80), m.index + 80);
    if (REQUIRED_NEAR.test(window)) requiredCredentials.push(label);
  }

  let requiredDegreeLevel = 0;
  for (const { level, re } of DEGREE_LEVELS) {
    const m = re.exec(text);
    if (m) {
      const window = text.slice(Math.max(0, m.index - 60), m.index + 60);
      if (DEGREE_REQUIRED_NEAR.test(window)) {
        requiredDegreeLevel = level;
        break;
      }
    }
  }

  return {
    requiredCredentials: [...new Set(requiredCredentials)],
    requiredDegreeLevel,
    requiresSecurityClearance: /\b(clearance|ts\/sci|top secret|secret clearance|polygraph|public trust)\b/i.test(text),
    requiresUsCitizenship: /\b(must be a (us|u\.s\.) citizen|us citizenship required|citizenship is required)\b/i.test(text),
  };
}

/** Degree level the candidate holds (0..5) from their education strings. */
export function degreeLevelOf(degreeText: string): number {
  for (const { level, re } of DEGREE_LEVELS) if (re.test(degreeText)) return level;
  return 0;
}

void seniorityLevel; // re-exported above; referenced to keep the import meaningful.
