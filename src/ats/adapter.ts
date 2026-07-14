// src/ats/adapter.ts
//
// ATS field-mapping layer: binds the clean profile enums to a live career-page form.
// This is the brittle, site-specific core of the app. Three concerns live here:
//   1. AtsAdapter      - per-ATS DOM knowledge: detect, enumerate fields, set/read a value,
//                        find the submit control, detect a human-verification challenge.
//   2. FieldMatcher    - resolve a rendered field to a profile value, with confidence +
//                        provenance. Layered: deterministic -> fuzzy -> LLM (last resort).
//   3. decideFillAction- risk-weighted gate that turns (match, mode, confidence) into an
//                        action. This is where "pause vs fill" is wired in.
//
// HARD RULES (enforced in decideFillAction):
//   - self_id and authorization values are NEVER auto-submitted unless user-confirmed
//     (source === "user"). Otherwise they pause, regardless of confidence or mode.
//   - An LLM-proposed match never clears a high-stakes or knockout field unattended.
//   - A required field with no resolved value always pauses. Never guess.
//   - manual mode never fills anything.

import type { ApplicantProfile, Answer, DynamicQA } from "../types/applicant-profile";

// ----------------------------------------------------------------------------------------
// Enums
// ----------------------------------------------------------------------------------------

export type OperatingMode = "manual" | "semi_auto" | "auto";

export type MatchMethod =
  | "exact" // deterministic exact key/label/option match -> confidence 1.0
  | "synonym" // per-ATS curated synonym map
  | "fuzzy" // string-similarity match
  | "llm" // model-proposed mapping (lowest trust)
  | "unmapped"; // no value found

/** The consequence tier of getting a field wrong — drives the gate, not raw confidence. */
export type FieldRisk =
  | "self_id" // EEO / veteran / disability -> wrong value = misrepresentation
  | "authorization" // work auth / sponsorship -> misrepresentation / wasted application
  | "knockout" // gating screening Q (18+, essential functions, clearance, prior employment)
  | "identity" // name/email/phone/address -> low ambiguity, must be exact
  | "compensation"
  | "low_stakes"; // "how did you hear about us", optional free-text

/** Control types the setter must handle differently. */
export type ControlType =
  | "text"
  | "textarea"
  | "number"
  | "email"
  | "phone"
  | "native_select" // real <select>
  | "custom_select" // div/role=listbox fake dropdown
  | "typeahead" // async dropdown: type, await results, click the match
  | "radio_group"
  | "checkbox"
  | "multi_checkbox"
  | "date"
  | "file_upload"
  | "url"
  | "unknown";

export type FillAction =
  | "fill" // set the value, then verify via readback
  | "fill_then_flag" // set it, but mark for human attention at the review gate
  | "pause_for_confirmation" // do NOT set; surface to the human and ask
  | "skip"; // leave blank (optional field, no value)

// ----------------------------------------------------------------------------------------
// Field + match descriptors
// ----------------------------------------------------------------------------------------

export interface FormField {
  /** Stable handle the adapter uses to act on the control (selector, a11y ref, etc.). */
  ref: string;
  /** Visible label / aria-label, exactly as rendered. */
  label: string;
  controlType: ControlType;
  required: boolean;
  /** For selects/radios/checkboxes: the options exactly as rendered (for matching). */
  options?: string[];
  /** Current on-page value, used for readback verification. */
  currentValue?: string | string[] | null;
  /** Which wizard step/section this field belongs to (multi-step forms). */
  step?: number;
}

export interface MatchResult {
  field: FormField;
  risk: FieldRisk;
  /** Value to enter, already mapped to the rendered option string(s) for selects. */
  resolvedValue: string | string[] | null;
  /** Provenance of the underlying profile answer, carried through to the gate. */
  source: Answer<unknown>["source"] | "dynamic_qa" | "none";
  method: MatchMethod;
  /** 0..1. Deterministic exact match = 1.0. */
  confidence: number;
  /** Human-readable reason, for the audit log and the review-gate UI. */
  rationale: string;
}

// ----------------------------------------------------------------------------------------
// Adapter + page abstraction
// ----------------------------------------------------------------------------------------

/** Thin wrapper over the live Playwright page/frame, so adapters stay testable. */
export interface PageContext {
  url: string;
  // Implementation wraps Playwright (query, click, type, selectOption, frames, etc.).
}

export interface AtsAdapter {
  /** Stable id, e.g. "greenhouse", "lever", "workday", "icims", "generic_fallback". */
  readonly name: string;

  /** True if this adapter recognizes the current page (URL patterns + DOM signatures). */
  detect(ctx: PageContext): Promise<boolean>;

