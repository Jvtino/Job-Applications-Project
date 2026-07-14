// src/validation/applicant-profile.schema.ts
//
// Runtime validators for the Module 1 profile, DERIVED from src/types/applicant-profile.ts.
// Every exported schema is pinned to its TS counterpart by an `assertSchemaMatches` check at
// the bottom of this file — change one without the other and the build breaks.

import { z } from "zod";
import { answerSchema, assertSchemaMatches, zDecline, type Equals } from "./common";
import type {
  Answer,
  ApplicantProfile,
  ContactInfo,
  DynamicQA,
  JobPreferences,
  PositioningStatement,
  Reference,
  ScreeningAnswers,
  SelfIdentification,
  VeteranSelfId,
  WorkAuthorization,
} from "../types/applicant-profile";

// ----------------------------------------------------------------------------------------
// Identity & contact
// ----------------------------------------------------------------------------------------

export const contactInfoSchema = z.object({
  legalFirstName: z.string(),
  legalLastName: z.string(),
  preferredName: z.string().optional(),
  email: z.string(),
  phone: z.string(),
  address: z.object({
    line1: z.string(),
    line2: z.string().optional(),
    city: z.string(),
    state: z.string(),
    postalCode: z.string(),
    country: z.literal("US"),
  }),
  links: z.object({
    linkedin: z.string().optional(),
    portfolio: z.string().optional(),
    github: z.string().optional(),
    other: z.array(z.object({ label: z.string(), url: z.string() })).optional(),
  }),
});

// ----------------------------------------------------------------------------------------
// Work authorization
// ----------------------------------------------------------------------------------------

export const workAuthorizationSchema = z.object({
  authorizedToWorkInUS: answerSchema(z.boolean()),
  requiresSponsorshipNowOrFuture: answerSchema(z.boolean()),
  currentWorkStatus: answerSchema(
    z.enum(["us_citizen", "permanent_resident", "visa_holder", "other"])
  ).optional(),
});

// ----------------------------------------------------------------------------------------
// Preferences
// ----------------------------------------------------------------------------------------

export const jobPreferencesSchema = z.object({
  earliestStartDate: answerSchema(z.string()),
  noticePeriodDays: answerSchema(z.number()),
  willingToRelocate: answerSchema(z.boolean()),
  workModePreference: answerSchema(
    z.array(z.enum(["remote", "hybrid", "onsite"]))
  ),
  desiredLocations: z.array(z.string()),
  targetRoles: z.array(z.string()).default([]),
  targetIndustries: z.array(z.string()).default([]),
  yearsOfExperience: z.number().optional(),
  jobLevel: z.enum(["entry", "mid", "senior", "staff", "lead", "manager", "director", "executive"]).optional(),
  employmentTypes: z.array(z.enum(["full_time", "part_time", "contract", "temporary", "internship"])).default([]),
  companiesToAvoid: z.array(z.string()).default([]),
  compensation: z.object({
    currency: z.literal("USD"),
    desiredBaseMin: z.number().optional(),
    desiredBaseMax: z.number().optional(),
    isNegotiable: z.boolean(),
  }),
});

// ----------------------------------------------------------------------------------------
// Screening
// ----------------------------------------------------------------------------------------

export const screeningAnswersSchema = z.object({
  isAtLeast18: answerSchema(z.boolean()),
  canPerformEssentialFunctions: answerSchema(z.boolean()),
  requiresAccommodationForProcess: answerSchema(z.boolean()),
  previouslyEmployedHere: answerSchema(z.boolean()),
  hearAboutSource: answerSchema(z.string()).optional(),
  hasNonCompete: answerSchema(z.boolean()).optional(),
  willingToTravelPercent: answerSchema(z.number()).optional(),
});

// ----------------------------------------------------------------------------------------
// Self-identification (sensitive PII)
// ----------------------------------------------------------------------------------------

