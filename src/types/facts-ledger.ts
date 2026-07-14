// src/types/facts-ledger.ts
//
// The closed set of TRUE, user-approved claims. Document generation may not exceed it.

export type FactType =
  | "employment"
  | "education"
  | "certification"
  | "skill"
  | "achievement"
  | "metric"
  | "language"
  | "summary_point"
  | "contact";

export interface BaseFact {
  id: string;
  type: FactType;
  /** User-confirmed. Only approved facts may be used in generated documents. */
  approved: boolean;
  /** The resume span this came from, for audit. */
  sourceText?: string;
}

export interface EmploymentFact extends BaseFact {
  type: "employment";
  employer: string;
  title: string;
  startDate: string; // ISO or "YYYY-MM"
  endDate: string | "present";
  location?: string;
  /** Approved accomplishment statements. */
  bullets: string[];
}

export interface EducationFact extends BaseFact {
  type: "education";
  institution: string;
  degree: string;
  field?: string;
  graduationDate?: string;
}

export interface CertificationFact extends BaseFact {
  type: "certification";
  name: string;
  issuer?: string;
  /** Omit if in progress; never imply completion of an unfinished certification. */
  dateEarned?: string;
  inProgress?: boolean;
}

export interface MetricFact extends BaseFact {
  type: "metric";
  statement: string; // e.g. "reviewed ~120 EDD cases per quarter"
  value?: number;
  unit?: string;
}

export interface GenericFact extends BaseFact {
  type: "skill" | "achievement" | "language" | "summary_point" | "contact";
  statement: string;
}

export type Fact =
  | EmploymentFact
  | EducationFact
  | CertificationFact
  | MetricFact
  | GenericFact;

export interface FactsLedger {
  profileId: string;
  /** Closed set; generation may not exceed it. */
  facts: Fact[];
  approvedAt?: string;
}
