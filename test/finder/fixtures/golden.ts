/**
 * Golden scoring corpus (plan §6 M8, §9 R2): hand-labeled (profile, job,
 * expected_label) triples — 12 per track × 10 tracks. Labels reflect how a
 * careful human recruiter in that track would band the match, deliberately
 * including the §24 edge cases (missing salary, missing location, wrong
 * seniority, wrong location, missing required certification).
 *
 * CI gate (goldenCorpus.test.ts): ≥90% within ±1 band, and NO pair labeled
 * 'bad' may score ≥70 (bad-as-good is the trust-killing failure).
 */
import type { MatchLabel, ParsedResumeProfile, Track } from '../../../src/finder/shared';
import type { ScorableJob, ScoringPreferences } from '../../../src/finder/scoring';

export interface GoldenPair {
  track: Track;
  name: string;
  job: ScorableJob;
  expected: MatchLabel;
}

interface TrackSetup {
  profile: ParsedResumeProfile;
  prefs: ScoringPreferences;
}

const baseProfile: Omit<
  ParsedResumeProfile,
  'jobTitles' | 'skills' | 'certifications' | 'yearsExperience' | 'location'
> = {
  name: null,
  email: null,
  phone: null,
  summary: null,
  workHistory: [],
  companies: [],
  tools: [],
  education: [],
  industries: [],
  achievements: [],
  languages: [],
  workAuthorizationStatus: null,
};

function profile(over: {
  jobTitles: string[];
  skills: string[];
  certifications: string[];
  yearsExperience: number;
  location: string;
  education?: ParsedResumeProfile['education'];
}): ParsedResumeProfile {
  return { ...baseProfile, education: [], ...over };
}

const DAYS = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAYS).toISOString();

function makeJob(
  over: Partial<ScorableJob> & { title: string; descriptionClean: string },
): ScorableJob {
  return {
    company: 'Company',
    locationNormalized: '',
    remoteType: 'unknown',
    salaryMin: null,
    salaryMax: null,
    salaryPeriod: 'year',
    postedAt: ago(5),
    sourceType: 'ats_greenhouse',
    ...over,
  };
}

// ---------------------------------------------------------------------------

export const TRACK_SETUPS: Record<Track, TrackSetup> = {
  finance_compliance: {
    profile: profile({
      jobTitles: ['Senior KYC Analyst', 'Compliance Analyst'],
      skills: [
        'KYC',
        'AML',
        'EDD',
        'OFAC',
        'sanctions screening',
        'transaction monitoring',
        'SAR filing',
        'Microsoft Excel',
      ],
      certifications: ['CAMS'],
      yearsExperience: 8,
      location: 'New York, NY',
      education: [
        {
          degree: 'Bachelor of Science in Finance',
          institution: 'Rutgers University',
          year: '2016',
        },
      ],
    }),
    prefs: {
      track: 'finance_compliance',
      targetTitles: ['KYC Analyst', 'Compliance Analyst', 'Sanctions Analyst', 'AML Analyst'],
      excludedTitles: [],
      preferredLocations: ['New York, NY'],
      remotePreferences: ['remote', 'hybrid', 'onsite'],
      salaryMin: 85000,
      industries: ['banking', 'fintech'],
    },
  },
  tech: {
    profile: profile({
      jobTitles: ['Senior Software Engineer', 'Software Engineer'],
      skills: [
        'TypeScript',
        'Python',
        'React',
        'Node.js',
        'SQL',
        'AWS',
        'Docker',
        'Terraform',
        'CI/CD',
        'Git',
      ],
      certifications: [],
      yearsExperience: 7,
      location: 'San Francisco, CA',
      education: [{ degree: 'B.S. Computer Science', institution: 'UC Davis', year: '2017' }],
    }),
    prefs: {
      track: 'tech',
      targetTitles: [
        'Software Engineer',
        'Senior Software Engineer',
        'Backend Engineer',
        'Full Stack Engineer',
      ],
      excludedTitles: [],
      preferredLocations: ['San Francisco, CA'],
      remotePreferences: ['remote', 'hybrid'],
      salaryMin: 150000,
      industries: ['software', 'saas'],
    },
  },
  healthcare_admin: {
    profile: profile({
      jobTitles: ['Medical Billing Specialist', 'Patient Access Representative'],
      skills: [
        'medical billing',
        'medical coding',
        'ICD-10',
        'CPT coding',
        'Epic',
        'HIPAA',
        'insurance verification',
        'prior authorization',
        'patient scheduling',
      ],
      certifications: ['CPC'],
      yearsExperience: 6,
      location: 'Houston, TX',
    }),
    prefs: {
      track: 'healthcare_admin',
      targetTitles: ['Medical Billing Specialist', 'Medical Coder', 'Revenue Cycle Specialist'],
      excludedTitles: [],
      preferredLocations: ['Houston, TX'],
      remotePreferences: ['remote', 'hybrid', 'onsite'],
      salaryMin: 48000,
      industries: ['healthcare', 'hospital'],
    },
  },
  blue_collar_hourly: {
    profile: profile({
      jobTitles: ['Forklift Operator', 'Warehouse Associate'],
      skills: [
        'forklift',
        'pallet jack',
        'shipping and receiving',
        'order picking',
        'inventory management',
        'OSHA compliance',
        'equipment maintenance',
      ],
      certifications: ['forklift certification', 'OSHA 10', 'CDL Class B'],
      yearsExperience: 9,
      location: 'Columbus, OH',
    }),
    prefs: {
      track: 'blue_collar_hourly',
      targetTitles: ['Forklift Operator', 'Warehouse Associate', 'Material Handler'],
      excludedTitles: [],
      preferredLocations: ['Columbus, OH'],
      remotePreferences: ['onsite'],
      salaryMin: 41600, // $20/hr
      industries: ['logistics', 'warehousing'],
    },
  },
  government: {
    profile: profile({
      jobTitles: ['Program Analyst', 'Management Assistant'],
      skills: [
        'policy analysis',
        'procurement',
        'FOIA',
        'records management',
        'grant writing',
        'budget management',
        'security clearance',
      ],
      certifications: [],
      yearsExperience: 9,
      location: 'Washington, DC',
      education: [
        {
          degree: 'Master of Public Administration',
          institution: 'American University',
          year: '2016',
        },
      ],
    }),
    prefs: {
      track: 'government',
      targetTitles: ['Program Analyst', 'Management and Program Analyst', 'Policy Analyst'],
      excludedTitles: [],
      preferredLocations: ['Washington, DC'],
      remotePreferences: ['remote', 'hybrid', 'onsite'],
      salaryMin: 80000,
      industries: ['federal government', 'public sector'],
    },
  },
  sales: {
    profile: profile({
      jobTitles: ['Account Executive', 'Sales Development Representative'],
      skills: [
        'Salesforce',
        'HubSpot',
        'B2B sales',
        'prospecting',
        'cold calling',
        'pipeline management',
        'contract negotiation',
        'quota attainment',
      ],
      certifications: [],
      yearsExperience: 6,
      location: 'Chicago, IL',
    }),
    prefs: {
      track: 'sales',
      targetTitles: ['Account Executive', 'Senior Account Executive', 'Account Manager'],
      excludedTitles: [],
      preferredLocations: ['Chicago, IL'],
      remotePreferences: ['remote', 'hybrid', 'onsite'],
      salaryMin: 90000,
      industries: ['saas', 'b2b services'],
    },
  },
  customer_support: {
    profile: profile({
      jobTitles: ['Customer Support Specialist', 'Customer Service Representative'],
      skills: [
        'Zendesk',
        'ticketing systems',
        'live chat support',
        'de-escalation',
        'CSAT',
        'phone support',
        'conflict resolution',
        'customer service',
      ],
      certifications: [],
      yearsExperience: 4,
      location: 'Phoenix, AZ',
    }),
    prefs: {
      track: 'customer_support',
      targetTitles: [
        'Customer Support Specialist',
        'Customer Service Representative',
        'Technical Support Specialist',
      ],
      excludedTitles: [],
      preferredLocations: ['Phoenix, AZ'],
      remotePreferences: ['remote', 'hybrid', 'onsite'],
      salaryMin: 45000,
      industries: ['saas'],
    },
  },
  office_admin: {
    profile: profile({
      jobTitles: ['Executive Assistant', 'Administrative Assistant'],
      skills: [
        'calendar management',
        'travel coordination',
        'Microsoft Office',
        'Excel',
        'Outlook',
        'data entry',
        'scheduling',
        'record keeping',
        'front desk',
      ],
      certifications: ['notary public'],
      yearsExperience: 10,
      location: 'Phoenix, AZ',
    }),
    prefs: {
      track: 'office_admin',
      targetTitles: ['Executive Assistant', 'Administrative Assistant', 'Office Coordinator'],
      excludedTitles: [],
      preferredLocations: ['Phoenix, AZ'],
      remotePreferences: ['hybrid', 'onsite'],
      salaryMin: 55000,
      industries: [],
    },
  },
  entry_level: {
    profile: profile({
      jobTitles: ['Sales Associate', 'Operations Intern'],
      skills: [
        'customer service',
        'data entry',
        'Microsoft Excel',
        'POS systems',
        'cash handling',
        'time management',
        'communication',
      ],
      certifications: [],
      yearsExperience: 1,
      location: 'Atlanta, GA',
      education: [
        {
          degree: 'Bachelor of Business Administration',
          institution: 'Georgia State University',
          year: '2024',
        },
      ],
    }),
    prefs: {
      track: 'entry_level',
      targetTitles: [
        'Operations Assistant',
        'Customer Service Representative',
        'Coordinator',
        'Associate',
      ],
      excludedTitles: [],
      preferredLocations: ['Atlanta, GA'],
      remotePreferences: ['remote', 'hybrid', 'onsite'],
      salaryMin: 40000,
      industries: [],
    },
  },
  general_professional: {
    profile: profile({
      jobTitles: ['Operations Manager', 'Project Coordinator'],
      skills: [
        'project management',
        'budget management',
        'vendor management',
        'team leadership',
        'Microsoft Excel',
        'scheduling',
        'training and development',
      ],
      certifications: ['PMP'],
      yearsExperience: 11,
      location: 'Denver, CO',
    }),
    prefs: {
      track: 'general_professional',
      targetTitles: ['Operations Manager', 'Project Manager', 'Program Coordinator'],
      excludedTitles: [],
      preferredLocations: ['Denver, CO'],
      remotePreferences: ['remote', 'hybrid', 'onsite'],
      salaryMin: 85000,
      industries: [],
    },
  },
};

