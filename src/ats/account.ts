// src/ats/account.ts
//
// Account/login wall handling — the COMPLIANT path for "this career site requires an account."
// Hard constraint #5: never auto-create accounts, never auto-enter passwords, hand off to the
// user. So this module ONLY:
//   - detects a registration/login form and classifies it,
//   - pre-fills the NON-SECRET fields (email, name, phone) — never a password field,
//   - never clicks the create/submit/sign-in control,
//   - optionally generates a strong password and copies it to the user's clipboard for THEM to
//     paste and save in their password manager (the app never stores or types it).
// The orchestrator then pauses and hands the live browser to the user.

import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import type { ContactInfo } from "../types/applicant-profile";
import type { PageContext } from "./adapter";
import { pwPage } from "./page-context";

export type AccountFieldRole = "email" | "first_name" | "last_name" | "full_name" | "phone";

export interface AccountWall {
  kind: "register" | "login";
  passwordFields: number;
  /** Non-secret fields we can safely pre-fill (NEVER includes password fields). */
  fields: { ref: string; role: AccountFieldRole; label: string }[];
  submitText: string;
  /** Which signal tripped detection (password / sso / magic_link / verification / email_first / url). */
  signal?: string;
}

/**
 * Detect a registration/login wall on the current page. Returns null if there is none.
 *
 * Beyond classic password forms, this catches the passwordless walls modern ATSes use — SSO
 * ("Continue with Google/LinkedIn"), magic links, email verification codes, and email-first
 * "create your account" screens — because none of those have a password field to key off of.
 *
 * Guard against false positives: if the page carries a REAL application form (a resume/file upload,
 * a free-text/cover-letter box, or several applicant inputs), it is treated as an apply form, NOT a
 * wall — a "Sign in" link in the header of an application page must never pause the fill.
 */
