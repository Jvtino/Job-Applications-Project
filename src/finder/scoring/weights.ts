import type { Track } from '../shared';

/** §15 scorecard components. Every table below sums to 1.0 (unit-tested). */
export interface ScoreWeights {
  title: number;
  requiredSkills: number;
  preferredSkills: number;
  experience: number;
  industry: number;
  location: number;
  salary: number;
  educationCertification: number;
  sourceQuality: number;
  freshness: number;
}

/** §15 default weights — used verbatim for general_professional. */
export const DEFAULT_WEIGHTS: ScoreWeights = {
  title: 0.15,
  requiredSkills: 0.2,
  preferredSkills: 0.1,
  experience: 0.15,
  industry: 0.1,
  location: 0.1,
  salary: 0.05,
  educationCertification: 0.05,
  sourceQuality: 0.05,
  freshness: 0.05,
};

/**
 * Per-track overrides (§15 "track-based weighting", data not logic):
 * hourly work is about pay/distance/licenses; tech about stack and remote;
 * government about eligibility signals; entry-level about location and
 * trainability rather than skill depth.
 */
export const TRACK_WEIGHTS: Record<Track, ScoreWeights> = {
  general_professional: DEFAULT_WEIGHTS,
  finance_compliance: {
    title: 0.15,
    requiredSkills: 0.22,
    preferredSkills: 0.05,
    experience: 0.15,
    industry: 0.1,
    location: 0.08,
    salary: 0.03,
    educationCertification: 0.12,
    sourceQuality: 0.05,
    freshness: 0.05,
  },
  tech: {
    title: 0.15,
    requiredSkills: 0.25,
    preferredSkills: 0.12,
    experience: 0.13,
    industry: 0.05,
    location: 0.12,
    salary: 0.05,
    educationCertification: 0.03,
    sourceQuality: 0.05,
    freshness: 0.05,
  },
  healthcare_admin: {
    title: 0.15,
    requiredSkills: 0.18,
    preferredSkills: 0.05,
    experience: 0.1,
    industry: 0.07,
    location: 0.15,
    salary: 0.05,
    educationCertification: 0.15,
    sourceQuality: 0.05,
    freshness: 0.05,
  },
  blue_collar_hourly: {
    title: 0.12,
    requiredSkills: 0.15,
    preferredSkills: 0.05,
    experience: 0.08,
    industry: 0.05,
    location: 0.2,
    salary: 0.15,
    educationCertification: 0.1,
    sourceQuality: 0.05,
    freshness: 0.05,
  },
  government: {
    title: 0.18,
    requiredSkills: 0.15,
    preferredSkills: 0.05,
    experience: 0.15,
    industry: 0.1,
    location: 0.12,
    salary: 0.03,
    educationCertification: 0.12,
    sourceQuality: 0.05,
    freshness: 0.05,
  },
  entry_level: {
    title: 0.1,
    requiredSkills: 0.12,
    preferredSkills: 0.05,
    experience: 0.05,
    industry: 0.08,
    location: 0.18,
    salary: 0.1,
    educationCertification: 0.12,
    sourceQuality: 0.1,
    freshness: 0.1,
  },
  sales: {
    title: 0.18,
    requiredSkills: 0.15,
    preferredSkills: 0.05,
    experience: 0.12,
    industry: 0.12,
    location: 0.13,
    salary: 0.1,
    educationCertification: 0.05,
    sourceQuality: 0.05,
    freshness: 0.05,
  },
  customer_support: {
    title: 0.2,
    requiredSkills: 0.2,
    preferredSkills: 0.05,
    experience: 0.08,
    industry: 0.07,
    location: 0.2,
    salary: 0.07,
    educationCertification: 0.03,
    sourceQuality: 0.05,
    freshness: 0.05,
  },
  office_admin: {
    title: 0.18,
    requiredSkills: 0.15,
    preferredSkills: 0.05,
    experience: 0.1,
    industry: 0.07,
    location: 0.2,
    salary: 0.07,
    educationCertification: 0.03,
    sourceQuality: 0.07,
    freshness: 0.08,
  },
};
