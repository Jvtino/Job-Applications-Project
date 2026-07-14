// src/validation/facts-ledger.schema.ts
//
// Runtime validators for the Module 2 facts ledger, DERIVED from src/types/facts-ledger.ts
// and pinned to it by `assertSchemaMatches` checks below.

import { z } from "zod";
import { assertSchemaMatches, type Equals } from "./common";
import type {
  CertificationFact,
  EducationFact,
  EmploymentFact,
  Fact,
  FactsLedger,
  GenericFact,
  MetricFact,
} from "../types/facts-ledger";

const baseFactFields = {
  id: z.string(),
  approved: z.boolean(),
  sourceText: z.string().optional(),
};

export const employmentFactSchema = z.object({
  ...baseFactFields,
  type: z.literal("employment"),
  employer: z.string(),
  title: z.string(),
  startDate: z.string(),
  endDate: z.union([z.string(), z.literal("present")]),
  location: z.string().optional(),
  bullets: z.array(z.string()),
});

export const educationFactSchema = z.object({
  ...baseFactFields,
  type: z.literal("education"),
  institution: z.string(),
  degree: z.string(),
  field: z.string().optional(),
  graduationDate: z.string().optional(),
});

export const certificationFactSchema = z.object({
  ...baseFactFields,
  type: z.literal("certification"),
  name: z.string(),
  issuer: z.string().optional(),
  dateEarned: z.string().optional(),
  inProgress: z.boolean().optional(),
});

export const metricFactSchema = z.object({
  ...baseFactFields,
  type: z.literal("metric"),
  statement: z.string(),
  value: z.number().optional(),
  unit: z.string().optional(),
});

export const genericFactSchema = z.object({
  ...baseFactFields,
  type: z.enum(["skill", "achievement", "language", "summary_point", "contact"]),
  statement: z.string(),
});

export const factSchema = z.union([
  employmentFactSchema,
  educationFactSchema,
  certificationFactSchema,
  metricFactSchema,
  genericFactSchema,
]);

export const factsLedgerSchema = z.object({
  profileId: z.string(),
  facts: z.array(factSchema),
  approvedAt: z.string().optional(),
});

// ----------------------------------------------------------------------------------------
// Compile-time drift guards.
// `endDate: z.union([z.string(), z.literal("present")])` widens to `string`, matching the
// TS `string | "present"` (also `string`), so the Equals checks below hold.
// ----------------------------------------------------------------------------------------

assertSchemaMatches<Equals<z.infer<typeof employmentFactSchema>, EmploymentFact>>();
assertSchemaMatches<Equals<z.infer<typeof educationFactSchema>, EducationFact>>();
assertSchemaMatches<Equals<z.infer<typeof certificationFactSchema>, CertificationFact>>();
assertSchemaMatches<Equals<z.infer<typeof metricFactSchema>, MetricFact>>();
assertSchemaMatches<Equals<z.infer<typeof genericFactSchema>, GenericFact>>();
assertSchemaMatches<Equals<z.infer<typeof factSchema>, Fact>>();
assertSchemaMatches<Equals<z.infer<typeof factsLedgerSchema>, FactsLedger>>();