export async function inspectAccountWall(ctx: PageContext): Promise<AccountWall | null> {
  const page = pwPage(ctx);
  return page.evaluate(() => {
    const norm = (s: string | null) => (s || "").replace(/\s+/g, " ").trim();
    const visible = (el: Element) => {
      const s = window.getComputedStyle(el as HTMLElement);
      return s.display !== "none" && s.visibility !== "hidden";
    };
    const passwords = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="password"]')).filter(visible);

    const labelFor = (el: Element): string => {
      const id = el.getAttribute("id");
      if (id) {
        const l = document.querySelector(`label[for="${id.replace(/["\\]/g, "\\$&")}"]`);
        if (l) return norm(l.textContent);
      }
      const wrap = el.closest("label");
      return norm(wrap?.textContent ?? el.getAttribute("aria-label") ?? el.getAttribute("placeholder") ?? el.getAttribute("name"));
    };

    let counter = 0;
    const tag = (el: Element): string => {
      let r = el.getAttribute("data-ap-acct");
      if (!r) {
        r = "acct-" + counter++;
        el.setAttribute("data-ap-acct", r);
      }
      return r;
    };

    const collectFields = (root: Element): { ref: string; role: string; label: string }[] => {
      const out: { ref: string; role: string; label: string }[] = [];
      const inputs = Array.from(root.querySelectorAll<HTMLInputElement>("input")).filter(visible);
      for (const el of inputs) {
        const type = (el.getAttribute("type") || "text").toLowerCase();
        if (["password", "hidden", "submit", "button", "checkbox", "radio", "file"].includes(type)) continue;
        const hay = `${el.getAttribute("name") || ""} ${el.getAttribute("id") || ""} ${labelFor(el)} ${el.getAttribute("autocomplete") || ""}`.toLowerCase();
        let role: string | null = null;
        if (type === "email" || /e-?mail|username|user name/.test(hay)) role = "email";
        else if (/first ?name|given|fname/.test(hay)) role = "first_name";
        else if (/last ?name|surname|family|lname/.test(hay)) role = "last_name";
        else if (type === "tel" || /phone|mobile|tel/.test(hay)) role = "phone";
        else if (/full ?name|^name$|your name/.test(hay)) role = "full_name";
        if (role) out.push({ ref: tag(el), role, label: labelFor(el) || role });
      }
      return out;
    };

    const url = (location.href || "").toLowerCase();
    const bodyText = norm(document.body.innerText).toLowerCase().slice(0, 6000);
    const controlText = Array.from(document.querySelectorAll('button, input[type="submit"], [role="button"], a'))
      .filter(visible)
      .map((b) => `${norm(b.textContent)} ${norm(b.getAttribute("value"))}`)
      .join(" ")
      .toLowerCase();
    const authText = `${controlText} ${bodyText}`;

    // --- application-form signals: if present, this is an apply page, not an account wall. ---
    const fileInputs = Array.from(document.querySelectorAll('input[type="file"]')).filter(visible);
    const textareas = Array.from(document.querySelectorAll("textarea")).filter(visible);
    const applicantInputs = Array.from(document.querySelectorAll<HTMLInputElement>("input")).filter(visible).filter((el) => {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      return !["password", "hidden", "submit", "button", "checkbox", "radio", "file"].includes(t);
    });
    const resumeMention = /\b(resume|résumé|\bcv\b|cover letter|upload your)\b/.test(bodyText);
    const hasApplicationForm = fileInputs.length > 0 || textareas.length >= 1 || applicantInputs.length >= 4 || resumeMention;

    // --- classic password-based wall (unchanged behavior) ---
    if (passwords.length > 0) {
      const form = passwords[0]!.closest("form") ?? document.body;
      const fields = collectFields(form);
      const confirmPw =
        passwords.length >= 2 ||
        passwords.some((p) => /confirm|re-?enter|repeat/.test(`${p.getAttribute("name") || ""} ${p.getAttribute("id") || ""}`.toLowerCase()));
      const registerCue = /(sign ?up|create (an )?account|register|join|get started)/.test(authText);
      const loginCue = /(sign ?in|log ?in)/.test(controlText);
      const kind: "register" | "login" = registerCue || (confirmPw && !loginCue) ? "register" : "login";
      return {
        kind,
        passwordFields: passwords.length,
        fields: fields as AccountWallFields,
        submitText: controlText.slice(0, 120),
        signal: "password",
      };
    }

    // --- passwordless walls (SSO / magic link / verification code / email-first) ---
    const ssoCue =
      /(continue|sign ?in|log ?in|sign ?up)\s+with\s+(google|linkedin|apple|microsoft|okta|github|facebook|sso|saml|your\s+\w+\s+account)/.test(authText) ||
      /\b(single sign-?on|use sso|continue with sso)\b/.test(authText);
    const magicLink = /\b(magic link|email me a (sign-?in )?link|passwordless sign-?in|we'?ll email you a link)\b/.test(authText);
    const verification = /\b(verification code|one-?time (code|password|passcode|pin)|\botp\b|enter the code|6-digit code|check your (email|inbox)|we (sent|emailed) you (a|an) (code|link|email))\b/.test(authText);
    const loginCue = /\b(sign ?in|log ?in)\b/.test(controlText);
    const registerCue = /\b(sign ?up|create (an )?account|register|join now|get started)\b/.test(authText);
    const urlAuth = /\/(log-?in|sign-?in|sign_in|auth|authenticate|account|accounts|register|sign-?up|sso|session)(\/|\?|#|$)/.test(url);

    const emailish = collectFields(document.body).filter((f) => f.role === "email");
    // "email-first" wall: an email box + an auth CTA, and NOTHING that looks like an application.
    const emailFirstWall = emailish.length >= 1 && applicantInputs.length <= 2 && (loginCue || registerCue || urlAuth);
    const strongAuth = ssoCue || magicLink || verification;

    if (!hasApplicationForm && (strongAuth || emailFirstWall)) {
      const fields = collectFields(document.body);
      const kind: "register" | "login" = registerCue && !loginCue ? "register" : "login";
      const signal = ssoCue ? "sso" : magicLink ? "magic_link" : verification ? "verification" : emailFirstWall ? "email_first" : "url";
      return {
        kind,
        passwordFields: 0,
        fields: fields as AccountWallFields,
        submitText: controlText.slice(0, 120),
        signal,
      };
    }

    return null;
  }) as Promise<AccountWall | null>;
}

// Local alias so the in-page object literal typechecks against our exported shape.
type AccountWallFields = AccountWall["fields"];

/**
 * Pre-fill the NON-SECRET fields of a registration form. NEVER touches password fields and
 * NEVER submits. Returns the labels it filled.
 */
export async function prefillRegistration(ctx: PageContext, contact: ContactInfo, wall: AccountWall): Promise<string[]> {
  const page = pwPage(ctx);
  const filled: string[] = [];
  const valueFor = (role: AccountFieldRole): string | undefined => {
    switch (role) {
      case "email":
        return contact.email || undefined;
      case "first_name":
        return contact.legalFirstName || undefined;
      case "last_name":
        return contact.legalLastName || undefined;
      case "full_name":
        return `${contact.preferredName || contact.legalFirstName} ${contact.legalLastName}`.trim() || undefined;
      case "phone":
        return contact.phone || undefined;
    }
  };
  for (const f of wall.fields) {
    const value = valueFor(f.role);
    if (!value) continue;
    const loc = page.locator(`[data-ap-acct="${f.ref.replace(/["\\]/g, "\\$&")}"]`);
    await loc.fill(value).catch(() => {});
    await loc.dispatchEvent("change").catch(() => {});
    filled.push(f.label);
  }
  // Deliberately: no password is set, and no submit/create button is clicked.
  return filled;
}

const LOWER = "abcdefghijkmnpqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGIT = "23456789";
const SYM = "!@#$%^&*-_=+";

/** Generate a strong random password for the USER to use (the app never stores or types it). */
export function generatePassword(length = 20): string {
  const all = LOWER + UPPER + DIGIT + SYM;
  const pick = (set: string) => set[randomInt(set.length)]!;
  const chars = [pick(LOWER), pick(UPPER), pick(DIGIT), pick(SYM)];
  while (chars.length < length) chars.push(pick(all));
  // Fisher-Yates shuffle so the guaranteed-class chars aren't always first.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}

/** Copy text to the macOS clipboard via pbcopy. Best-effort; never persisted by the app. */
export function copyToClipboard(text: string): Promise<boolean> {
  if (process.platform !== "darwin") return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      const p = spawn("pbcopy");
      p.on("error", () => resolve(false));
      p.on("close", (code) => resolve(code === 0));
      p.stdin.end(text);
    } catch {
      resolve(false);
    }
  });
}

