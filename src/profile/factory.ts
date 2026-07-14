// src/profile/factory.ts
//
// Builds a structurally-valid blank profile. Answer<T> fields start at value:null /
// source:"default" (== "not collected yet" — the wizard must ask), EXCEPT work authorization,
// which is seeded via the brief's seededWorkAuthorization() but still source:"default" so the
// wizard requires explicit user confirmation before first use.

import { randomUUID } from "node:crypto";
import {
  blankAnswer,
  seededWorkAuthorization,
  type ApplicantProfile,
} from "../types/applicant-profile";

export const PROFILE_SCHEMA_VERSION = 1;

export function createBlankProfile(id: string = randomUUID()): ApplicantProfile {
  const ts = new Date().toISOString();
  return {
    id,
    schemaVersion: PROFILE_SCHEMA_VERSION,
    contact: {
      legalFirstName: "",
      legalLastName: "",
      email: "",
      phone: "",
      address: {
        line1: "",
        city: "",
        state: "",
        postalCode: "",
        country: "US",
      },
      links: {},
    },
    workAuthorization: seededWorkAuthorization(),
    preferences: {
      earliestStartDate: blankAnswer<string>(),
      noticePeriodDays: blankAnswer<number>(),
      willingToRelocate: blankAnswer<boolean>(),
      workModePreference: blankAnswer<("remote" | "hybrid" | "onsite")[]>(),
      desiredLocations: [],
      targetRoles: [],
      targetIndustries: [],
      employmentTypes: [],
      companiesToAvoid: [],
      compensation: { currency: "USD", isNegotiable: true },
    },
    screening: {
      isAtLeast18: blankAnswer<boolean>(),
      canPerformEssentialFunctions: blankAnswer<boolean>(),
      requiresAccommodationForProcess: blankAnswer<boolean>(),
      previouslyEmployedHere: blankAnswer<boolean>(),
    },
    selfId: {
      gender: blankAnswer(),
      raceEthnicity: blankAnswer(),
      veteran: {
        status: blankAnswer(),
        categories: blankAnswer(),
      },
      disability: blankAnswer(),
    },
    references: [],
    dynamicAnswers: [],
    createdAt: ts,
    updatedAt: ts,
  };
}
