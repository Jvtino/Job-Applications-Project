// src/ats/greenhouse.ts
//
// Greenhouse ATS adapter — the FIRST adapter, built end-to-end before generalizing. Handles
// both the classic boards.greenhouse.io markup and the newer job-boards.greenhouse.io markup
// by enumerating LABELED controls generically rather than hardcoding every id (layouts change
// often). All DOM knowledge is isolated here.
//
// Selectors are made stable by tagging each control with a `data-ap-ref` attribute during
// getFields, so setField/readField act on the exact same element later.

import type { AtsAdapter, FormField, PageContext } from "./adapter";
import { pwPage } from "./page-context";

// NOTE: this adapter's field engine (getFields/setField/readField/findSubmitControl/
// hasHumanChallenge + enumerateFields) is fully GENERIC — it works off labels, not Greenhouse
// ids. Lever/Ashby/generic-fallback adapters subclass this and override only `name` + `detect`.
export class GreenhouseAdapter implements AtsAdapter {
  readonly name: string = "greenhouse";

  async detect(ctx: PageContext): Promise<boolean> {
    const page = pwPage(ctx);
    const url = page.url();
    try {
      const host = new URL(url).host;
      if (/(?:^|\.)greenhouse\.io$/i.test(host) || /grnhse|greenhouse/i.test(url)) return true;
    } catch {
      /* not a parseable URL (e.g. file://) — fall through to DOM signature */
    }
    // Greenhouse-SPECIFIC markers only. The old "#first_name && #email" core was dropped: a bare
    // first-name/email pair is not Greenhouse-specific (most application forms have it), so it
    // mislabeled plain forms as "greenhouse" — and greenhouse is auto-submit-allowlisted, which a
    // truly-unknown form must not be. Real Greenhouse forms carry a greenhouse host (caught above) or
    // one of these markers; anything else falls through to the generic fallback (decideAutoSubmit
    // always QUEUES ats==="generic", never auto-submits it).
    return page.evaluate(() =>
      Boolean(
        document.querySelector(
          'form#application-form, form#application_form, #application_form, #grnhse_app, ' +
            'form[action*="greenhouse"], [data-source="greenhouse"], [data-ats="greenhouse"]'
        )
      )
    );
  }

  async getFields(ctx: PageContext): Promise<FormField[]> {
    const page = pwPage(ctx);
    const raw = await page.evaluate(enumerateFields);
    return raw as FormField[];
  }

