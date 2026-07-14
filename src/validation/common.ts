// src/validation/common.ts
//
// Shared Zod building blocks + a compile-time guarantee that every schema in this folder
// stays in lock-step with the canonical TypeScript types in src/types. The TS types are the
// single source of truth (the brief pins their exact content); these schemas are the runtime
// validators DERIVED from them. The `assertSchemaMatches` helper below turns any drift
// between a schema's inferred type and its TS type into a COMPILE error, so we never hand-
// write the shapes twice without the compiler noticing.

import { z } from "zod";
import { DECLINE } from "../types/applicant-profile";

/** The universal "I choose not to answer" marker, as a Zod literal. */
export const zDecline = z.literal(DECLINE);

/**
 * Zod analogue of `Answer<T>` from the profile types.
 *  value: T | Decline | null   (null = not collected yet; Decline = explicitly declined)
 *  source: provenance that drives the risk-weighted fill policy
 */
export function answerSchema<T extends z.ZodTypeAny>(value: T) {
  return z.object({
    value: z.union([value, zDecline, z.null()]),
    source: z.enum(["user", "inferred", "default"]),
    updatedAt: z.string(),
  });
}

/**
 * Exact (invariant) type-equality at the type level. Resolves to `true` only when A and B
 * are mutually assignable, so it catches both "too loose" and "too strict" schema drift.
 */
export type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

/**
 * Compile-time assertion: instantiate with `assertSchemaMatches<Equals<Infer, TsType>>()`.
 * If the schema's inferred output type and the canonical TS type ever diverge, `Equals`
 * becomes `false`, `false` does not satisfy `extends true`, and the build fails.
 */
export function assertSchemaMatches<_T extends true>(): void {
  /* type-level only; no runtime effect */
}