// ----------------------------------------------------------------------------------------
// Owner-approved auto-login + assisted account creation (amendment 2026-07-06).
// These type a password into the page — permitted ONLY for the user's OWN saved credential or an
// app-created account, backed by the encrypted credential vault. The secret is NEVER logged, and the
// app STILL never solves a CAPTCHA and STILL hands off at email verification (the orchestrator pauses
// after a signup submit). See BUILD_BRIEF.md / CLAUDE.md.
// ----------------------------------------------------------------------------------------

/** Fill every visible password field with `password` (dispatching framework events). Returns the
 *  count filled. The value is never logged. */
export async function fillPasswordFields(ctx: PageContext, password: string): Promise<number> {
  const page = pwPage(ctx);
  const refs = (await page.evaluate(() => {
    const visible = (el: Element) => {
      const s = window.getComputedStyle(el as HTMLElement);
      return s.display !== "none" && s.visibility !== "hidden";
    };
    const pws = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="password"]')).filter(visible);
    return pws.map((el, i) => {
      const r = "ap-pw-" + i;
      el.setAttribute("data-ap-pw", r);
      return r;
    });
  })) as string[];
  for (const r of refs) {
    const loc = page.locator(`[data-ap-pw="${r.replace(/["\\]/g, "\\$&")}"]`);
    await loc.fill(password).catch(() => {});
    await loc.dispatchEvent("change").catch(() => {});
    await loc.dispatchEvent("blur").catch(() => {});
  }
  return refs.length;
}

/** Click the account form's submit / sign-in / create control, then wait for the page to settle. */
export async function submitAccountForm(ctx: PageContext, wall: AccountWall): Promise<void> {
  const page = pwPage(ctx);
  await page.evaluate((hint) => {
    const norm = (s: string | null) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
    const controls = Array.from(document.querySelectorAll<HTMLElement>('button, input[type="submit"], [role="button"]')).filter((el) => {
      const s = window.getComputedStyle(el);
      return s.display !== "none" && s.visibility !== "hidden";
    });
    const cta = /\b(sign ?in|log ?in|create account|create your account|sign ?up|register|continue|submit)\b/;
    const h = norm(hint).slice(0, 24);
    const byHint = h ? controls.find((b) => norm(b.textContent).includes(h) || norm(b.getAttribute("value")).includes(h)) : undefined;
    const btn = byHint ?? controls.find((b) => cta.test(`${norm(b.textContent)} ${norm(b.getAttribute("value"))}`));
    btn?.click();
  }, wall.submitText || "");
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
}

/** Auto-fill a SAVED login (email/username + password) and submit. Returns true if it submitted. */
export async function autoFillLogin(
  ctx: PageContext,
  wall: AccountWall,
  credential: { email: string; password: string }
): Promise<boolean> {
  const page = pwPage(ctx);
  for (const f of wall.fields) {
    if (f.role === "email") {
      const loc = page.locator(`[data-ap-acct="${f.ref.replace(/["\\]/g, "\\$&")}"]`);
      await loc.fill(credential.email).catch(() => {});
      await loc.dispatchEvent("change").catch(() => {});
    }
  }
  const filled = await fillPasswordFields(ctx, credential.password);
  if (filled === 0) return false; // no password field found — don't blind-submit
  await submitAccountForm(ctx, wall);
  return true;
}