  async setField(ctx: PageContext, field: FormField, value: string | string[]): Promise<void> {
    const page = pwPage(ctx);
    const values = Array.isArray(value) ? value.map(String) : [String(value)];
    const first = values[0] ?? "";

    if (field.ref.startsWith("radio:")) {
      const name = field.ref.slice("radio:".length);
      await page.evaluate(
        ({ name, target }) => {
          const esc = (s: string) => s.replace(/["\\]/g, "\\$&");
          const norm = (s: string | null) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
          const labelText = (r: Element): string => {
            const id = r.getAttribute("id");
            if (id) {
              const l = document.querySelector(`label[for="${esc(id)}"]`);
              if (l) return l.textContent || "";
            }
            const wl = r.closest("label");
            return wl ? wl.textContent || "" : r.getAttribute("value") || "";
          };
          const radios = Array.from(
            document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${esc(name)}"]`)
          );
          const match =
            radios.find((r) => norm(labelText(r)) === norm(target)) ||
            radios.find((r) => norm(labelText(r)).includes(norm(target)));
          if (match) {
            match.checked = true;
            match.click();
            match.dispatchEvent(new Event("change", { bubbles: true }));
          }
        },
        { name, target: first }
      );
      return;
    }

    const setRef = await this.resolveRef(ctx, field);
    const setField = setRef !== field.ref ? { ...field, ref: setRef } : field;
    await stabilizeFieldRef(ctx, setField);
    const loc = page.locator(refSelector(setField.ref));
    switch (field.controlType) {
      case "native_select":
        try {
          await loc.selectOption({ label: first });
        } catch {
          await loc.selectOption(first).catch(() => loc.selectOption({ value: first }));
        }
        await loc.dispatchEvent("change").catch(() => {});
        break;
      case "checkbox": {
        const truthy =
          ["true", "yes", "1", "on"].includes(first.toLowerCase()) || first === field.label;
        if (truthy) await loc.check();
        else await loc.uncheck();
        break;
      }
      case "custom_select":
      case "typeahead":
        await this.setCustomSelect(ctx, field, first);
        break;
      case "file_upload":
        await loc.setInputFiles(values);
        break;
      case "text":
      case "textarea":
      case "email":
      case "phone":
      case "number":
      case "url":
      case "date":
      default:
        await loc.fill(first);
        await loc.dispatchEvent("change").catch(() => {});
        await loc.dispatchEvent("blur").catch(() => {});
        break;
    }
  }

  /** Open a custom/react-select dropdown, wait for the option list, click the match. */
  private async setCustomSelect(ctx: PageContext, field: FormField, value: string): Promise<void> {
    const page = pwPage(ctx);
    const csRef = await this.resolveRef(ctx, field);
    const csField = csRef !== field.ref ? { ...field, ref: csRef } : field;
    await stabilizeFieldRef(ctx, csField);
    const control = page.locator(refSelector(csField.ref));
    await control.click();
    // Typeaheads filter as you type; harmless for static lists too. Use a short timeout so a
    // dropdown WITHOUT an inner text input (a plain custom select) doesn't stall on the wait.
    const inner = control.locator('input, [contenteditable="true"]').first();
    if (await inner.count()) {
      await inner.fill(value, { timeout: 1000 }).catch(() => {});
    }
    const option = page
      .locator('[role="option"], li[role="option"], .select__option, .select2-results__option')
      .filter({ hasText: value })
      .first();
    await option.waitFor({ state: "visible", timeout: 5000 });
    await option.click();
  }

  async readField(ctx: PageContext, field: FormField): Promise<string | string[] | null> {
    const page = pwPage(ctx);

    if (field.ref.startsWith("radio:")) {
      const name = field.ref.slice("radio:".length);
      return page.evaluate((name) => {
        const esc = (s: string) => s.replace(/["\\]/g, "\\$&");
        const labelText = (r: Element): string => {
          const id = r.getAttribute("id");
          if (id) {
            const l = document.querySelector(`label[for="${esc(id)}"]`);
            if (l) return (l.textContent || "").replace(/\s+/g, " ").trim();
          }
          const wl = r.closest("label");
          return ((wl ? wl.textContent : r.getAttribute("value")) || "").replace(/\s+/g, " ").trim();
        };
        const checked = document.querySelector<HTMLInputElement>(
          `input[type="radio"][name="${esc(name)}"]:checked`
        );
        return checked ? labelText(checked) : null;
      }, name);
    }

    const readRef = await this.resolveRef(ctx, field);
    const readField = readRef !== field.ref ? { ...field, ref: readRef } : field;
    await stabilizeFieldRef(ctx, readField);
    const loc = page.locator(refSelector(readField.ref));
    switch (field.controlType) {
      case "native_select":
        return loc.evaluate((el) => {
          const s = el as HTMLSelectElement;
          return s.selectedIndex >= 0
            ? (s.options[s.selectedIndex]?.textContent || "").replace(/\s+/g, " ").trim()
            : null;
        });
      case "checkbox":
        return (await loc.isChecked()) ? field.label || "true" : null;
      case "custom_select":
      case "typeahead":
        return loc.evaluate((el) => (el.textContent || "").replace(/\s+/g, " ").trim() || null);
      case "file_upload":
        return loc.evaluate((el) => {
          const f = (el as HTMLInputElement).files;
          return f && f.length ? f[0]!.name : null;
        });
      default:
        return loc.inputValue();
    }
  }

  /**
   * Return the current live ref for a field. On SPA forms, filling one field can trigger a
   * React/Vue re-render that destroys and recreates DOM elements, wiping the data-ap-ref tags we
   * injected during getFields(). If the tagged element is gone, re-enumerate the whole form to
   * re-tag it, then match the old field by label + controlType to get its new ref.
   */
  private async resolveRef(ctx: PageContext, field: FormField): Promise<string> {
    const page = pwPage(ctx);
    const count = await page.locator(refSelector(field.ref)).count();
    if (count > 0) return field.ref;
    const fresh = await this.getFields(ctx);
    const match =
      fresh.find((f) => f.label === field.label && f.controlType === field.controlType) ??
      fresh.find((f) => f.label === field.label);
    return match?.ref ?? field.ref;
  }

  async findSubmitControl(ctx: PageContext): Promise<{ ref: string } | null> {
    const page = pwPage(ctx);
    const ref = await page.evaluate(() => {
      const norm = (s: string | null) => (s || "").toLowerCase();
      const candidates = Array.from(
        document.querySelectorAll('button, input[type="submit"], [role="button"]')
      );
      const btn = candidates.find((b) =>
        /(submit application|submit|apply now|apply)\b/.test(
          norm(b.textContent) + " " + norm(b.getAttribute("value"))
        )
      );
      if (!btn) return null;
      let r = btn.getAttribute("data-ap-ref");
      if (!r) {
        r = "apf-submit";
        btn.setAttribute("data-ap-ref", r);
      }
      return r;
    });
    return ref ? { ref } : null;
  }

  async hasHumanChallenge(ctx: PageContext): Promise<boolean> {
    const page = pwPage(ctx);
    return page.evaluate(() => {
      const challenge = document.querySelector(
        'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], ' +
          'iframe[title*="captcha" i], .g-recaptcha, [class*="hcaptcha"], #cf-challenge-running'
      );
      if (challenge) return true;
      // Login wall / password prompt -> we must hand off (never auto-enter passwords).
      if (document.querySelector('input[type="password"]')) return true;
      const body = (document.body?.innerText || "").toLowerCase();
      return /(sign in|log in) to (continue|apply)/.test(body);
    });
  }
}

function refSelector(ref: string): string {
  return `[data-ap-ref="${ref.replace(/["\\]/g, "\\$&")}"]`;
}

async function stabilizeFieldRef(ctx: PageContext, field: FormField): Promise<void> {
  const page = pwPage(ctx);
  await page.evaluate(({ ref, label, controlType }) => {
    const esc = (s: string) => s.replace(/["\\]/g, "\\$&");
    const clean = (s: string | null | undefined) => (s || "").replace(/\s+/g, " ").trim();
    const norm = (s: string | null | undefined) => clean(s).toLowerCase();
    const labelNeedle = norm(label);
    const selector = `[data-ap-ref="${esc(ref)}"]`;
    const candidates = Array.from(document.querySelectorAll<HTMLElement>(selector));
    if (candidates.length <= 1) return;

    const labelFor = (el: Element): string => {
      const aria = el.getAttribute("aria-label");
      if (aria) return clean(aria);
      const labelledby = el.getAttribute("aria-labelledby");
      if (labelledby) {
        const parts = labelledby
          .split(/\s+/)
          .map((id) => clean(document.getElementById(id)?.textContent))
          .filter(Boolean);
        if (parts.length) return parts.join(" ");
      }
      const id = el.getAttribute("id");
      if (id) {
        const lbl = document.querySelector(`label[for="${esc(id)}"]`);
        if (lbl) return clean(lbl.textContent);
      }
      const wrapLabel = el.closest("label");
      if (wrapLabel) return clean(wrapLabel.textContent);
      const container = el.closest('.field, fieldset, [class*="field"]');
      if (container) {
        const lbl = container.querySelector("label, legend, .label");
        if (lbl) return clean(lbl.textContent);
      }
      return clean(el.getAttribute("name")) || clean(el.getAttribute("placeholder")) || "";
    };

    const inferredControlType = (el: Element): string => {
      const tagName = el.tagName.toLowerCase();
      const typeAttr = (el.getAttribute("type") || "").toLowerCase();
      if (tagName === "textarea") return "textarea";
      if (tagName === "select") return "native_select";
      if (tagName === "input" && typeAttr === "checkbox") return "checkbox";
      if (tagName === "input" && typeAttr === "file") return "file_upload";
      if (el.getAttribute("role") === "combobox" || el.classList.contains("select2")) return "custom_select";
      const map: Record<string, string> = {
        email: "email",
        tel: "phone",
        url: "url",
        number: "number",
        date: "date",
      };
      return map[typeAttr] || "text";
    };

    const visibleScore = (el: HTMLElement): number => {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return -40;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 ? 12 : 0;
    };

    const controlMatches = (actual: string): boolean => {
      if (controlType === actual) return true;
      if (controlType === "typeahead" && actual === "custom_select") return true;
      if (controlType === "phone" && actual === "text") return true;
      return false;
    };

    const score = (el: HTMLElement): number => {
      const actual = inferredControlType(el);
      const candidateLabel = norm(labelFor(el));
      const idName = norm(`${el.getAttribute("id") || ""} ${el.getAttribute("name") || ""}`);
      let s = visibleScore(el);
      if (controlMatches(actual)) s += 80;
      if (candidateLabel && candidateLabel === labelNeedle) s += 80;
      else if (candidateLabel && labelNeedle && candidateLabel.includes(labelNeedle)) s += 45;
      else if (candidateLabel && labelNeedle && labelNeedle.includes(candidateLabel)) s += 25;
      if (idName && labelNeedle && labelNeedle.split(/\s+/).every((part) => idName.includes(part))) s += 35;
      if ((el.getAttribute("type") || "").toLowerCase() === "search" && !/search/i.test(label)) s -= 80;
      if (/^search$/i.test(el.getAttribute("placeholder") || "") && !/search/i.test(label)) s -= 50;
      return s;
    };

    const target = candidates
      .map((el, index) => ({ el, index, score: score(el) }))
      .sort((a, b) => b.score - a.score || a.index - b.index)[0]?.el;
    if (!target) return;

    candidates.forEach((el, index) => {
      if (el !== target) el.setAttribute("data-ap-ref", `${ref}--duplicate-${index + 1}`);
    });
  }, field);
}

// ----------------------------------------------------------------------------------------
// In-browser field enumeration (runs in the page; uses DOM only, no closure over Node).
// ----------------------------------------------------------------------------------------

function enumerateFields(): unknown {
  let counter = 0;
  const esc = (s: string) => s.replace(/["\\]/g, "\\$&");
  const clean = (s: string | null | undefined) => (s || "").replace(/\s+/g, " ").trim();

  const tag = (el: Element): string => {
    let r = el.getAttribute("data-ap-ref");
    if (!r) {
      r = "apf-" + counter++;
      el.setAttribute("data-ap-ref", r);
    }
    return r;
  };

  const labelFor = (el: Element): string => {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const parts = labelledby
        .split(/\s+/)
        .map((id) => clean(document.getElementById(id)?.textContent))
        .filter(Boolean);
      if (parts.length) return parts.join(" ");
    }
    const id = el.getAttribute("id");
    if (id) {
      const lbl = document.querySelector(`label[for="${esc(id)}"]`);
      if (lbl) return clean(lbl.textContent);
    }
    const wrapLabel = el.closest("label");
    if (wrapLabel) return clean(wrapLabel.textContent);
    const container = el.closest('.field, fieldset, [class*="field"]');
    if (container) {
      const lbl = container.querySelector("label, legend, .label");
      if (lbl) return clean(lbl.textContent);
    }
    return clean(el.getAttribute("name")) || clean(el.getAttribute("placeholder")) || "";
  };

  const requiredOf = (el: Element, label: string): boolean => {
    if ((el as HTMLInputElement).required) return true;
    if (el.getAttribute("aria-required") === "true") return true;
    if (/\*\s*$/.test(label) || /\(required\)/i.test(label)) return true;
    const container = el.closest('.field, fieldset, [class*="field"]');
    if (
      container &&
      (container.classList.contains("required") ||
        container.querySelector('.required, [aria-required="true"]'))
    )
      return true;
    return false;
  };

  const groupLabel = (firstRadio: Element | undefined): string => {
    if (!firstRadio) return "";
    const fs = firstRadio.closest("fieldset");
    if (fs) {
      const lg = fs.querySelector("legend");
      if (lg) return clean(lg.textContent);
    }
    const container = firstRadio.closest('.field, [class*="field"]');
    if (container) {
      const lbl = container.querySelector("label, legend");
      if (lbl) return clean(lbl.textContent);
    }
    return "";
  };

  const root = document.querySelector("form") || document.body;
  const fields: Record<string, unknown>[] = [];
  const seenRadioGroups = new Set<string>();
  const controls = Array.from(
    root.querySelectorAll('input, textarea, select, [role="combobox"]')
  );

  for (const el of controls) {
    const tagName = el.tagName.toLowerCase();
    const typeAttr = (el.getAttribute("type") || "").toLowerCase();
    if (["hidden", "submit", "button", "reset"].includes(typeAttr)) continue;

    const isFile = typeAttr === "file";
    if (!isFile) {
      const style = window.getComputedStyle(el as HTMLElement);
      if (style.display === "none" || style.visibility === "hidden") continue;
    }

    const label = labelFor(el);

    if (tagName === "input" && typeAttr === "radio") {
      const name = el.getAttribute("name") || "";
      if (!name || seenRadioGroups.has(name)) continue;
      seenRadioGroups.add(name);
      const radios = Array.from(
        root.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${esc(name)}"]`)
      );
      const checked = radios.find((r) => r.checked);
      fields.push({
        ref: "radio:" + name,
        label: groupLabel(radios[0]) || name,
        controlType: "radio_group",
        required: radios.some((r) => r.required),
        options: radios.map((r) => labelFor(r)).filter(Boolean),
        currentValue: checked ? labelFor(checked) : null,
      });
      continue;
    }

    if (tagName === "input" && typeAttr === "checkbox") {
      fields.push({
        ref: tag(el),
        label,
        controlType: "checkbox",
        required: requiredOf(el, label),
        currentValue: (el as HTMLInputElement).checked ? label || "true" : null,
      });
      continue;
    }

    let controlType = "text";
    let options: string[] | undefined;
    let currentValue: string | null = null;

    if (tagName === "textarea") {
      controlType = "textarea";
      currentValue = (el as HTMLTextAreaElement).value || null;
    } else if (tagName === "select") {
      controlType = "native_select";
      const sel = el as HTMLSelectElement;
      options = Array.from(sel.options)
        .map((o) => clean(o.textContent))
        .filter((o) => o && !/^select\.{0,3}$/i.test(o));
      currentValue =
        sel.selectedIndex >= 0 ? clean(sel.options[sel.selectedIndex]?.textContent) : null;
    } else if (el.getAttribute("role") === "combobox" || el.classList.contains("select2")) {
      controlType = "custom_select";
      currentValue = clean(el.textContent) || null;
      // Capture the associated option list (aria-controls/owns, sibling listbox) so the
      // matcher can map to the exact rendered option text.
      const owns = el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
      let listbox: Element | null = owns ? document.getElementById(owns) : null;
      if (!listbox) listbox = el.parentElement?.querySelector('[role="listbox"]') ?? null;
      if (!listbox) listbox = el.nextElementSibling;
      if (listbox) {
        const opts = Array.from(listbox.querySelectorAll('[role="option"], li'))
          .map((o) => clean(o.textContent))
          .filter(Boolean);
        if (opts.length) options = opts;
      }
    } else {
      // Skip a react-select's internal/backing input (new Greenhouse renders a hidden
      // requiredInput alongside the visible [role=combobox]); the combobox is already captured.
      if (
        typeAttr !== "file" &&
        el.closest(".select__container, .select__control, .select__value-container, .select__indicators")
      ) {
        continue;
      }
      const map: Record<string, string> = {
        email: "email",
        tel: "phone",
        url: "url",
        number: "number",
        date: "date",
        file: "file_upload",
      };
      controlType = map[typeAttr] || "text";
      const inp = el as HTMLInputElement;
      currentValue =
        controlType === "file_upload"
          ? inp.files && inp.files.length
            ? inp.files[0]!.name
            : null
          : inp.value || null;
    }

    fields.push({
      ref: tag(el),
      label,
      controlType,
      required: requiredOf(el, label),
      ...(options ? { options } : {}),
      currentValue,
    });
  }

  return fields;
}