// ---------------------------------------------------------------------------
// 12 jobs per track. Naming: <track>/<short description>.

export const GOLDEN_PAIRS: GoldenPair[] = [];

function add(track: Track, name: string, expected: MatchLabel, job: ScorableJob): void {
  GOLDEN_PAIRS.push({ track, name, expected, job });
}

// --- finance_compliance ------------------------------------------------------
add(
  'finance_compliance',
  'on-target KYC role',
  'strong',
  makeJob({
    title: 'KYC Analyst',
    company: 'Meridian Bank',
    descriptionClean:
      'Join our banking financial crimes unit.\nRequirements\n5+ years of experience across KYC, AML, EDD, OFAC and sanctions screening. CAMS required. Strong SAR filing background.\nNice to have\nTransaction monitoring platform experience.',
    locationNormalized: 'new york, ny',
    salaryMin: 95000,
    salaryMax: 115000,
  }),
);
add(
  'finance_compliance',
  'remote sanctions role, salary missing (edge)',
  'strong',
  makeJob({
    title: 'Sanctions Analyst',
    company: 'Corebank Fintech',
    descriptionClean:
      'Fintech compliance team.\nRequirements\n4+ years of experience with OFAC, sanctions screening, KYC and AML investigations. CAMS a plus.',
    locationNormalized: 'remote',
    remoteType: 'remote',
  }),
);
add(
  'finance_compliance',
  'adjacent fraud role',
  'good',
  makeJob({
    title: 'Fraud Investigator',
    company: 'Hudson Trust',
    descriptionClean:
      'Banking fraud team.\nRequirements\n3+ years in fraud investigation, transaction monitoring, or AML. Excel required.',
    locationNormalized: 'new york, ny',
    salaryMin: 88000,
    salaryMax: 105000,
  }),
);
add(
  'finance_compliance',
  'compliance role missing CAMS profile has (fine)',
  'good',
  makeJob({
    title: 'BSA/AML Compliance Analyst',
    company: 'Prairie Community Bank',
    descriptionClean:
      'Requirements\nWorking knowledge of BSA, AML, KYC programs. 3+ years of experience in banking compliance.',
    locationNormalized: 'jersey city, nj',
    salaryMin: 82000,
    salaryMax: 95000,
  }),
);
add(
  'finance_compliance',
  'good fit but stale posting (edge)',
  'good',
  makeJob({
    title: 'AML Analyst',
    company: 'Gotham Payments',
    descriptionClean:
      'Requirements\nKYC, AML, EDD experience. 4+ years of experience. Sanctions screening exposure.',
    locationNormalized: 'new york, ny',
    salaryMin: 90000,
    salaryMax: 100000,
    postedAt: ago(75),
  }),
);
add(
  'finance_compliance',
  'senior manager stretch, demands 12y',
  'possible',
  makeJob({
    title: 'Director of Financial Crimes Compliance',
    company: 'Empire Bancorp',
    descriptionClean:
      'Requirements\n12+ years of experience leading AML and sanctions programs. CAMS and prior team leadership required.',
    locationNormalized: 'new york, ny',
    salaryMin: 190000,
    salaryMax: 230000,
  }),
);
add(
  'finance_compliance',
  'missing required CRCM cert (edge)',
  'possible',
  makeJob({
    title: 'Regulatory Compliance Analyst',
    company: 'Liberty Savings',
    descriptionClean:
      'Requirements\nCRCM required. Regulatory compliance experience in retail banking. 4+ years of experience.',
    locationNormalized: 'new york, ny',
    salaryMin: 85000,
    salaryMax: 98000,
  }),
);
add(
  'finance_compliance',
  'wrong location onsite Dallas (edge)',
  'possible',
  makeJob({
    title: 'KYC Analyst',
    company: 'Lone Star Financial',
    descriptionClean: 'Requirements\nKYC, AML, EDD, OFAC experience. 4+ years of experience.',
    locationNormalized: 'dallas, tx',
    remoteType: 'onsite',
    salaryMin: 80000,
    salaryMax: 92000,
  }),
);
add(
  'finance_compliance',
  'internal audit tangent',
  'weak',
  makeJob({
    title: 'Internal Auditor',
    company: 'Ridge Manufacturing',
    descriptionClean:
      'Requirements\nInternal audit experience, GAAP knowledge, CPA preferred. 5+ years of experience in manufacturing audit.',
    locationNormalized: 'newark, nj',
    salaryMin: 85000,
    salaryMax: 100000,
  }),
);
add(
  'finance_compliance',
  'junior teller role, big step down',
  'weak',
  makeJob({
    title: 'Bank Teller',
    company: 'Queens Community Savings',
    descriptionClean:
      'Handle cash operations, customer service, and account openings at our branch.',
    locationNormalized: 'new york, ny',
    salaryMin: 38000,
    salaryMax: 44000,
  }),
);
add(
  'finance_compliance',
  'unrelated: line cook',
  'bad',
  makeJob({
    title: 'Line Cook',
    company: 'Harbor Diner',
    descriptionClean:
      'Prepare food on the grill station, keep the kitchen clean, and support prep work.',
    locationNormalized: 'new york, ny',
    salaryMin: 35000,
    salaryMax: 42000,
  }),
);
add(
  'finance_compliance',
  'unrelated: iOS engineer',
  'bad',
  makeJob({
    title: 'Senior iOS Engineer',
    company: 'Snapline',
    descriptionClean:
      'Requirements\n6+ years of experience building iOS apps in Swift. App Store shipping experience.',
    locationNormalized: 'remote',
    remoteType: 'remote',
    salaryMin: 180000,
    salaryMax: 220000,
  }),
);

