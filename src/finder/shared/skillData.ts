/**
 * Skill and certification vocabulary spanning the 10 user tracks (§3).
 *
 * Used on the JOB side (requirement extraction from a posting) and, via
 * `canonicalSkillKey`, reconciled against the RÉSUMÉ side at match time. The two
 * sides do NOT come from the same extractor — the résumé side is free text from
 * the parser/insights — so an exact string compare misses real matches
 * ("Microsoft Excel" vs "Excel", "Node.js" vs "node", "JS" vs "JavaScript").
 * `canonicalSkillKey` folds both spellings to one key so matching is honest.
 * Matching is case-insensitive on word boundaries. Growing these lists (and the
 * alias table) improves both parsing recall and scoring quality with no code change.
 */

/** Skills/tools across tracks: finance, tech, healthcare, admin, trades, sales, support. */
export const SKILL_DICTIONARY: string[] = [
  // finance / compliance
  'AML',
  'KYC',
  'CDD',
  'EDD',
  'OFAC',
  'BSA',
  'FinCEN',
  'sanctions screening',
  'transaction monitoring',
  'fraud investigation',
  'SAR filing',
  'risk assessment',
  'regulatory compliance',
  'audit',
  'financial analysis',
  'reconciliation',
  'GAAP',
  'accounts payable',
  'accounts receivable',
  'payroll',
  'QuickBooks',
  'SAP',
  'bookkeeping',
  // tech
  'Python',
  'TypeScript',
  'JavaScript',
  'Java',
  'C++',
  'C#',
  'Go',
  'Rust',
  'SQL',
  'NoSQL',
  'React',
  'Node.js',
  'AWS',
  'Azure',
  'GCP',
  'Docker',
  'Kubernetes',
  'Terraform',
  'Linux',
  'Git',
  'CI/CD',
  'REST APIs',
  'GraphQL',
  'machine learning',
  'data analysis',
  // office / admin
  'Microsoft Excel',
  'Excel',
  'Microsoft Word',
  'Microsoft Office',
  'PowerPoint',
  'Outlook',
  'Google Workspace',
  'data entry',
  'calendar management',
  'travel coordination',
  'filing',
  'record keeping',
  'scheduling',
  'front desk',
  'office management',
  'typing',
  // healthcare
  'HIPAA',
  'Epic',
  'Cerner',
  'medical terminology',
  'medical billing',
  'medical coding',
  'ICD-10',
  'CPT coding',
  'patient scheduling',
  'insurance verification',
  'phlebotomy',
  'vital signs',
  'patient care',
  'EHR',
  'EMR',
  'prior authorization',
  'charting',
  // blue-collar / hourly
  'forklift operation',
  'forklift',
  'pallet jack',
  'inventory management',
  'order picking',
  'shipping and receiving',
  'warehouse operations',
  'OSHA compliance',
  'machine operation',
  'quality inspection',
  'assembly',
  'welding',
  'HVAC',
  'electrical wiring',
  'plumbing',
  'delivery driving',
  'route planning',
  'equipment maintenance',
  'safety procedures',
  // sales
  'Salesforce',
  'CRM',
  'lead generation',
  'cold calling',
  'prospecting',
  'account management',
  'territory management',
  'quota attainment',
  'contract negotiation',
  'upselling',
  'pipeline management',
  'HubSpot',
  'B2B sales',
  'closing',
  // customer support
  'Zendesk',
  'ServiceNow',
  'ticketing systems',
  'live chat support',
  'call center operations',
  'conflict resolution',
  'de-escalation',
  'customer retention',
  'CSAT',
  'phone support',
  // government / general
  'FOIA',
  'records management',
  'grant writing',
  'policy analysis',
  'procurement',
  'security clearance',
  'case management',
  'public speaking',
  'project management',
  'team leadership',
  'training and development',
  'budget management',
  'vendor management',
  'customer service',
  'communication',
  'problem solving',
  'time management',
  'bilingual',
  'Spanish',
  'inventory control',
  'POS systems',
  'cash handling',
  'merchandising',
];