export const veteranSelfIdSchema = z.object({
  status: answerSchema(
    z.enum(["protected_veteran", "not_protected_veteran"])
  ),
  categories: answerSchema(
    z.array(
      z.enum([
        "disabled_veteran",
        "recently_separated_veteran",
        "active_duty_wartime_or_campaign_badge_veteran",
        "armed_forces_service_medal_veteran",
      ])
    )
  ),
});

export const selfIdentificationSchema = z.object({
  gender: answerSchema(z.enum(["male", "female", "non_binary"])),
  raceEthnicity: answerSchema(
    z.enum([
      "hispanic_or_latino",
      "white",
      "black_or_african_american",
      "native_hawaiian_or_other_pacific_islander",
      "asian",
      "american_indian_or_alaska_native",
      "two_or_more_races",
    ])
  ),
  veteran: veteranSelfIdSchema,
  disability: answerSchema(z.enum(["yes_has_disability", "no_disability"])),
});

// ----------------------------------------------------------------------------------------
// Strategic positioning
// ----------------------------------------------------------------------------------------

export const positioningStatementSchema = z.object({
  whatIDo: z.string(),
  whoIServe: z.string(),
  whatResult: z.string(),
  updatedAt: z.string(),
});

// ----------------------------------------------------------------------------------------
// References
// ----------------------------------------------------------------------------------------

export const referenceSchema = z.object({
  name: z.string(),
  relationship: z.string(),
  company: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
});

// ----------------------------------------------------------------------------------------
// Dynamic Q&A
// ----------------------------------------------------------------------------------------

export const dynamicQaSchema = z.object({
  key: z.string(),
  questionText: z.string(),
  fieldType: z.enum([
    "text",
    "boolean",
    "number",
    "single_select",
    "multi_select",
  ]),
  answer: z.union([
    z.string(),
    z.boolean(),
    z.number(),
    z.array(z.string()),
    zDecline,
    z.null(),
  ]),
  options: z.array(z.string()).optional(),
  updatedAt: z.string(),
});

// ----------------------------------------------------------------------------------------
// Top-level profile
// ----------------------------------------------------------------------------------------

export const applicantProfileSchema = z.object({
  id: z.string(),
  schemaVersion: z.number(),
  contact: contactInfoSchema,
  workAuthorization: workAuthorizationSchema,
  preferences: jobPreferencesSchema,
  screening: screeningAnswersSchema,
  selfId: selfIdentificationSchema,
  references: z.array(referenceSchema),
  positioning: positioningStatementSchema.optional(),
  dynamicAnswers: z.array(dynamicQaSchema),
  masterResumePath: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ----------------------------------------------------------------------------------------
// Compile-time drift guards: schema-inferred type MUST equal the canonical TS type.
// (No runtime effect — purely makes `tsc` fail if a schema and its type diverge.)
// ----------------------------------------------------------------------------------------

assertSchemaMatches<Equals<z.infer<typeof contactInfoSchema>, ContactInfo>>();
assertSchemaMatches<Equals<z.infer<typeof workAuthorizationSchema>, WorkAuthorization>>();
assertSchemaMatches<Equals<z.infer<typeof jobPreferencesSchema>, JobPreferences>>();
assertSchemaMatches<Equals<z.infer<typeof screeningAnswersSchema>, ScreeningAnswers>>();
assertSchemaMatches<Equals<z.infer<typeof veteranSelfIdSchema>, VeteranSelfId>>();
assertSchemaMatches<Equals<z.infer<typeof selfIdentificationSchema>, SelfIdentification>>();
assertSchemaMatches<Equals<z.infer<typeof positioningStatementSchema>, PositioningStatement>>();
assertSchemaMatches<Equals<z.infer<typeof referenceSchema>, Reference>>();
assertSchemaMatches<Equals<z.infer<typeof dynamicQaSchema>, DynamicQA>>();
assertSchemaMatches<Equals<z.infer<typeof applicantProfileSchema>, ApplicantProfile>>();

// Spot-check the generic Answer<T> helper against a representative instantiation.
assertSchemaMatches<
  Equals<z.infer<ReturnType<typeof answerSchema<z.ZodBoolean>>>, Answer<boolean>>
>();