// --- tech ---------------------------------------------------------------------
add(
  'tech',
  'on-target senior backend',
  'strong',
  makeJob({
    title: 'Senior Backend Engineer',
    company: 'Streamlogic',
    descriptionClean:
      'SaaS platform team.\nRequirements\n5+ years of experience with TypeScript, Node.js, SQL, and AWS. CI/CD ownership.\nNice to have\nTerraform and Docker.',
    locationNormalized: 'remote',
    remoteType: 'remote',
    salaryMin: 170000,
    salaryMax: 200000,
  }),
);
add(
  'tech',
  'full stack, salary missing (edge)',
  'strong',
  makeJob({
    title: 'Full Stack Engineer',
    company: 'Brightpath Software',
    descriptionClean:
      'Requirements\n4+ years of experience with React, Node.js, TypeScript, and SQL databases. AWS deployment experience.',
    locationNormalized: 'san francisco, ca',
    remoteType: 'hybrid',
  }),
);
add(
  'tech',
  'platform role, partial stack',
  'good',
  makeJob({
    title: 'Platform Engineer',
    company: 'Nimbus Cloud',
    descriptionClean:
      'Requirements\nStrong AWS, Terraform, Docker. Python scripting. 4+ years of experience.\nNice to have\nKubernetes.',
    locationNormalized: 'remote',
    remoteType: 'remote',
    salaryMin: 160000,
    salaryMax: 185000,
  }),
);
add(
  'tech',
  'onsite Seattle, otherwise strong (edge wrong location)',
  'good',
  makeJob({
    title: 'Senior Software Engineer',
    company: 'Cascade Systems',
    descriptionClean: 'Requirements\nTypeScript, React, Node.js, SQL. 6+ years of experience. AWS.',
    locationNormalized: 'seattle, wa',
    remoteType: 'onsite',
    salaryMin: 175000,
    salaryMax: 205000,
  }),
);
add(
  'tech',
  'data engineer adjacent',
  'good',
  makeJob({
    title: 'Data Engineer',
    company: 'Metricly',
    descriptionClean:
      'Requirements\nPython, SQL, AWS pipelines. 4+ years of experience.\nNice to have\nTerraform, Docker.',
    locationNormalized: 'remote',
    remoteType: 'remote',
    salaryMin: 155000,
    salaryMax: 180000,
  }),
);
add(
  'tech',
  'demands 10y staff level',
  'possible',
  makeJob({
    title: 'Staff Engineer, Infrastructure',
    company: 'Corely',
    descriptionClean:
      'Requirements\n10+ years of experience. Deep Kubernetes, Go, and distributed systems background.',
    locationNormalized: 'remote',
    remoteType: 'remote',
    salaryMin: 220000,
    salaryMax: 260000,
  }),
);
add(
  'tech',
  'mobile pivot, stack mismatch',
  'possible',
  makeJob({
    title: 'Software Engineer, Android',
    company: 'Pocketworks',
    descriptionClean:
      'Requirements\n3+ years of experience with Kotlin and Android SDK. Play Store releases.',
    locationNormalized: 'san francisco, ca',
    remoteType: 'hybrid',
    salaryMin: 160000,
    salaryMax: 190000,
  }),
);
add(
  'tech',
  'low salary startup (edge)',
  'possible',
  makeJob({
    title: 'Software Engineer',
    company: 'Seedling Labs',
    descriptionClean:
      'Requirements\nTypeScript, React, Node.js. 3+ years of experience. Equity-heavy package.',
    locationNormalized: 'san francisco, ca',
    remoteType: 'hybrid',
    salaryMin: 110000,
    salaryMax: 125000,
  }),
);
add(
  'tech',
  'IT helpdesk tangent',
  'weak',
  makeJob({
    title: 'IT Support Technician',
    company: 'Bayline Corp',
    descriptionClean:
      'Requirements\nWindows administration, ticketing systems, hardware troubleshooting. 2+ years of experience.',
    locationNormalized: 'san francisco, ca',
    salaryMin: 65000,
    salaryMax: 78000,
  }),
);
add(
  'tech',
  'embedded C++ mismatch',
  'weak',
  makeJob({
    title: 'Embedded Firmware Engineer',
    company: 'Voltaic Devices',
    descriptionClean:
      'Requirements\n5+ years of experience in C++ and RTOS firmware for battery systems.',
    locationNormalized: 'fremont, ca',
    remoteType: 'onsite',
    salaryMin: 150000,
    salaryMax: 175000,
  }),
);
add(
  'tech',
  'unrelated: dental hygienist',
  'bad',
  makeJob({
    title: 'Dental Hygienist',
    company: 'Smile Dental Group',
    descriptionClean:
      'Provide preventive dental care, cleanings, and patient education. RDH license required.',
    locationNormalized: 'san francisco, ca',
    salaryMin: 95000,
    salaryMax: 110000,
  }),
);
add(
  'tech',
  'unrelated: forklift operator',
  'bad',
  makeJob({
    title: 'Forklift Operator — 2nd Shift',
    company: 'Bay Logistics',
    descriptionClean:
      'Operate forklifts, load trailers, and maintain OSHA compliance in our warehouse.',
    locationNormalized: 'oakland, ca',
    salaryMin: 43000,
    salaryMax: 48000,
  }),
);

