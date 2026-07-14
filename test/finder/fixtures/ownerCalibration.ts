/**
 * Owner calibration fixture (real profile: AML / Financial Crime Analyst, ~2 yrs,
 * NYC hybrid/onsite, CAMS in progress, BS degree). Used to tune scorecard-v2 to
 * the owner's own judgment for the finance_compliance track.
 *
 * The `rating` on each posting is the EXPECTED band a careful reviewer (the owner)
 * would give. The bootstrap set below is my best estimate spanning strong→bad; the
 * owner corrects these, and the corrected labels become the assertions in
 * ownerCalibration.test.ts. Postings use dictionary-spelled skills + real headings
 * so extractJobSignals splits required vs. preferred the way a live posting would.
 */
import type { MatchLabel, ParsedResumeProfile } from '../../../src/finder/shared';
import type { ScorableJob, ScoringPreferences } from '../../../src/finder/scoring';

/** The owner's résumé projected to the scorer's profile shape (post education-threading). */
export const OWNER_PROFILE: ParsedResumeProfile = {
  name: 'Haci Ahmet Ilhan',
  location: 'Brooklyn, NY',
  email: null,
  phone: null,
  summary: null,
  workHistory: [],
  jobTitles: ['AML & Risk Analyst', 'AML Analyst'],
  companies: ['London Stock Exchange Group'],
  skills: [
    'AML',
    'KYC',
    'CDD',
    'EDD',
    'OFAC',
    'sanctions screening',
    'SAR filing',
    'risk assessment',
    'regulatory compliance',
    'BSA',
    'FinCEN',
    'audit',
    'case management',
    'transaction monitoring',
    'adverse media',
    'PEP screening',
    'beneficial ownership',
    'Microsoft Excel',
    'Power BI',
    'Power Query',
    'World-Check One',
    'OSINT',
  ],
  tools: [],
  certifications: ['CAMS'],
  education: [
    {
      degree: 'Bachelor of Science in International Business Management',
      institution: 'Beykent University',
      year: '2023',
    },
  ],
  industries: ['banking', 'financial services'],
  yearsExperience: 2,
  achievements: [],
  languages: ['Turkish', 'English'],
  workAuthorizationStatus: 'US Citizen',
};

export const OWNER_PREFS: ScoringPreferences = {
  track: 'finance_compliance',
  targetTitles: [
    'AML Analyst',
    'KYC Analyst',
    'Financial Crime Analyst',
    'Compliance Analyst',
    'EDD Analyst',
    'Sanctions Analyst',
    'Financial Crimes Investigator',
  ],
  excludedTitles: [],
  preferredLocations: ['New York, NY'],
  remotePreferences: ['hybrid', 'onsite'], // remote is NOT preferred → soft-penalized
  salaryMin: 65000,
  industries: ['banking', 'fintech', 'financial services'],
};

export interface OwnerCase {
  name: string;
  /** Owner's expected band (bootstrap estimate until corrected). */
  rating: MatchLabel;
  job: ScorableJob;
}

const DAYS = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAYS).toISOString();

function job(over: Partial<ScorableJob> & { title: string; descriptionClean: string }): ScorableJob {
  return {
    company: 'Company',
    locationNormalized: 'new york, ny',
    remoteType: 'hybrid',
    salaryMin: null,
    salaryMax: null,
    salaryPeriod: 'year',
    postedAt: ago(6),
    sourceType: 'ats_greenhouse',
    ...over,
  };
}

