// src/jobs/role-family-pack.ts
//
// RoleFamilyPack — a CONFIGURABLE taxonomy unit, not one-off per-domain logic. Each pack describes
// one role family generically: its exact + adjacent titles, seniority vocabulary, must/nice skill
// groups, industry terms, and — critically — the exclusion + wrong-family terms that stop a
// keyword-similar role from a DIFFERENT function slipping in.
//
// The engine is the packs + the abstraction, NOT any single pack. Adding a family = one entry here;
// no code path privileges a family. Pack ids are the canonical taxonomy family ids (taxonomy.ts).
//
// This is a STARTER set proving the architecture generalizes across many industries/seniorities.
// It is not meant to be exhaustive — grow it with data, keep every pack the same shape.

export interface RoleFamilyPack {
  id: string;
  displayName: string;
  exactTitles: string[];
  adjacentTitles: string[];
  /** Seniority rung → the words a posting uses at that rung (for query variants + level matching). */
  seniorityTerms: Record<string, string[]>;
  /** OR-groups of AND-able must-have skills (at least one group should be reasonably covered). */
  mustHaveSkillGroups: string[][];
  niceToHaveSkillGroups: string[][];
  industryTerms: string[];
  /** Terms that, in a title, should EXCLUDE the posting (wrong specialty or seniority mismatch). */
  exclusionTerms: string[];
  /** Titles/terms that indicate a DIFFERENT family entirely (hard wrong-family signal). */
  wrongFamilyTerms: string[];
  /** Licenses/certs/degrees that signal this family's gated roles. */
  credentialSignals: string[];
}

const SENIORITY_COMMON: Record<string, string[]> = {
  intern: ["intern", "internship"],
  entry: ["entry level", "junior", "associate", "i", "trainee"],
  associate: ["associate", "coordinator"],
  mid: ["ii", "mid", "specialist"],
  senior: ["senior", "sr", "iii", "lead"],
  lead: ["lead", "staff", "principal", "manager"],
  manager: ["manager", "head of"],
  director: ["director", "head", "vp"],
  executive: ["vp", "vice president", "chief", "head"],
};

function pack(p: Partial<RoleFamilyPack> & Pick<RoleFamilyPack, "id" | "displayName">): RoleFamilyPack {
  return {
    exactTitles: [],
    adjacentTitles: [],
    seniorityTerms: SENIORITY_COMMON,
    mustHaveSkillGroups: [],
    niceToHaveSkillGroups: [],
    industryTerms: [],
    exclusionTerms: [],
    wrongFamilyTerms: [],
    credentialSignals: [],
    ...p,
  };
}