// --- healthcare_admin ----------------------------------------------------------
add(
  'healthcare_admin',
  'on-target billing role',
  'strong',
  makeJob({
    title: 'Medical Billing Specialist',
    company: 'Gulf Coast Medical Center',
    descriptionClean:
      'Hospital revenue cycle team.\nRequirements\n3+ years of experience with medical billing, ICD-10, CPT coding, and Epic. CPC required. HIPAA training.',
    locationNormalized: 'houston, tx',
    salaryMin: 52000,
    salaryMax: 60000,
  }),
);
add(
  'healthcare_admin',
  'remote coder role',
  'strong',
  makeJob({
    title: 'Medical Coder',
    company: 'Coastal Health Partners',
    descriptionClean:
      'Requirements\nCPC required. ICD-10 and CPT coding accuracy. 2+ years of experience. Epic or Cerner.',
    locationNormalized: 'remote',
    remoteType: 'remote',
    salaryMin: 50000,
    salaryMax: 58000,
  }),
);
add(
  'healthcare_admin',
  'revenue cycle, location missing (edge)',
  'good',
  makeJob({
    title: 'Revenue Cycle Specialist',
    company: 'Prairie Health Network',
    descriptionClean:
      'Requirements\nInsurance verification, prior authorization, medical billing. 3+ years of experience in hospital settings.',
    locationNormalized: '',
    salaryMin: 51000,
    salaryMax: 57000,
  }),
);
add(
  'healthcare_admin',
  'patient access lateral',
  'good',
  makeJob({
    title: 'Patient Access Representative II',
    company: 'Memorial Hermann',
    descriptionClean:
      'Requirements\nPatient scheduling, insurance verification, registration. Epic experience. HIPAA.',
    locationNormalized: 'houston, tx',
    salaryMin: 42000,
    salaryMax: 47000,
  }),
);
add(
  'healthcare_admin',
  'denials specialist, salary missing (edge)',
  'good',
  makeJob({
    title: 'Denials Management Specialist',
    company: 'Bayou Physicians Group',
    descriptionClean:
      'Requirements\nMedical billing appeals, CPT coding knowledge, payer follow-up. 3+ years of experience.',
    locationNormalized: 'houston, tx',
  }),
);
add(
  'healthcare_admin',
  'RHIT demanded, not held (edge cert)',
  'possible',
  makeJob({
    title: 'Health Information Technician',
    company: 'Lakeside Regional',
    descriptionClean:
      'Requirements\nRHIT required. Medical records management and release of information. 2+ years of experience.',
    locationNormalized: 'houston, tx',
    salaryMin: 48000,
    salaryMax: 54000,
  }),
);
add(
  'healthcare_admin',
  'manager stretch, demands 8y leadership',
  'possible',
  makeJob({
    title: 'Revenue Cycle Manager',
    company: 'Texan Medical Group',
    descriptionClean:
      'Requirements\n8+ years of experience with revenue cycle leadership. Team management of 10+ billers.',
    locationNormalized: 'houston, tx',
    salaryMin: 85000,
    salaryMax: 98000,
  }),
);
add(
  'healthcare_admin',
  'onsite Miami relocation',
  'possible',
  makeJob({
    title: 'Medical Billing Specialist',
    company: 'Biscayne Health',
    descriptionClean:
      'Requirements\nMedical billing, ICD-10, insurance verification. 2+ years of experience.',
    locationNormalized: 'miami, fl',
    remoteType: 'onsite',
    salaryMin: 47000,
    salaryMax: 53000,
  }),
);
add(
  'healthcare_admin',
  'clinical RN mismatch',
  'weak',
  makeJob({
    title: 'Registered Nurse — Med Surg',
    company: 'Houston Methodist',
    descriptionClean:
      'Requirements\nActive RN license, BLS, ACLS. Provide bedside patient care on a 36-bed unit.',
    locationNormalized: 'houston, tx',
    salaryMin: 75000,
    salaryMax: 90000,
  }),
);
add(
  'healthcare_admin',
  'pharmacy tech tangent',
  'weak',
  makeJob({
    title: 'Pharmacy Technician',
    company: 'MedPlus Pharmacy',
    descriptionClean:
      'Requirements\nCPhT required. Fill prescriptions, manage inventory, insurance claims processing.',
    locationNormalized: 'houston, tx',
    salaryMin: 38000,
    salaryMax: 44000,
  }),
);
add(
  'healthcare_admin',
  'unrelated: sales AE',
  'bad',
  makeJob({
    title: 'Enterprise Account Executive',
    company: 'CloudMetrics',
    descriptionClean:
      'Requirements\n5+ years of experience in SaaS sales. Salesforce, pipeline management, quota attainment.',
    locationNormalized: 'remote',
    remoteType: 'remote',
    salaryMin: 130000,
    salaryMax: 160000,
  }),
);
add(
  'healthcare_admin',
  'unrelated: welder',
  'bad',
  makeJob({
    title: 'Structural Welder',
    company: 'Gulf Fabrication',
    descriptionClean:
      'MIG and TIG welding of structural steel. OSHA 10 required. Shop environment.',
    locationNormalized: 'pasadena, tx',
    salaryMin: 52000,
    salaryMax: 62000,
  }),
);

// --- blue_collar_hourly ---------------------------------------------------------
add(
  'blue_collar_hourly',
  'on-target forklift, good pay',
  'strong',
  makeJob({
    title: 'Forklift Operator',
    company: 'Midwest Distribution',
    descriptionClean:
      'Requirements\nForklift certification required. Sit-down and stand-up forklift, pallet jack, shipping and receiving. OSHA compliance.',
    locationNormalized: 'columbus, oh',
    salaryMin: 22,
    salaryMax: 26,
    salaryPeriod: 'hour',
  }),
);
add(
  'blue_collar_hourly',
  'warehouse lead step up',
  'strong',
  makeJob({
    title: 'Warehouse Associate — Days',
    company: 'Buckeye Logistics',
    descriptionClean:
      'Requirements\nOrder picking, inventory management, pallet jack. Forklift certification a plus. 2+ years of experience.',
    locationNormalized: 'columbus, oh',
    salaryMin: 21,
    salaryMax: 24,
    salaryPeriod: 'hour',
  }),
);
add(
  'blue_collar_hourly',
  'material handler, pay unlisted (edge)',
  'good',
  makeJob({
    title: 'Material Handler',
    company: 'Scioto Supply',
    descriptionClean:
      'Requirements\nShipping and receiving, order picking, equipment maintenance. Forklift experience preferred.',
    locationNormalized: 'columbus, oh',
  }),
);
add(
  'blue_collar_hourly',
  'CDL delivery driver lateral',
  'good',
  makeJob({
    title: 'Delivery Driver — Box Truck',
    company: 'Capital City Couriers',
    descriptionClean:
      'Requirements\nCDL Class B required. Local route delivery, loading and unloading, route planning.',
    locationNormalized: 'columbus, oh',
    salaryMin: 23,
    salaryMax: 25,
    salaryPeriod: 'hour',
  }),
);
add(
  'blue_collar_hourly',
  'low pay picker role (edge salary)',
  'possible',
  makeJob({
    title: 'Order Picker',
    company: 'ValuWarehouse',
    descriptionClean:
      'Requirements\nOrder picking and packing. Pallet jack experience helpful. Entry friendly.',
    locationNormalized: 'columbus, oh',
    salaryMin: 15,
    salaryMax: 16.5,
    salaryPeriod: 'hour',
  }),
);
add(
  'blue_collar_hourly',
  'Cincinnati commute (edge location)',
  'possible',
  makeJob({
    title: 'Forklift Operator',
    company: 'River City Freight',
    descriptionClean:
      'Requirements\nForklift certification, shipping and receiving, OSHA compliance. 2+ years of experience.',
    locationNormalized: 'cincinnati, oh',
    salaryMin: 22,
    salaryMax: 25,
    salaryPeriod: 'hour',
  }),
);
add(
  'blue_collar_hourly',
  'maintenance mechanic stretch',
  'possible',
  makeJob({
    title: 'Industrial Maintenance Mechanic',
    company: 'Ohio Steelworks',
    descriptionClean:
      'Requirements\n5+ years of experience in industrial equipment maintenance, hydraulics, and welding.',
    locationNormalized: 'columbus, oh',
    salaryMin: 28,
    salaryMax: 34,
    salaryPeriod: 'hour',
  }),
);
add(
  'blue_collar_hourly',
  'CDL-A OTR mismatch (has B)',
  'weak',
  makeJob({
    title: 'OTR Truck Driver',
    company: 'Interstate Carriers',
    descriptionClean:
      'Requirements\nCDL Class A required. Over-the-road routes, 2 weeks out. Clean MVR.',
    locationNormalized: 'columbus, oh',
    salaryMin: 65000,
    salaryMax: 80000,
  }),
);
add(
  'blue_collar_hourly',
  'HVAC tech different trade',
  'weak',
  makeJob({
    title: 'HVAC Service Technician',
    company: 'Comfort Air',
    descriptionClean:
      'Requirements\nEPA 608 required. Residential HVAC service and installation. 3+ years of experience.',
    locationNormalized: 'columbus, oh',
    salaryMin: 25,
    salaryMax: 32,
    salaryPeriod: 'hour',
  }),
);
add(
  'blue_collar_hourly',
  'unrelated: staff accountant',
  'bad',
  makeJob({
    title: 'Staff Accountant',
    company: 'Franklin CPA Group',
    descriptionClean:
      'Requirements\nGAAP, reconciliation, month-end close. CPA track. Bachelor degree required.',
    locationNormalized: 'columbus, oh',
    salaryMin: 60000,
    salaryMax: 70000,
  }),
);
add(
  'blue_collar_hourly',
  'unrelated: UX designer',
  'bad',
  makeJob({
    title: 'UX Designer',
    company: 'Pixelforge',
    descriptionClean:
      'Requirements\n4+ years of experience in product design, Figma, and user research.',
    locationNormalized: 'remote',
    remoteType: 'remote',
    salaryMin: 110000,
    salaryMax: 135000,
  }),
);
add(
  'blue_collar_hourly',
  'remote data entry mismatch for onsite pref',
  'weak',
  makeJob({
    title: 'Remote Data Entry Clerk',
    company: 'FormWorks',
    descriptionClean: 'Requirements\nAccurate data entry, typing 60wpm. Fully remote role.',
    locationNormalized: 'remote',
    remoteType: 'remote',
    salaryMin: 17,
    salaryMax: 19,
    salaryPeriod: 'hour',
  }),
);