export const OWNER_CASES: OwnerCase[] = [
  {
    name: 'on-target KYC analyst, hybrid NYC',
    rating: 'strong',
    job: job({
      title: 'KYC Analyst',
      company: 'Meridian Bank',
      descriptionClean:
        'Join our financial crimes unit.\nRequirements\n2+ years of experience with KYC, CDD, EDD, AML, and sanctions screening. Bachelor degree required.\nPreferred qualifications\nCAMS certification and transaction monitoring exposure.',
      locationNormalized: 'new york, ny',
      salaryMin: 70000,
      salaryMax: 85000,
    }),
  },
  {
    name: 'AML investigator, fintech hybrid',
    rating: 'strong',
    job: job({
      title: 'AML Investigator',
      company: 'Corebank Fintech',
      descriptionClean:
        'Requirements\n2+ years of experience in AML investigations, KYC, EDD, OFAC, and SAR filing. Regulatory compliance background. Bachelor degree.\nNice to have\nCAMS.',
      locationNormalized: 'new york, ny',
      salaryMin: 75000,
      salaryMax: 90000,
    }),
  },
  {
    name: 'financial crimes analyst, onsite',
    rating: 'strong',
    job: job({
      title: 'Financial Crimes Analyst',
      company: 'Hudson Trust',
      descriptionClean:
        'Requirements\n2+ years of experience across KYC, AML, sanctions screening, and risk assessment. Adverse media and PEP screening. Bachelor degree.',
      locationNormalized: 'new york, ny',
      remoteType: 'onsite',
      salaryMin: 68000,
      salaryMax: 80000,
    }),
  },
  {
    name: 'entry KYC associate, 1+ yr (early-career fit)',
    rating: 'strong', // no experience gap → an entry role with full skills is a top match
    job: job({
      title: 'KYC Associate',
      company: 'Onboarding Fintech',
      descriptionClean:
        'Requirements\n1+ years of experience with KYC, CDD, AML, and sanctions screening. Bachelor degree. Entry level welcome.',
      locationNormalized: 'new york, ny',
      salaryMin: 62000,
      salaryMax: 72000,
    }),
  },
  {
    name: 'sanctions analyst, 3+ yrs (near-miss experience)',
    rating: 'strong', // owner (loosened): a 1-yr stretch with full skills stays strong

    job: job({
      title: 'Sanctions Analyst',
      company: 'Gotham Payments',
      descriptionClean:
        'Requirements\n3+ years of experience in sanctions screening, OFAC, and transaction monitoring. KYC and AML knowledge. Bachelor degree required.\nPreferred qualifications\nCAMS.',
      locationNormalized: 'new york, ny',
      salaryMin: 80000,
      salaryMax: 95000,
    }),
  },
  {
    name: 'compliance analyst, broader (adjacent)',
    rating: 'strong', // owner (loosened): asks 3, full skills → strong
    job: job({
      title: 'Compliance Analyst',
      company: 'Prairie Asset Management',
      descriptionClean:
        'Requirements\n3+ years of regulatory compliance experience. Policy analysis, audit readiness, some AML/KYC exposure. Bachelor degree.',
      locationNormalized: 'new york, ny',
      salaryMin: 72000,
      salaryMax: 85000,
    }),
  },
  {
    name: 'remote AML analyst (mode mismatch)',
    rating: 'good', // owner: remote is only a small ding off an otherwise-perfect match
    job: job({
      title: 'AML Analyst',
      company: 'Remote Compliance Co',
      descriptionClean:
        'Requirements\n2+ years of experience with AML, KYC, EDD, and sanctions screening. Bachelor degree.',
      locationNormalized: 'remote',
      remoteType: 'remote',
      salaryMin: 70000,
      salaryMax: 82000,
    }),
  },
  {
    name: 'KYC analyst in Stamford CT (location mismatch)',
    rating: 'good', // owner: a far-but-commutable onsite role is only a small ding
    job: job({
      title: 'KYC Analyst',
      company: 'Charter Financial',
      descriptionClean:
        'Requirements\n2+ years of experience with KYC, CDD, AML, and sanctions screening. Bachelor degree.',
      locationNormalized: 'stamford, ct',
      remoteType: 'onsite',
      salaryMin: 68000,
      salaryMax: 78000,
    }),
  },
  {
    name: 'senior AML analyst, 5+ yrs (seniority stretch)',
    rating: 'good', // owner (loosened): a 3-yr stretch reads good, not possible
    job: job({
      title: 'Senior AML Analyst',
      company: 'Empire Bancorp',
      descriptionClean:
        'Requirements\n5+ years of experience in AML, KYC, and sanctions screening. Team leadership. CAMS required. Bachelor degree.',
      locationNormalized: 'new york, ny',
      salaryMin: 95000,
      salaryMax: 115000,
    }),
  },
  {
    name: 'BSA/AML officer, 8+ yrs (well over level)',
    rating: 'weak',
    job: job({
      title: 'BSA/AML Officer',
      company: 'Community Savings Bank',
      descriptionClean:
        'Requirements\n8+ years of experience managing a BSA/AML program. Officer-level ownership, regulatory exam management. CAMS required. Bachelor degree.',
      locationNormalized: 'new york, ny',
      remoteType: 'onsite',
      salaryMin: 120000,
      salaryMax: 145000,
    }),
  },
  {
    name: 'fraud analyst, chargebacks (adjacent but off-skill)',
    rating: 'weak',
    job: job({
      title: 'Fraud Analyst',
      company: 'Retail Bank USA',
      descriptionClean:
        'Requirements\n2+ years handling card fraud, chargebacks, and dispute resolution. Customer service. High school diploma.',
      locationNormalized: 'new york, ny',
      remoteType: 'onsite',
      salaryMin: 55000,
      salaryMax: 65000,
    }),
  },
  {
    name: 'staff accountant (wrong function)',
    rating: 'bad',
    job: job({
      title: 'Staff Accountant',
      company: 'Franklin CPA Group',
      descriptionClean:
        'Requirements\nGAAP, reconciliation, accounts payable, month-end close. CPA track. Bachelor degree required.',
      locationNormalized: 'new york, ny',
      remoteType: 'onsite',
      salaryMin: 65000,
      salaryMax: 75000,
    }),
  },
  {
    name: 'unrelated: registered nurse',
    rating: 'bad',
    job: job({
      title: 'Registered Nurse — Med Surg',
      company: 'NYC Health',
      descriptionClean:
        'Requirements\nActive RN license, BLS, ACLS. 2+ years of bedside patient care.',
      locationNormalized: 'new york, ny',
      remoteType: 'onsite',
      salaryMin: 90000,
      salaryMax: 110000,
    }),
  },
];