  /** Enumerate the form's fields as a normalized list. Handles multi-step wizards. */
  getFields(ctx: PageContext): Promise<FormField[]>;

  /**
   * Set a value on a control. MUST dispatch whatever framework events the control needs
   * (a React-controlled input ignores a raw value assignment), and MUST handle typeaheads
   * by typing, awaiting the async list, and clicking the matching option.
   */
  setField(ctx: PageContext, field: FormField, value: string | string[]): Promise<void>;

  /** Re-read a control's value, for readback verification after setField. */
  readField(ctx: PageContext, field: FormField): Promise<string | string[] | null>;

  /** Locate the final submit control. Do NOT click it — the orchestrator gates submission. */
  findSubmitControl(ctx: PageContext): Promise<{ ref: string } | null>;

  /** Detect a CAPTCHA / human-verification challenge -> orchestrator surfaces the browser. */
  hasHumanChallenge(ctx: PageContext): Promise<boolean>;
}

// ----------------------------------------------------------------------------------------
// Multi-step (wizard) adapters — OPTIONAL extension of AtsAdapter
// ----------------------------------------------------------------------------------------

/**
 * A multi-PAGE application wizard (e.g. Workday: My Information -> My Experience -> Application
 * Questions -> Voluntary Disclosures -> Review -> Submit). Single-page adapters
 * (Greenhouse/Lever/Ashby/SmartRecruiters) do NOT implement this, so the single-page fill path is
 * entirely unchanged — the step loop (fillMultiStepApplication) runs ONLY when isMultiStep(adapter).
 *
 * The inherited getFields/setField/readField/findSubmitControl operate on the CURRENTLY-DISPLAYED
 * step; the three methods below drive navigation between steps.
 */
export interface MultiStepAtsAdapter extends AtsAdapter {
  /**
   * Locate the control that advances to the NEXT step ("Save and Continue" / "Next") — NOT the
   * final submit. Returns null when the current page has no advance control (treated as terminal).
   * MUST be distinct from findSubmitControl so the loop never mistakes an intermediate advance for
   * the final submission.
   */
  findNextControl(ctx: PageContext): Promise<{ ref: string } | null>;

  /** True when the current step is the final one (Review/Submit) — no further advance. */
  isFinalStep(ctx: PageContext): Promise<boolean>;

  /** Click the advance control and wait for the next step to render/hydrate. */
  advanceStep(ctx: PageContext): Promise<void>;
}

/** Runtime guard: does this adapter drive a multi-step wizard? */
export function isMultiStep(adapter: AtsAdapter): adapter is MultiStepAtsAdapter {
  const a = adapter as Partial<MultiStepAtsAdapter>;
  return (
    typeof a.findNextControl === "function" &&
    typeof a.isFinalStep === "function" &&
    typeof a.advanceStep === "function"
  );
}

// ----------------------------------------------------------------------------------------
// Matcher
// ----------------------------------------------------------------------------------------

/**
 * Resolves a rendered FormField to a profile value with confidence + provenance.
 *
 * Implement as a LAYERED matcher to control both error rate and LLM cost:
 *   1. deterministic synonym/exact map per ATS (confidence ~1.0, no model call)
 *   2. fuzzy string similarity against options/labels
 *   3. LLM proposal as a LAST resort
 * The LLM layer must never report confidence in the high band for self_id / authorization /
 * knockout fields — those should pause unless step 1 matched AND the value is user-confirmed.
 */
export interface FieldMatcher {
  classifyRisk(field: FormField): FieldRisk;
  match(
    field: FormField,
    profile: ApplicantProfile,
    dynamicAnswers: DynamicQA[]
  ): Promise<MatchResult>;
}

// ----------------------------------------------------------------------------------------
// Risk-weighted fill policy  (the "pause vs fill" decision, wired in)
// ----------------------------------------------------------------------------------------

export interface FillPolicyConfig {
  /** Tune to taste; these are conservative starting points. */
  highConfidence: number; // e.g. 0.90
  mediumConfidence: number; // e.g. 0.70
}

export const DEFAULT_POLICY: FillPolicyConfig = {
  highConfidence: 0.75,
  mediumConfidence: 0.55,
};