// --- government -----------------------------------------------------------------
add(
  'government',
  'on-target program analyst',
  'strong',
  makeJob({
    title: 'Program Analyst',
    company: 'Federal Transit Support Services',
    descriptionClean:
      'Support a federal agency program office.\nRequirements\n5+ years of experience in policy analysis, budget management, and records management. Public sector background. Active security clearance preferred.',
    locationNormalized: 'washington, dc',
    salaryMin: 95000,
    salaryMax: 115000,
  }),
);
add(
  'government',
  'grants management fit',
  'strong',
  makeJob({
    title: 'Grants Management Analyst',
    company: 'Capitol Program Solutions',
    descriptionClean:
      'Requirements\nGrant writing and grants administration for federal government programs. 4+ years of experience. Policy analysis skills.',
    locationNormalized: 'washington, dc',
    remoteType: 'hybrid',
    salaryMin: 90000,
    salaryMax: 105000,
  }),
);
add(
  'government',
  'procurement analyst lateral',
  'good',
  makeJob({
    title: 'Procurement Analyst',
    company: 'Beltway Consulting',
    descriptionClean:
      'Requirements\nFederal procurement support, FAR familiarity, records management. 3+ years of experience in public sector consulting.',
    locationNormalized: 'arlington, va',
    salaryMin: 85000,
    salaryMax: 100000,
  }),
);
add(
  'government',
  'FOIA specialist, salary missing (edge)',
  'good',
  makeJob({
    title: 'FOIA Specialist',
    company: 'ClearRecord Federal',
    descriptionClean:
      'Requirements\nFOIA request processing, records management, redaction review. 3+ years of experience supporting federal government clients.',
    locationNormalized: 'washington, dc',
    remoteType: 'hybrid',
  }),
);
add(
  'government',
  'senior policy stretch 12y',
  'possible',
  makeJob({
    title: 'Senior Policy Advisor',
    company: 'National Programs Institute',
    descriptionClean:
      'Requirements\n12+ years of experience shaping federal policy. Doctorate preferred. Congressional experience.',
    locationNormalized: 'washington, dc',
    salaryMin: 150000,
    salaryMax: 175000,
  }),
);
add(
  'government',
  'TS/SCI clearance demanded',
  'possible',
  makeJob({
    title: 'Program Analyst — Intelligence Programs',
    company: 'Sentinel Federal',
    descriptionClean:
      'Requirements\nActive TS/SCI clearance required. Program analysis for classified programs. 5+ years of experience.',
    locationNormalized: 'mclean, va',
    remoteType: 'onsite',
    salaryMin: 110000,
    salaryMax: 130000,
  }),
);
add(
  'government',
  'state gov in Richmond (edge location)',
  'possible',
  makeJob({
    title: 'Management Analyst',
    company: 'Commonwealth of Virginia',
    descriptionClean:
      'Requirements\nPolicy analysis and budget management for a state agency. 4+ years of experience.',
    locationNormalized: 'richmond, va',
    remoteType: 'onsite',
    salaryMin: 75000,
    salaryMax: 88000,
  }),
);
add(
  'government',
  'city clerk low band',
  'weak',
  makeJob({
    title: 'Deputy City Clerk',
    company: 'City of Frederick',
    descriptionClean: 'Records management and meeting minutes for city council. Notary a plus.',
    locationNormalized: 'frederick, md',
    salaryMin: 52000,
    salaryMax: 60000,
  }),
);
add(
  'government',
  'defense hardware PM tangent',
  'weak',
  makeJob({
    title: 'Hardware Program Manager',
    company: 'Aegis Defense Systems',
    descriptionClean:
      'Requirements\n7+ years of experience managing radar hardware programs. Engineering degree required.',
    locationNormalized: 'huntsville, al',
    salaryMin: 130000,
    salaryMax: 155000,
  }),
);
add(
  'government',
  'unrelated: barista',
  'bad',
  makeJob({
    title: 'Barista',
    company: 'Capitol Coffee',
    descriptionClean: 'Prepare espresso drinks, run the register, keep the café clean.',
    locationNormalized: 'washington, dc',
    salaryMin: 17,
    salaryMax: 19,
    salaryPeriod: 'hour',
  }),
);
add(
  'government',
  'unrelated: ML engineer',
  'bad',
  makeJob({
    title: 'Machine Learning Engineer',
    company: 'Vector Labs',
    descriptionClean:
      'Requirements\nPython, PyTorch, distributed training. 5+ years of experience.',
    locationNormalized: 'remote',
    remoteType: 'remote',
    salaryMin: 200000,
    salaryMax: 240000,
  }),
);
add(
  'government',
  'aggregator copy of program analyst (edge source)',
  'good',
  makeJob({
    title: 'Program Analyst',
    company: 'Federal Transit Support Services',
    descriptionClean:
      'Requirements\nPolicy analysis, budget management, records management. 5+ years of experience. Public sector.',
    locationNormalized: 'washington, dc',
    salaryMin: 95000,
    salaryMax: 115000,
    sourceType: 'api_adzuna',
  }),
);