export const ROLE_FAMILY_PACKS: Record<string, RoleFamilyPack> = {
  engineering: pack({
    id: "engineering",
    displayName: "Software Engineering",
    exactTitles: ["Software Engineer", "Full Stack Engineer", "Backend Engineer", "Frontend Engineer", "Software Developer"],
    adjacentTitles: ["Application Developer", "Web Developer", "Platform Engineer", "Mobile Engineer", "Solutions Engineer"],
    mustHaveSkillGroups: [["python", "java", "javascript", "typescript", "go", "c#", "ruby"], ["react", "node", "spring", "django", ".net"]],
    niceToHaveSkillGroups: [["aws", "kubernetes", "docker", "graphql"], ["sql", "postgresql", "mongodb"]],
    industryTerms: ["saas", "software", "platform", "fintech", "cloud"],
    exclusionTerms: ["sales engineer", "hardware", "civil", "mechanical", "industrial engineer"],
    wrongFamilyTerms: ["nurse", "accountant", "recruiter", "attorney", "driver"],
    credentialSignals: ["bachelor", "computer science"],
  }),
  data: pack({
    id: "data",
    displayName: "Data / Analytics",
    exactTitles: ["Data Analyst", "Data Scientist", "Data Engineer", "Analytics Engineer", "Business Intelligence Analyst"],
    adjacentTitles: ["Reporting Analyst", "Insights Analyst", "Machine Learning Engineer", "Quantitative Analyst"],
    mustHaveSkillGroups: [["sql", "python", "r"], ["tableau", "power bi", "looker", "excel"]],
    niceToHaveSkillGroups: [["machine learning", "statistics", "dbt", "spark"]],
    industryTerms: ["technology", "financial services", "ecommerce/retail", "healthcare"],
    exclusionTerms: ["data entry", "data center technician"],
    wrongFamilyTerms: ["nurse", "attorney", "welder", "chef"],
    credentialSignals: ["bachelor", "statistics", "mathematics"],
  }),
  product: pack({
    id: "product",
    displayName: "Product Management",
    exactTitles: ["Product Manager", "Associate Product Manager", "Senior Product Manager", "Product Owner"],
    adjacentTitles: ["Technical Product Manager", "Growth Product Manager", "Program Manager", "Product Analyst"],
    mustHaveSkillGroups: [["product management", "roadmap", "user research"], ["agile", "stakeholder management"]],
    niceToHaveSkillGroups: [["sql", "a/b testing", "analytics"]],
    industryTerms: ["technology", "saas"],
    exclusionTerms: ["product marketing", "warehouse", "production"],
    wrongFamilyTerms: ["nurse", "driver", "accountant"],
    credentialSignals: ["bachelor", "mba"],
  }),
  compliance: pack({
    id: "compliance",
    displayName: "Compliance / Risk",
    exactTitles: ["Compliance Analyst", "AML Analyst", "KYC Analyst", "Risk Analyst", "Financial Crimes Investigator", "Financial Crimes Analyst", "Financial Intelligence Analyst"],
    // Leads with the common FEDERAL title ("Intelligence Analyst") and entry/associate
    // variants so market queries reach early-career roles first, then the usual adjacents.
    adjacentTitles: ["Intelligence Analyst", "AML Associate", "KYC Associate", "Compliance Associate", "Sanctions Analyst", "Fraud Analyst", "Transaction Monitoring Analyst", "BSA Officer", "Regulatory Analyst"],
    mustHaveSkillGroups: [["aml", "kyc", "bsa", "sanctions screening"], ["transaction monitoring", "due diligence", "sar"]],
    niceToHaveSkillGroups: [["financial crime", "risk assessment", "regulatory reporting"]],
    industryTerms: ["financial services", "fintech", "banking"],
    exclusionTerms: ["software", "sales", "compliance engineer"],
    wrongFamilyTerms: ["nurse", "driver", "chef", "welder"],
    credentialSignals: ["CAMS", "CFE", "bachelor"],
  }),
  finance: pack({
    id: "finance",
    displayName: "Finance / Accounting",
    exactTitles: ["Accountant", "Senior Accountant", "Financial Analyst", "Staff Accountant", "Controller"],
    adjacentTitles: ["FP&A Analyst", "Bookkeeper", "Accounts Payable Specialist", "Accounts Receivable Specialist", "Treasury Analyst"],
    mustHaveSkillGroups: [["general ledger", "accounts payable", "accounts receivable", "gaap"], ["financial analysis", "financial modeling", "excel"]],
    niceToHaveSkillGroups: [["quickbooks", "netsuite", "sap", "erp"]],
    industryTerms: ["financial services", "consulting", "manufacturing/industrial"],
    exclusionTerms: ["financial advisor sales", "insurance sales"],
    wrongFamilyTerms: ["nurse", "engineer", "driver"],
    credentialSignals: ["CPA", "CFA", "bachelor", "accounting"],
  }),
  sales: pack({
    id: "sales",
    displayName: "Sales / Business Development",
    exactTitles: ["Account Executive", "Sales Development Representative", "Business Development Representative", "Account Manager"],
    adjacentTitles: ["Inside Sales Representative", "Sales Manager", "Partnerships Manager", "Enterprise Account Executive"],
    mustHaveSkillGroups: [["sales", "pipeline", "quota", "prospecting"], ["salesforce", "crm"]],
    niceToHaveSkillGroups: [["business development", "lead generation", "account management"]],
    industryTerms: ["saas", "technology", "financial services"],
    exclusionTerms: ["sales engineer", "sales operations analyst"],
    wrongFamilyTerms: ["nurse", "accountant", "developer"],
    credentialSignals: ["bachelor"],
  }),
  marketing: pack({
    id: "marketing",
    displayName: "Marketing / Growth",
    exactTitles: ["Marketing Coordinator", "Marketing Manager", "Growth Marketer", "Content Marketing Manager", "Demand Generation Manager"],
    adjacentTitles: ["Brand Manager", "Digital Marketing Specialist", "SEO Specialist", "Social Media Manager", "Product Marketing Manager"],
    mustHaveSkillGroups: [["digital marketing", "content marketing", "seo"], ["social media marketing", "email marketing", "campaigns"]],
    niceToHaveSkillGroups: [["google analytics", "hubspot", "marketo", "crm"]],
    industryTerms: ["technology", "ecommerce/retail", "consumer goods"],
    exclusionTerms: ["market research analyst", "marketing data engineer"],
    wrongFamilyTerms: ["nurse", "accountant", "driver"],
    credentialSignals: ["bachelor"],
  }),
  operations: pack({
    id: "operations",
    displayName: "Operations",
    exactTitles: ["Operations Manager", "Operations Analyst", "Operations Coordinator", "Business Operations Manager"],
    adjacentTitles: ["Program Manager", "Process Improvement Analyst", "Operations Associate", "Strategy & Operations"],
    mustHaveSkillGroups: [["operations", "process improvement", "project management"], ["excel", "data analysis"]],
    niceToHaveSkillGroups: [["sql", "six sigma", "lean"]],
    industryTerms: ["technology", "manufacturing/industrial", "ecommerce/retail", "logistics"],
    exclusionTerms: ["operating room", "machine operator", "forklift operator"],
    wrongFamilyTerms: ["nurse", "attorney", "welder"],
    credentialSignals: ["bachelor", "pmp", "six sigma"],
  }),
  customer_success: pack({
    id: "customer_success",
    displayName: "Customer Success / Support",
    exactTitles: ["Customer Success Manager", "Customer Support Specialist", "Client Services Manager", "Account Manager"],
    adjacentTitles: ["Onboarding Specialist", "Implementation Manager", "Support Engineer", "Customer Experience Manager"],
    mustHaveSkillGroups: [["customer success", "customer service", "onboarding"], ["account management", "crm"]],
    niceToHaveSkillGroups: [["salesforce", "zendesk", "saas"]],
    industryTerms: ["saas", "technology"],
    exclusionTerms: ["customer service sales floor", "cashier"],
    wrongFamilyTerms: ["nurse", "accountant", "driver"],
    credentialSignals: ["bachelor"],
  }),
  healthcare: pack({
    id: "healthcare",
    displayName: "Healthcare Administration",
    exactTitles: ["Healthcare Administrative Assistant", "Medical Office Coordinator", "Patient Access Representative", "Medical Records Specialist"],
    adjacentTitles: ["Health Information Technician", "Practice Coordinator", "Revenue Cycle Specialist", "Medical Scheduler"],
    mustHaveSkillGroups: [["patient care", "ehr", "medical records", "scheduling"], ["hipaa", "revenue cycle"]],
    niceToHaveSkillGroups: [["epic", "cerner", "medical billing", "coding"]],
    industryTerms: ["healthcare"],
    exclusionTerms: ["healthcare software engineer", "pharmaceutical sales"],
    wrongFamilyTerms: ["software engineer", "attorney", "welder"],
    credentialSignals: ["RN license", "medical license", "CPC", "associate"],
  }),
  project_management: pack({
    id: "project_management",
    displayName: "Project / Program Management",
    exactTitles: ["Project Coordinator", "Project Manager", "Program Manager", "Program Coordinator"],
    adjacentTitles: ["Scrum Master", "Delivery Manager", "PMO Analyst", "Implementation Coordinator"],
    mustHaveSkillGroups: [["project management", "program management", "stakeholder management"], ["agile", "scrum"]],
    niceToHaveSkillGroups: [["jira", "asana", "smartsheet", "ms project"]],
    industryTerms: ["technology", "consulting", "construction"],
    exclusionTerms: ["construction project engineer"],
    wrongFamilyTerms: ["nurse", "driver", "welder"],
    credentialSignals: ["PMP", "CSM", "bachelor"],
  }),
  hr: pack({
    id: "hr",
    displayName: "HR / Recruiting",
    exactTitles: ["Recruiter", "HR Generalist", "Talent Acquisition Specialist", "HR Coordinator", "People Operations Specialist"],
    adjacentTitles: ["Sourcer", "HR Business Partner", "Benefits Coordinator", "Payroll Specialist"],
    mustHaveSkillGroups: [["recruiting", "talent acquisition", "employee relations"], ["hris", "onboarding"]],
    niceToHaveSkillGroups: [["workday", "greenhouse", "payroll"]],
    industryTerms: ["technology", "staffing"],
    exclusionTerms: ["hr software engineer"],
    wrongFamilyTerms: ["nurse", "driver", "accountant"],
    credentialSignals: ["PHR", "SHRM-CP", "bachelor"],
  }),
  security: pack({
    id: "security",
    displayName: "Cybersecurity / IT",
    exactTitles: ["Security Analyst", "SOC Analyst", "Information Security Analyst", "Cybersecurity Analyst"],
    adjacentTitles: ["Security Engineer", "IT Security Specialist", "GRC Analyst", "Incident Responder"],
    mustHaveSkillGroups: [["security", "siem", "incident response"], ["network security", "vulnerability management"]],
    niceToHaveSkillGroups: [["splunk", "python", "cloud security"]],
    industryTerms: ["technology", "financial services", "government/public"],
    exclusionTerms: ["physical security guard", "loss prevention"],
    wrongFamilyTerms: ["nurse", "accountant", "driver"],
    credentialSignals: ["CISSP", "Security+", "bachelor"],
  }),
  design: pack({
    id: "design",
    displayName: "Design / UX",
    exactTitles: ["Product Designer", "UX Designer", "UI Designer", "UX/UI Designer", "Visual Designer"],
    adjacentTitles: ["Interaction Designer", "UX Researcher", "Graphic Designer", "Design Systems Designer"],
    mustHaveSkillGroups: [["ux", "ui", "user research"], ["figma", "sketch", "prototyping"]],
    niceToHaveSkillGroups: [["design systems", "accessibility", "html", "css"]],
    industryTerms: ["technology", "saas"],
    exclusionTerms: ["interior designer", "mechanical designer"],
    wrongFamilyTerms: ["nurse", "accountant", "driver"],
    credentialSignals: ["bachelor", "portfolio"],
  }),
  administrative: pack({
    id: "administrative",
    displayName: "Administrative / Executive Assistant",
    exactTitles: ["Administrative Assistant", "Executive Assistant", "Office Coordinator", "Office Manager"],
    adjacentTitles: ["Receptionist", "Administrative Coordinator", "Operations Assistant", "Front Desk Coordinator"],
    mustHaveSkillGroups: [["scheduling", "calendar management", "office administration"], ["microsoft office", "excel"]],
    niceToHaveSkillGroups: [["travel coordination", "expense reports", "crm"]],
    industryTerms: ["professional services", "technology"],
    exclusionTerms: ["database administrator", "systems administrator"],
    wrongFamilyTerms: ["nurse", "engineer", "driver"],
    credentialSignals: ["associate", "bachelor"],
  }),
  logistics: pack({
    id: "logistics",
    displayName: "Supply Chain / Logistics",
    exactTitles: ["Logistics Coordinator", "Supply Chain Analyst", "Procurement Specialist", "Inventory Analyst"],
    adjacentTitles: ["Warehouse Supervisor", "Fulfillment Manager", "Demand Planner", "Purchasing Coordinator"],
    mustHaveSkillGroups: [["supply chain", "logistics", "inventory"], ["procurement", "erp"]],
    niceToHaveSkillGroups: [["sap", "excel", "forecasting"]],
    industryTerms: ["manufacturing/industrial", "ecommerce/retail", "logistics"],
    exclusionTerms: ["truck driver", "forklift operator"],
    wrongFamilyTerms: ["nurse", "attorney", "accountant"],
    credentialSignals: ["APICS", "bachelor"],
  }),
  legal: pack({
    id: "legal",
    displayName: "Legal Operations",
    exactTitles: ["Paralegal", "Legal Assistant", "Contracts Analyst", "Legal Operations Analyst"],
    adjacentTitles: ["Compliance Analyst", "Contract Administrator", "Legal Coordinator"],
    mustHaveSkillGroups: [["contracts", "legal research", "litigation support"], ["document review"]],
    niceToHaveSkillGroups: [["ediscovery", "contract management"]],
    industryTerms: ["legal", "financial services"],
    exclusionTerms: ["attorney", "associate attorney"],
    wrongFamilyTerms: ["nurse", "engineer", "driver"],
    credentialSignals: ["paralegal certificate", "JD", "bachelor"],
  }),
  infrastructure: pack({
    id: "infrastructure",
    displayName: "DevOps / Platform / SRE",
    exactTitles: ["DevOps Engineer", "Site Reliability Engineer", "Platform Engineer", "Cloud Engineer"],
    adjacentTitles: ["Infrastructure Engineer", "Systems Engineer", "Build Engineer", "Release Engineer"],
    mustHaveSkillGroups: [["kubernetes", "docker", "terraform"], ["aws", "gcp", "azure"]],
    niceToHaveSkillGroups: [["ci/cd", "python", "monitoring"]],
    industryTerms: ["technology", "saas"],
    exclusionTerms: ["field technician", "help desk"],
    wrongFamilyTerms: ["nurse", "accountant", "driver"],
    credentialSignals: ["bachelor", "aws certified"],
  }),
};

/** Select the packs matching the intent's role families. Falls back to nothing (caller decides). */
export function selectRoleFamilyPacks(roleFamilies: string[]): RoleFamilyPack[] {
  const out: RoleFamilyPack[] = [];
  for (const id of roleFamilies) {
    const p = ROLE_FAMILY_PACKS[id];
    if (p) out.push(p);
  }
  return out;
}

export function allRoleFamilyPacks(): RoleFamilyPack[] {
  return Object.values(ROLE_FAMILY_PACKS);
}
