// src/insights/skill-gap.ts
//
// Skill-gap insight: aggregate the keywords the market is asking for across the discovered jobs that
// carry a REAL job description, then diff against what the approved ledger can actually back up. The
// output is the user's highest-leverage learning/positioning list — "9 of your matched roles want
// Tableau; your ledger never mentions it." Read-only and deterministic; it never changes a document.
//
// We deliberately ignore the scoring `rationale` (templated meta-text like "title matches a target
// role | matches skills: …") — aggregating it floods the gaps with boilerplate ("title", "overlap",
// "location"). Only the employer's own posting text is a trustworthy demand signal, so a job with no
// captured description contributes nothing rather than noise.

import type { Fact, FactsLedger } from "../types/facts-ledger";
import { parsePosting } from "../generation/posting";

export interface SkillGapJob {
  title: string;
  /** Full job-description text from discovery. Jobs without one are not analyzed. */
  description?: string;
}

export interface SkillGapTerm {
  term: string;
  /** How many of the analyzed jobs surface this term. */
  jobCount: number;
}

export interface SkillGapReport {
  /** Count of jobs that had a usable description and actually fed the analysis. */
  jobsAnalyzed: number;
  /** Demanded across jobs but NOT supported by the approved ledger — ranked by demand. */
  topGaps: SkillGapTerm[];
  /** Demanded across jobs AND already in the ledger — what's working, for reassurance. */
  topMatched: SkillGapTerm[];
}

/** A description must have real substance to be worth parsing. */
const MIN_DESCRIPTION_LEN = 40;

// Boilerplate that shows up in postings but is never a "skill": role/seniority labels, geography,
// employment terms, compensation, EEO/legal, and generic posting scaffolding. Filtering these is what
// separates an honest skill-gap list from a wall of noise.
const STOP = new Set([
  // function words / generic
  "the","and","for","with","you","your","our","their","this","that","they","will","are","has","have",
  "from","into","over","across","using","use","used","etc","via","per","not","but","can","may","must",
  "who","what","when","where","which","how","all","any","each","more","most","such","other","than",
  "able","ability","strong","excellent","good","great","proven","solid","plus","preferred","required",
  "requirements","qualifications","responsibilities","duties","experience","experienced","work","working",
  "knowledge","understanding","skills","skill","including","include","includes","well","high","highly",
  "new","key","role","roles","position","positions","job","jobs","opportunity","opportunities","candidate",
  "candidates","ideal","looking","seeking","hiring","join","joining","help","helping","make","making",
  "build","building","drive","driving","support","supporting","ensure","ensuring","deliver","delivering",
  // org / posting scaffolding
  "team","teams","company","companies","organization","organizations","business","department","group",
  "overview","summary","description","about","mission","vision","values","culture","people","world",
  "application","apply","applicant","applicants","employer","employee","employees","staff","member","members",
  // seniority / role labels
  "senior","junior","mid","entry","level","lead","leads","principal","staff","head","chief","officer",
  "manager","managers","management","director","directors","associate","coordinator","specialist","analyst",
  "engineer","engineers","engineering","intern","internship","contractor","consultant","developer","developers",
  // employment type
  "full","time","fulltime","part","parttime","contract","permanent","temporary","remote","hybrid","onsite",
  "office","location","locations","based","relocation","travel","shift","hours","week","day","days","year","years",
  // geography
  "united","states","usa","america","american","canada","canadian","kingdom","europe","european","city","cities","county","area",
  // compensation / legal / EEO
  "salary","compensation","pay","range","benefits","bonus","equity","insurance","paid","leave","health","dental",
  "equal","opportunity","employment","disability","veteran","gender","race","religion","sexual","orientation",
  "identity","national","origin","status","without","regard","applicable","law","laws","accommodation","accommodations",
  // common pitch/filler verbs, adverbs, and quantifiers — never a skill
  "built","build","builds","today","take","takes","taking","taken","every","everyone","everything","one","two",
  "three","first","second","next","last","grow","grows","growing","grew","grown","growth","get","gets","getting",
  "got","give","gives","given","want","wants","like","just","also","around","many","much","lot","lots","big","small",
  "thing","things","way","ways","make","made","makes","do","does","doing","done","go","goes","going","come","comes",
  "businesses","really","very","want","need","needs","love","passionate","exciting","fast","best","better","top",
  "future","impact","impactful","innovative","innovation","innovate","leaders","leader","leading","mission",
  "driven","passion","journey","cutting","edge","class","global","trusted","scale","scaling","scalable",
  "long","term","short","help","helps","provide","provides","providing","across","within","including",
]);

function isStop(t: string): boolean {
  return t.length <= 2 || STOP.has(t) || /^\d+$/.test(t);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9+#.\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * Distinct significant terms for one job. We parse the posting and prefer its REQUIREMENTS section
 * (skill-dense bullets like "5+ years of Python") over the full description, which is padded with
 * "About us" pitch copy. Falls back to the whole description when no requirements parse out.
 */
function jobTerms(job: SkillGapJob): Set<string> {
  const posting = parsePosting(job.description ?? "", { title: job.title });
  const source =
    posting.requirements.length > 0 ? `${job.title}\n${posting.requirements.join("\n")}` : `${job.title}\n${job.description ?? ""}`;
  const terms = new Set<string>();
  for (const t of tokenize(source)) {
    const norm = t.replace(/\.+$/, ""); // trim trailing dots first ("experience." -> "experience")
    if (norm && !isStop(norm)) terms.add(norm);
  }
  return terms;
}

/** Lowercased token set of everything the approved ledger can legitimately back. */
function ledgerTokens(ledger: FactsLedger): Set<string> {
  const tokens = new Set<string>();
  for (const f of ledger.facts) {
    if (!f.approved) continue;
    for (const t of tokenize(factStrings(f).join(" "))) {
      if (t.length > 2) tokens.add(t);
    }
  }
  return tokens;
}

function factStrings(f: Fact): string[] {
  switch (f.type) {
    case "employment":
      return [f.title, f.employer, f.location ?? "", ...f.bullets];
    case "education":
      return [f.degree, f.field ?? "", f.institution];
    case "certification":
      return [f.name, f.issuer ?? ""];
    case "metric":
      return [f.statement, f.unit ?? ""];
    default:
      return [f.statement];
  }
}

export function computeSkillGap(jobs: SkillGapJob[], ledger: FactsLedger): SkillGapReport {
  const analyzable = jobs.filter((j) => (j.description ?? "").trim().length >= MIN_DESCRIPTION_LEN);
  const have = ledgerTokens(ledger);

  // term -> set of job indices that surface it (so jobCount counts distinct jobs, not raw hits).
  const demand = new Map<string, Set<number>>();
  analyzable.forEach((job, i) => {
    for (const term of jobTerms(job)) {
      if (!demand.has(term)) demand.set(term, new Set());
      demand.get(term)!.add(i);
    }
  });

  const ranked = [...demand.entries()]
    .map(([term, jobsWith]) => ({ term, jobCount: jobsWith.size }))
    .sort((a, b) => b.jobCount - a.jobCount || a.term.localeCompare(b.term));

  const topGaps = ranked.filter((t) => !have.has(t.term)).slice(0, 12);
  const topMatched = ranked.filter((t) => have.has(t.term)).slice(0, 8);

  return { jobsAnalyzed: analyzable.length, topGaps, topMatched };
}