// --- sales -----------------------------------------------------------------------
add(
  'sales',
  'on-target AE',
  'strong',
  makeJob({
    title: 'Account Executive',
    company: 'Pipeline SaaS',
    descriptionClean:
      'B2B SaaS sales team.\nRequirements\n4+ years of experience in B2B sales, Salesforce, pipeline management, and quota attainment.\nNice to have\nHubSpot.',
    locationNormalized: 'chicago, il',
    remoteType: 'hybrid',
    salaryMin: 100000,
    salaryMax: 140000,
  }),
);
add(
  'sales',
  'senior AE remote',
  'strong',
  makeJob({
    title: 'Senior Account Executive',
    company: 'Growthline',
    descriptionClean:
      'Requirements\n5+ years of experience in SaaS B2B sales. Prospecting, contract negotiation, quota attainment.',
    locationNormalized: 'remote',
    remoteType: 'remote',
    salaryMin: 110000,
    salaryMax: 150000,
  }),
);
add(
  'sales',
  'account manager lateral',
  'good',
  makeJob({
    title: 'Account Manager — Mid Market',
    company: 'Ledger CRM',
    descriptionClean:
      'Requirements\nRenewals and upselling for a book of B2B accounts. Salesforce. 3+ years of experience.',
    locationNormalized: 'chicago, il',
    salaryMin: 85000,
    salaryMax: 110000,
  }),
);
add(
  'sales',
  'logistics sales, industry shift (edge)',
  'good',
  makeJob({
    title: 'Account Executive — Freight',
    company: 'Lakeshore Logistics',
    descriptionClean:
      'Requirements\nB2B sales, cold calling, pipeline management. 3+ years of experience. Freight brokerage a plus.',
    locationNormalized: 'chicago, il',
    salaryMin: 90000,
    salaryMax: 130000,
  }),
);
add(
  'sales',
  'salary missing enterprise AE (edge)',
  'good',
  makeJob({
    title: 'Enterprise Account Executive',
    company: 'Nordic Analytics',
    descriptionClean:
      'Requirements\n6+ years of experience in enterprise SaaS sales. Salesforce, complex contract negotiation.',
    locationNormalized: 'chicago, il',
    remoteType: 'hybrid',
  }),
);
add(
  'sales',
  'sales engineer pivot',
  'possible',
  makeJob({
    title: 'Sales Engineer',
    company: 'Apex Integrations',
    descriptionClean:
      'Requirements\nTechnical demos, API knowledge, solution scoping. 3+ years of experience in pre-sales.',
    locationNormalized: 'chicago, il',
    salaryMin: 120000,
    salaryMax: 145000,
  }),
);
add(
  'sales',
  'VP stretch 12y',
  'possible',
  makeJob({
    title: 'VP of Sales',
    company: 'Meridian Software',
    descriptionClean:
      'Requirements\n12+ years of experience including sales leadership of 20+ AEs. Board reporting.',
    locationNormalized: 'chicago, il',
    salaryMin: 200000,
    salaryMax: 250000,
  }),
);
add(
  'sales',
  'SDR step back',
  'weak',
  makeJob({
    title: 'Sales Development Representative',
    company: 'Sprout Outreach',
    descriptionClean: 'Requirements\nCold calling and prospecting. Entry level welcome. HubSpot.',
    locationNormalized: 'chicago, il',
    salaryMin: 50000,
    salaryMax: 65000,
  }),
);
add(
  'sales',
  'retail floor sales mismatch',
  'weak',
  makeJob({
    title: 'Retail Sales Associate',
    company: 'Michigan Ave Outfitters',
    descriptionClean: 'Customer service and POS systems on the sales floor. Weekend availability.',
    locationNormalized: 'chicago, il',
    salaryMin: 16,
    salaryMax: 18,
    salaryPeriod: 'hour',
  }),
);
add(
  'sales',
  'insurance door-to-door commission-only',
  'weak',
  makeJob({
    title: 'Insurance Sales Agent — Commission',
    company: 'Shield Life',
    descriptionClean: 'Commission-only life insurance sales. Licensing support provided.',
    locationNormalized: 'chicago, il',
  }),
);
add(
  'sales',
  'unrelated: paralegal',
  'bad',
  makeJob({
    title: 'Litigation Paralegal',
    company: 'Harris & Cole LLP',
    descriptionClean:
      'Requirements\nParalegal certificate, discovery management, e-filing. 3+ years of experience.',
    locationNormalized: 'chicago, il',
    salaryMin: 65000,
    salaryMax: 80000,
  }),
);
add(
  'sales',
  'unrelated: warehouse nights',
  'bad',
  makeJob({
    title: 'Warehouse Associate — Nights',
    company: 'Windy City Fulfillment',
    descriptionClean: 'Order picking, packing, and loading. Forklift certification a plus.',
    locationNormalized: 'chicago, il',
    salaryMin: 18,
    salaryMax: 21,
    salaryPeriod: 'hour',
  }),
);

// --- customer_support ---------------------------------------------------------------
add(
  'customer_support',
  'on-target support specialist',
  'strong',
  makeJob({
    title: 'Customer Support Specialist',
    company: 'Helply',
    descriptionClean:
      'SaaS support team.\nRequirements\n2+ years of experience with Zendesk, live chat support, and de-escalation. CSAT ownership.',
    locationNormalized: 'remote',
    remoteType: 'remote',
    salaryMin: 50000,
    salaryMax: 58000,
  }),
);
add(
  'customer_support',
  'tier 2 technical support',
  'strong',
  makeJob({
    title: 'Technical Support Specialist',
    company: 'Gridbase',
    descriptionClean:
      'Requirements\nTicketing systems, troubleshooting SaaS issues, phone support. 3+ years of experience. Zendesk.',
    locationNormalized: 'phoenix, az',
    remoteType: 'hybrid',
    salaryMin: 52000,
    salaryMax: 60000,
  }),
);
add(
  'customer_support',
  'CS rep, salary missing (edge)',
  'good',
  makeJob({
    title: 'Customer Service Representative',
    company: 'Desert Utilities',
    descriptionClean:
      'Requirements\nPhone support, conflict resolution, customer service in high-volume call center operations.',
    locationNormalized: 'phoenix, az',
  }),
);
add(
  'customer_support',
  'success associate lateral',
  'good',
  makeJob({
    title: 'Customer Success Associate',
    company: 'Bloomtrack',
    descriptionClean:
      'Requirements\nOnboarding SaaS customers, renewals support, ticketing systems. 2+ years of experience in customer support.',
    locationNormalized: 'remote',
    remoteType: 'remote',
    salaryMin: 55000,
    salaryMax: 62000,
  }),
);
add(
  'customer_support',
  'bilingual center Tucson (edge location)',
  'possible',
  makeJob({
    title: 'Customer Support Specialist — Bilingual',
    company: 'Sunline Services',
    descriptionClean:
      'Requirements\nSpanish fluency required. Call center operations, phone support, de-escalation.',
    locationNormalized: 'tucson, az',
    remoteType: 'onsite',
    salaryMin: 46000,
    salaryMax: 52000,
  }),
);
add(
  'customer_support',
  'support team lead stretch',
  'good',
  makeJob({
    title: 'Support Team Lead',
    company: 'Cactus Software',
    descriptionClean:
      'Requirements\n4+ years of experience in customer support including QA coaching. Zendesk admin. CSAT program ownership.',
    locationNormalized: 'phoenix, az',
    remoteType: 'hybrid',
    salaryMin: 62000,
    salaryMax: 72000,
  }),
);
add(
  'customer_support',
  'demands 7y + workforce mgmt',
  'possible',
  makeJob({
    title: 'Support Operations Manager',
    company: 'Nimbus Retail',
    descriptionClean:
      'Requirements\n7+ years of experience in support operations, workforce management, and vendor management.',
    locationNormalized: 'phoenix, az',
    salaryMin: 85000,
    salaryMax: 95000,
  }),
);
add(
  'customer_support',
  'low-pay overnight center (edge salary)',
  'possible',
  makeJob({
    title: 'Overnight Call Center Agent',
    company: 'AnswerFirst',
    descriptionClean:
      'Requirements\nOvernight phone support. Call center operations. Entry friendly.',
    locationNormalized: 'phoenix, az',
    salaryMin: 15,
    salaryMax: 16,
    salaryPeriod: 'hour',
  }),
);
add(
  'customer_support',
  'field service tech tangent',
  'weak',
  makeJob({
    title: 'Field Service Technician',
    company: 'CopierPro',
    descriptionClean:
      'Requirements\nOn-site copier repair, driving between client sites, equipment maintenance.',
    locationNormalized: 'phoenix, az',
    salaryMin: 45000,
    salaryMax: 52000,
  }),
);
add(
  'customer_support',
  'collections role tangent',
  'weak',
  makeJob({
    title: 'Collections Specialist',
    company: 'Southwest Recovery',
    descriptionClean: 'Requirements\nOutbound collections calls, negotiation, FDCPA familiarity.',
    locationNormalized: 'phoenix, az',
    salaryMin: 42000,
    salaryMax: 48000,
  }),
);
add(
  'customer_support',
  'unrelated: electrician',
  'bad',
  makeJob({
    title: 'Journeyman Electrician',
    company: 'Sun Valley Electric',
    descriptionClean:
      'Journeyman electrician license required. Commercial electrical wiring installs.',
    locationNormalized: 'phoenix, az',
    salaryMin: 32,
    salaryMax: 40,
    salaryPeriod: 'hour',
  }),
);
add(
  'customer_support',
  'unrelated: quant researcher',
  'bad',
  makeJob({
    title: 'Quantitative Researcher',
    company: 'Axiom Capital',
    descriptionClean: 'Requirements\nPhD in math or physics. Statistical arbitrage research. C++.',
    locationNormalized: 'new york, ny',
    salaryMin: 250000,
    salaryMax: 350000,
  }),
);