export function decideFillAction(
  m: MatchResult,
  mode: OperatingMode,
  cfg: FillPolicyConfig = DEFAULT_POLICY
): FillAction {
  if (mode === "manual") return "skip";

  const hasValue =
    m.resolvedValue !== null &&
    !(Array.isArray(m.resolvedValue) && m.resolvedValue.length === 0);

  // Never guess a required field we couldn't map; never fill an empty optional.
  if (m.field.required && !hasValue) return "pause_for_confirmation";
  if (!hasValue) return "skip";

  const userConfirmed = m.source === "user";
  const highStakes = m.risk === "self_id" || m.risk === "authorization";
  const gating = m.risk === "knockout";

  // Misrepresentation guard (brief A5): a self-ID (EEO/veteran/disability) or work-authorization
  // value that the user has NOT confirmed (source !== "user") must NEVER be typed/selected into an
  // employer form — in ANY non-manual mode. Placing an inferred/default value there is
  // misrepresentation, not merely an unreviewed fill. So: do not set a value; surface it for the
  // human to answer. (Previously semi_auto did a fill_then_flag; that still put a value on the page.)
  if (highStakes && !userConfirmed) {
    return "pause_for_confirmation";
  }

  if (mode === "auto") {
    if (m.confidence < cfg.highConfidence) return "pause_for_confirmation";
    // Extra bar on stakes: no LLM-proposed match, must be user-confirmed.
    if ((highStakes || gating) && !userConfirmed) return "pause_for_confirmation";
    if ((highStakes || gating) && m.method === "llm") return "pause_for_confirmation";
    return "fill";
  }

  // semi_auto: fill confidently, flag the shaky ones; the review gate catches everything.
  if (m.confidence >= cfg.highConfidence) return "fill";
  if (m.confidence >= cfg.mediumConfidence) return "fill_then_flag";
  return "pause_for_confirmation";
}

// ----------------------------------------------------------------------------------------
// Fill loop  (match -> decide -> fill + verify readback -> escalate)
// ----------------------------------------------------------------------------------------

export interface FillReport {
  filled: MatchResult[];
  flaggedForReview: MatchResult[]; // fill_then_flag
  needsConfirmation: MatchResult[]; // pause_for_confirmation
  challengeDetected: boolean;
}

export interface FillApplicationOptions {
  cfg?: FillPolicyConfig;
  pageUrl?: string;
  resolveChallenge?: (ctx: PageContext) => Promise<"clear" | "blocked">;
  /**
   * Human-like pause between fields (the BrowserSession's pace()). Awaited before each field is set,
   * so the form fills field-by-field with randomized delays instead of instantly. Omitted in unit
   * tests (no delay). This is pacing, not anti-bot evasion — the app already paces page opens.
   */
  pace?: () => Promise<void>;
}

export async function fillApplication(
  adapter: AtsAdapter,
  matcher: FieldMatcher,
  ctx: PageContext,
  profile: ApplicantProfile,
  mode: OperatingMode,
  opts: FillApplicationOptions = {}
): Promise<FillReport> {
  const cfg = opts.cfg ?? DEFAULT_POLICY;
  const checkChallenge = async (): Promise<boolean> => {
    if (opts.resolveChallenge) {
      const outcome = await opts.resolveChallenge(ctx);
      return outcome === "blocked";
    }
    return adapter.hasHumanChallenge(ctx);
  };
  const report: FillReport = {
    filled: [],
    flaggedForReview: [],
    needsConfirmation: [],
    challengeDetected: false,
  };

  // A challenge at any point means: stop, surface the live browser to the human.
  if (await checkChallenge()) {
    report.challengeDetected = true;
    return report;
  }

  const fields = await adapter.getFields(ctx);

  for (const field of fields) {
    const m = await matcher.match(field, profile, profile.dynamicAnswers);
    const action = decideFillAction(m, mode, cfg);

    if (action === "skip") continue;
    if (action === "pause_for_confirmation") {
      report.needsConfirmation.push(m);
      continue;
    }

    // fill or fill_then_flag: pause like a human, set the value, then confirm it actually took.
    await opts.pace?.();
    await adapter.setField(ctx, field, m.resolvedValue as string | string[]);
    const readback = await adapter.readField(ctx, field);

    if (!valuesEqual(readback, m.resolvedValue)) {
      // Event/controlled-component issue, or the wrong option was selected. Don't trust it.
      report.needsConfirmation.push({
        ...m,
        rationale: m.rationale + " | readback mismatch",
      });
      continue;
    }

    if (action === "fill_then_flag") report.flaggedForReview.push(m);
    else report.filled.push(m);

    // A challenge can appear mid-fill (e.g., after an email field).
    if (await checkChallenge()) {
      report.challengeDetected = true;
      return report;
    }
  }

  return report;
}

/** AUTO may submit when no challenge, no needsConfirmation (flagged fields are OK). */
export function canAutoSubmit(report: FillReport, mode: OperatingMode): boolean {
  return mode === "auto" && !report.challengeDetected && report.needsConfirmation.length === 0;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x) => b.includes(x));
  }
  return a === b;
}