/** Certifications & licenses across tracks. */
export const CERTIFICATION_DICTIONARY: string[] = [
  // finance
  'CAMS',
  'CFE',
  'CPA',
  'CFA',
  'CRCM',
  'Series 7',
  'Series 63',
  'Series 66',
  'FRM',
  // tech
  'AWS Certified Solutions Architect',
  'AWS Certified Developer',
  'CompTIA A+',
  'CompTIA Security+',
  'CompTIA Network+',
  'CISSP',
  'CISM',
  'CKA',
  'Azure Administrator',
  // healthcare
  'RN license',
  'RN',
  'LPN',
  'CNA',
  'BLS',
  'ACLS',
  'CPR certified',
  'CPR',
  'CMA',
  'CPC',
  'RHIT',
  'pharmacy technician license',
  'CPhT',
  // trades / hourly
  'CDL Class A',
  'CDL Class B',
  'CDL',
  'forklift certification',
  'forklift certified',
  'OSHA 10',
  'OSHA 30',
  'EPA 608',
  'journeyman electrician license',
  'ServSafe',
  'TWIC card',
  'crane operator certification',
  // office / pm / other
  'PMP',
  'CAPM',
  'Six Sigma Green Belt',
  'Six Sigma Black Belt',
  'Lean Six Sigma',
  'SHRM-CP',
  'PHR',
  'notary public',
  'paralegal certificate',
  'teaching license',
  'real estate license',
  'insurance license',
];

/** Case-insensitive word-boundary dictionary matcher used on both sides. */
export function dictionaryMatches(text: string, dictionary: string[]): string[] {
  const hits: string[] = [];
  for (const term of dictionary) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'i');
    if (pattern.test(text)) hits.push(term);
  }
  return hits;
}

/**
 * Synonym → canonical key table, keyed on the NORMALIZED surface form (lowercase,
 * apostrophes dropped, ".js"→"js", hyphens/commas→space, "microsoft "/"ms " prefix
 * stripped, whitespace collapsed). Collapses spellings the job dictionary and a
 * résumé are each likely to use for the SAME skill. Additive: unknown skills pass
 * through as their normalized form, so unfamiliar domains still match themselves.
 */
const SKILL_KEY_ALIASES: Record<string, string> = {
  js: 'javascript',
  ecmascript: 'javascript',
  ts: 'typescript',
  py: 'python',
  golang: 'go',
  reactjs: 'react',
  'react js': 'react',
  nodejs: 'node',
  'node js': 'node',
  'node': 'node',
  k8s: 'kubernetes',
  postgres: 'postgresql',
  'google cloud': 'gcp',
  'google cloud platform': 'gcp',
  'rest api': 'rest api',
  'rest apis': 'rest api',
  'restful api': 'rest api',
  'restful apis': 'rest api',
  'restful services': 'rest api',
  'ci cd': 'ci/cd',
  cicd: 'ci/cd',
  'anti money laundering': 'aml',
  'know your customer': 'kyc',
  'customer due diligence': 'cdd',
  'enhanced due diligence': 'edd',
  'suspicious activity report': 'sar filing',
  'sar filing': 'sar filing',
  'transaction monitoring': 'transaction monitoring',
  'sanctions screening': 'sanctions screening',
  'accounts payable': 'accounts payable',
  ap: 'accounts payable',
  'accounts receivable': 'accounts receivable',
  ar: 'accounts receivable',
  excel: 'excel',
  'office 365': 'office',
  o365: 'office',
  m365: 'office',
  'g suite': 'google workspace',
  gsuite: 'google workspace',
};

/**
 * Fold a surface skill string to a canonical key so the job side and the résumé
 * side compare on the same token. Deterministic and offline; no dictionary lookup
 * required (unknown skills return their own normalized form).
 */
export function canonicalSkillKey(raw: string): string {
  let s = raw.toLowerCase().trim();
  if (!s) return '';
  s = s.replace(/[’']/g, ''); // drop apostrophes: "member's" → "members"
  s = s.replace(/\.js\b/g, 'js'); // node.js → nodejs
  s = s.replace(/\s*\/\s*/g, '/'); // "ci / cd" → "ci/cd"
  s = s.replace(/[-.,]/g, ' '); // hyphens/dots/commas → space (keeps + and # for c++/c#)
  s = s.replace(/^(?:microsoft|ms)\s+/, ''); // vendor prefix that doesn't change identity
  s = s.replace(/\s+/g, ' ').trim();
  return SKILL_KEY_ALIASES[s] ?? s;
}

/** Dedupe surface terms by their canonical key, keeping the first spelling seen. */
export function dedupeByCanonicalSkill(terms: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of terms) {
    const key = canonicalSkillKey(term);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}