// --- office_admin ---------------------------------------------------------------------
add(
  'office_admin',
  'on-target EA',
  'strong',
  makeJob({
    title: 'Executive Assistant',
    company: 'Sonoran Health Partners',
    descriptionClean:
      'Requirements\n5+ years of experience supporting executives: calendar management, travel coordination, Outlook, Excel.',
    locationNormalized: 'phoenix, az',
    salaryMin: 62000,
    salaryMax: 72000,
  }),
);
add(
  'office_admin',
  'admin assistant fit',
  'strong',
  makeJob({
    title: 'Administrative Assistant',
    company: 'Canyon Legal Group',
    descriptionClean:
      'Requirements\nScheduling, data entry, record keeping, front desk coverage. Microsoft Office. 3+ years of experience.',
    locationNormalized: 'phoenix, az',
    salaryMin: 55000,
    salaryMax: 60000,
  }),
);
add(
  'office_admin',
  'office coordinator, salary missing (edge)',
  'good',
  makeJob({
    title: 'Office Coordinator',
    company: 'Mesa Dental Partners',
    descriptionClean:
      'Requirements\nFront desk, scheduling, office management support, supply ordering. Microsoft Office.',
    locationNormalized: 'mesa, az',
  }),
);
add(
  'office_admin',
  'ops assistant lateral',
  'good',
  makeJob({
    title: 'Operations Assistant',
    company: 'Verde Property Group',
    descriptionClean:
      'Requirements\nCalendar management, vendor scheduling, data entry, record keeping. Excel required.',
    locationNormalized: 'phoenix, az',
    salaryMin: 52000,
    salaryMax: 58000,
  }),
);
add(
  'office_admin',
  'legal secretary specialization',
  'possible',
  makeJob({
    title: 'Legal Secretary',
    company: 'Arroyo & Marsh',
    descriptionClean:
      'Requirements\nLegal document formatting, e-filing, dictation. 3+ years of experience in a law firm.',
    locationNormalized: 'phoenix, az',
    salaryMin: 58000,
    salaryMax: 66000,
  }),
);
add(
  'office_admin',
  'C-suite EA stretch 10y+board',
  'good',
  makeJob({
    title: 'Senior Executive Assistant to CEO',
    company: 'Titan Industrial',
    descriptionClean:
      'Requirements\n8+ years of experience supporting C-suite. Board meeting coordination, travel coordination, calendar management.',
    locationNormalized: 'phoenix, az',
    salaryMin: 75000,
    salaryMax: 85000,
  }),
);
add(
  'office_admin',
  'remote-only role vs onsite pref',
  'possible',
  makeJob({
    title: 'Virtual Administrative Assistant',
    company: 'RemoteOps Co',
    descriptionClean:
      'Requirements\nFully remote admin support: scheduling, data entry, inbox management.',
    locationNormalized: 'remote',
    remoteType: 'remote',
    salaryMin: 48000,
    salaryMax: 55000,
  }),
);
add(
  'office_admin',
  'Tucson onsite (edge location)',
  'possible',
  makeJob({
    title: 'Administrative Assistant',
    company: 'Saguaro Insurance',
    descriptionClean:
      'Requirements\nScheduling, filing, record keeping, front desk. Microsoft Office.',
    locationNormalized: 'tucson, az',
    remoteType: 'onsite',
    salaryMin: 50000,
    salaryMax: 56000,
  }),
);
add(
  'office_admin',
  'HR coordinator pivot',
  'weak',
  makeJob({
    title: 'HR Coordinator',
    company: 'Cholla Staffing',
    descriptionClean:
      'Requirements\nOnboarding paperwork, HRIS data entry, benefits questions. SHRM-CP a plus.',
    locationNormalized: 'phoenix, az',
    salaryMin: 52000,
    salaryMax: 58000,
  }),
);
add(
  'office_admin',
  'low-pay receptionist step down',
  'weak',
  makeJob({
    title: 'Receptionist',
    company: 'Palm Medical Clinic',
    descriptionClean: 'Front desk, phone answering, patient check-in.',
    locationNormalized: 'phoenix, az',
    salaryMin: 16,
    salaryMax: 18,
    salaryPeriod: 'hour',
  }),
);
add(
  'office_admin',
  'unrelated: DevOps engineer',
  'bad',
  makeJob({
    title: 'DevOps Engineer',
    company: 'Cloudright',
    descriptionClean: 'Requirements\nKubernetes, Terraform, AWS. 5+ years of experience.',
    locationNormalized: 'remote',
    remoteType: 'remote',
    salaryMin: 160000,
    salaryMax: 190000,
  }),
);
add(
  'office_admin',
  'unrelated: landscaper',
  'bad',
  makeJob({
    title: 'Landscape Crew Member',
    company: 'Desert Greens',
    descriptionClean: 'Mowing, trimming, and irrigation maintenance. Outdoor work in summer heat.',
    locationNormalized: 'phoenix, az',
    salaryMin: 16,
    salaryMax: 18,
    salaryPeriod: 'hour',
  }),
);

