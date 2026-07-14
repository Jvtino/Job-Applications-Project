// src/profile/dynamic-qa.ts
//
// "Ask once, reuse forever." Any application question NOT modeled in the profile is asked a
// single time, stored keyed by a normalized signature, and reused on the next form that asks
// the same thing. The ORIGINAL phrasing is always retained for audit.

import type { Decline, DynamicQA } from "../types/applicant-profile";

/**
 * Normalize a rendered question into a stable signature so trivially-different phrasings of
 * the same question collide:
 *  - lowercase
 *  - strip a leading employer/company token pattern is NOT done here (we keep it generic);
 *    instead we drop punctuation and collapse whitespace, which handles the common cases
 *    ("How did you hear about us?" vs "How did you hear about us").
 */
export function normalizeQuestionSignature(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .replace(/[^a-z0-9\s]/g, " ") // punctuation -> space
    .replace(/\s+/g, " ")
    .trim();
}

export function findDynamicAnswer(
  answers: DynamicQA[],
  questionText: string
): DynamicQA | undefined {
  const key = normalizeQuestionSignature(questionText);
  return answers.find((a) => a.key === key);
}

export interface DynamicAnswerInput {
  questionText: string;
  fieldType: DynamicQA["fieldType"];
  answer: string | boolean | number | string[] | Decline | null;
  options?: string[];
}

/**
 * Insert or update a dynamic answer (matched by normalized signature). Returns a NEW array
 * (callers persist the resulting profile). The stored `questionText` is refreshed to the most
 * recent phrasing, but `key` stays stable.
 */
export function upsertDynamicAnswer(
  answers: DynamicQA[],
  input: DynamicAnswerInput
): DynamicQA[] {
  const key = normalizeQuestionSignature(input.questionText);
  const entry: DynamicQA = {
    key,
    questionText: input.questionText,
    fieldType: input.fieldType,
    answer: input.answer,
    ...(input.options ? { options: input.options } : {}),
    updatedAt: new Date().toISOString(),
  };
  const idx = answers.findIndex((a) => a.key === key);
  if (idx === -1) return [...answers, entry];
  const next = answers.slice();
  next[idx] = entry;
  return next;
}