// --- entry_level -----------------------------------------------------------------------
add(
  'entry_level',
  'ops assistant entry fit',
  'strong',
  makeJob({
    title: 'Operations Assistant',
    company: 'Peachtree Logistics',
    descriptionClean:
      'Entry-level operations support: data entry, scheduling, customer service. Excel helpful. Bachelor degree preferred. Training provided.',
    locationNormalized: 'atlanta, ga',
    salaryMin: 42000,
    salaryMax: 48000,
  }),
);
add(
  'entry_level',
  'CS rep with training',
  'strong',
  makeJob({
    title: 'Customer Service Representative',
    company: 'Southern Mutual',
    descriptionClean:
      'Customer service and phone support. POS or cash handling background welcome. Full training program for new graduates.',
    locationNormalized: 'atlanta, ga',
    salaryMin: 41000,
    salaryMax: 45000,
  }),
);
add(
  'entry_level',
  'coordinator, salary missing (edge)',
  'good',
  makeJob({
    title: 'Program Coordinator',
    company: 'Georgia Nonprofit Alliance',
    descriptionClean:
      'Coordinate event scheduling, data entry, and volunteer communication. Bachelor degree required. Entry level welcome.',
    locationNormalized: 'atlanta, ga',
  }),
);
add(
  'entry_level',
  'bank teller trainee',
  'good',
  makeJob({
    title: 'Bank Teller',
    company: 'Peach State Credit Union',
    descriptionClean:
      'Cash handling, customer service, account support. Training provided. High school diploma required.',
    locationNormalized: 'atlanta, ga',
    salaryMin: 38000,
    salaryMax: 42000,
  }),
);
add(
  'entry_level',
  'demands 5y (edge wrong seniority)',
  'possible',
  makeJob({
    title: 'Operations Coordinator',
    company: 'Hartsfield Freight',
    descriptionClean:
      'Requirements\n5+ years of experience in logistics operations coordination. Excel modeling.',
    locationNormalized: 'atlanta, ga',
    salaryMin: 55000,
    salaryMax: 62000,
  }),
);
add(
  'entry_level',
  'remote CS low pay (edge salary)',
  'possible',
  makeJob({
    title: 'Remote Customer Service Associate',
    company: 'CallBridge',
    descriptionClean: 'Remote phone support. Entry friendly. Equipment provided.',
    locationNormalized: 'remote',
    remoteType: 'remote',
    salaryMin: 13,
    salaryMax: 15,
    salaryPeriod: 'hour',
  }),
);
add(
  'entry_level',
  'Savannah onsite (edge location)',
  'possible',
  makeJob({
    title: 'Operations Assistant',
    company: 'Coastal Imports',
    descriptionClean: 'Data entry, scheduling, and warehouse office support. Entry level.',
    locationNormalized: 'savannah, ga',
    remoteType: 'onsite',
    salaryMin: 40000,
    salaryMax: 44000,
  }),
);
add(
  'entry_level',
  'staffing agency generic listing',
  'good',
  makeJob({
    title: 'Administrative Associate',
    company: 'TalentBridge Staffing',
    descriptionClean:
      'Data entry, filing, customer service for a corporate client. Recent graduates encouraged. Microsoft Excel.',
    locationNormalized: 'atlanta, ga',
    salaryMin: 40000,
    salaryMax: 45000,
    sourceType: 'api_adzuna',
  }),
);
add(
  'entry_level',
  'senior analyst out of reach',
  'weak',
  makeJob({
    title: 'Senior Financial Analyst',
    company: 'Delta Corporate Finance',
    descriptionClean:
      'Requirements\n6+ years of experience in FP&A. Advanced Excel modeling, budget management.',
    locationNormalized: 'atlanta, ga',
    salaryMin: 95000,
    salaryMax: 110000,
  }),
);
add(
  'entry_level',
  'commission-only canvasser',
  'weak',
  makeJob({
    title: 'Door-to-Door Sales Canvasser',
    company: 'SolarNow',
    descriptionClean: 'Commission-only neighborhood canvassing for solar appointments.',
    locationNormalized: 'atlanta, ga',
  }),
);
add(
  'entry_level',
  'unrelated: ICU nurse',
  'bad',
  makeJob({
    title: 'ICU Registered Nurse',
    company: 'Grady Health',
    descriptionClean:
      'Requirements\nActive RN license, BLS, ACLS, 2+ years of experience in critical care.',
    locationNormalized: 'atlanta, ga',
    salaryMin: 78000,
    salaryMax: 95000,
  }),
);
add(
  'entry_level',
  'unrelated: principal engineer',
  'bad',
  makeJob({
    title: 'Principal Software Engineer',
    company: 'Skyloft Systems',
    descriptionClean:
      'Requirements\n12+ years of experience. Distributed systems architecture ownership.',
    locationNormalized: 'remote',
    remoteType: 'remote',
    salaryMin: 230000,
    salaryMax: 280000,
  }),
);

// --- general_professional -----------------------------------------------------------------
add(
  'general_professional',
  'on-target ops manager',
  'strong',
  makeJob({
    title: 'Operations Manager',
    company: 'Summit Facilities Group',
    descriptionClean:
      'Requirements\n7+ years of experience in operations: team leadership, budget management, vendor management. PMP a plus.',
    locationNormalized: 'denver, co',
    salaryMin: 95000,
    salaryMax: 110000,
  }),
);
add(
  'general_professional',
  'project manager fit',
  'strong',
  makeJob({
    title: 'Project Manager',
    company: 'Rockline Construction Services',
    descriptionClean:
      'Requirements\nPMP required. 5+ years of experience in project management, scheduling, and budget management.',
    locationNormalized: 'denver, co',
    remoteType: 'hybrid',
    salaryMin: 98000,
    salaryMax: 115000,
  }),
);
add(
  'general_professional',
  'program coordinator lateral, salary missing (edge)',
  'good',
  makeJob({
    title: 'Program Coordinator',
    company: 'Front Range Health Alliance',
    descriptionClean:
      'Requirements\nProject management support, scheduling, vendor management, training and development coordination.',
    locationNormalized: 'denver, co',
  }),
);
add(
  'general_professional',
  'remote ops role',
  'good',
  makeJob({
    title: 'Business Operations Manager',
    company: 'Alpine SaaS',
    descriptionClean:
      'Requirements\n5+ years of experience in business operations. Budget management, cross-team project management.',
    locationNormalized: 'remote',
    remoteType: 'remote',
    salaryMin: 105000,
    salaryMax: 120000,
  }),
);
add(
  'general_professional',
  'facilities supervisor adjacent',
  'good',
  makeJob({
    title: 'Facilities Operations Supervisor',
    company: 'Mile High Properties',
    descriptionClean:
      'Requirements\nTeam leadership of maintenance staff, vendor management, scheduling. 5+ years of experience.',
    locationNormalized: 'denver, co',
    salaryMin: 82000,
    salaryMax: 92000,
  }),
);
add(
  'general_professional',
  'director stretch 15y',
  'possible',
  makeJob({
    title: 'Director of Operations',
    company: 'Continental Services',
    descriptionClean:
      'Requirements\n15+ years of experience including multi-site P&L ownership and executive reporting.',
    locationNormalized: 'denver, co',
    salaryMin: 160000,
    salaryMax: 185000,
  }),
);
// Label corrected possible→good on review: with title/skills/experience all
// aligned, a 70-mile in-state onsite role reads "good, but you'd relocate or
// commute" to a human recruiter — 'possible' was too harsh for a
// general-professional (location weight .10) candidate.
add(
  'general_professional',
  'Colorado Springs onsite (edge location)',
  'good',
  makeJob({
    title: 'Operations Manager',
    company: 'Pikes Peak Manufacturing',
    descriptionClean:
      'Requirements\nManufacturing operations management, team leadership, budget management. 6+ years of experience.',
    locationNormalized: 'colorado springs, co',
    remoteType: 'onsite',
    salaryMin: 90000,
    salaryMax: 100000,
  }),
);
add(
  'general_professional',
  'salary below minimum (edge)',
  'possible',
  makeJob({
    title: 'Project Coordinator',
    company: 'Boulder Events Co',
    descriptionClean:
      'Requirements\nProject management support, scheduling, vendor management. 3+ years of experience.',
    locationNormalized: 'denver, co',
    salaryMin: 58000,
    salaryMax: 66000,
  }),
);
add(
  'general_professional',
  'scrum master specialization',
  'weak',
  makeJob({
    title: 'Scrum Master',
    company: 'AgileWorks',
    descriptionClean:
      'Requirements\nCSM required. Facilitate agile ceremonies for 3 engineering squads. Jira administration.',
    locationNormalized: 'denver, co',
    salaryMin: 105000,
    salaryMax: 120000,
  }),
);
add(
  'general_professional',
  'exec chef ops tangent',
  'weak',
  makeJob({
    title: 'Kitchen Operations Manager',
    company: 'Alpine Hospitality',
    descriptionClean: 'Requirements\nRestaurant kitchen management, food cost control, ServSafe.',
    locationNormalized: 'denver, co',
    salaryMin: 65000,
    salaryMax: 75000,
  }),
);
add(
  'general_professional',
  'unrelated: phlebotomist',
  'bad',
  makeJob({
    title: 'Phlebotomist',
    company: 'Rocky Mountain Labs',
    descriptionClean: 'Requirements\nPhlebotomy certification, specimen collection, patient care.',
    locationNormalized: 'denver, co',
    salaryMin: 40000,
    salaryMax: 46000,
  }),
);
add(
  'general_professional',
  'unrelated: game artist',
  'bad',
  makeJob({
    title: '3D Character Artist',
    company: 'Peak Games Studio',
    descriptionClean: 'Requirements\nZBrush, Maya, stylized character modeling portfolio.',
    locationNormalized: 'remote',
    remoteType: 'remote',
    salaryMin: 90000,
    salaryMax: 115000,
  }),
);
