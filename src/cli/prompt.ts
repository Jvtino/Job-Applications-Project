// src/cli/prompt.ts
//
// Small readline-based prompt helpers for the first-run wizard. Dependency-free
// (node:readline/promises). Every selector that can be voluntary supports an explicit
// "decline to answer" and a "skip for now" (leave null) so the wizard can honor the brief's
// distinction between DECLINE and "not collected yet".

import { createInterface, type Interface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { DECLINE, type Decline } from "../types/applicant-profile";

export class Prompter {
  private rl: Interface;
  constructor() {
    this.rl = createInterface({ input: stdin, output: stdout });
  }

  close(): void {
    this.rl.close();
  }

  print(line = ""): void {
    stdout.write(line + "\n");
  }

  async text(
    question: string,
    opts: { required?: boolean; default?: string } = {}
  ): Promise<string> {
    const suffix = opts.default ? ` [${opts.default}]` : "";
    for (;;) {
      const raw = (await this.rl.question(`${question}${suffix}: `)).trim();
      if (raw) return raw;
      if (opts.default !== undefined) return opts.default;
      if (!opts.required) return "";
      this.print("  (required)");
    }
  }

  async confirm(question: string, def?: boolean): Promise<boolean> {
    const hint = def === undefined ? "(y/n)" : def ? "(Y/n)" : "(y/N)";
    for (;;) {
      const raw = (await this.rl.question(`${question} ${hint}: `)).trim().toLowerCase();
      if (!raw && def !== undefined) return def;
      if (["y", "yes"].includes(raw)) return true;
      if (["n", "no"].includes(raw)) return false;
      this.print("  (please answer y or n)");
    }
  }

  async number(
    question: string,
    opts: { min?: number; max?: number; default?: number } = {}
  ): Promise<number> {
    for (;;) {
      const raw = (
        await this.rl.question(
          `${question}${opts.default !== undefined ? ` [${opts.default}]` : ""}: `
        )
      ).trim();
      if (!raw && opts.default !== undefined) return opts.default;
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        this.print("  (enter a number)");
        continue;
      }
      if (opts.min !== undefined && n < opts.min) {
        this.print(`  (min ${opts.min})`);
        continue;
      }
      if (opts.max !== undefined && n > opts.max) {
        this.print(`  (max ${opts.max})`);
        continue;
      }
      return n;
    }
  }

  /**
   * Single-select. Returns the chosen option's `value`, DECLINE if the user declines, or null
   * if they skip (not collected yet). `voluntary` adds the "decline to answer" line and makes
   * clear the question is optional.
   */
  async choice<T extends string>(
    question: string,
    options: { label: string; value: T }[],
    opts: { voluntary?: boolean } = {}
  ): Promise<T | Decline | null> {
    this.print(question + (opts.voluntary ? "  (voluntary)" : ""));
    options.forEach((o, i) => this.print(`  ${i + 1}) ${o.label}`));
    const declineNum = options.length + 1;
    const skipNum = options.length + 2;
    if (opts.voluntary) this.print(`  ${declineNum}) Decline to answer`);
    this.print(`  ${skipNum}) Skip for now`);
    for (;;) {
      const raw = (await this.rl.question("  choose #: ")).trim();
      const n = Number(raw);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) {
        return options[n - 1]!.value;
      }
      if (opts.voluntary && n === declineNum) return DECLINE;
      if (n === skipNum) return null;
      this.print("  (invalid choice)");
    }
  }

  /**
   * Multi-select. Returns chosen values, DECLINE, or null (skip). Accepts comma-separated
   * indices, e.g. "1,3".
   */
  async multiChoice<T extends string>(
    question: string,
    options: { label: string; value: T }[],
    opts: { voluntary?: boolean } = {}
  ): Promise<T[] | Decline | null> {
    this.print(question + (opts.voluntary ? "  (voluntary, choose any)" : "  (choose any)"));
    options.forEach((o, i) => this.print(`  ${i + 1}) ${o.label}`));
    const declineNum = options.length + 1;
    const skipNum = options.length + 2;
    if (opts.voluntary) this.print(`  ${declineNum}) Decline to answer`);
    this.print(`  ${skipNum}) Skip for now`);
    for (;;) {
      const raw = (await this.rl.question("  choose #(s), comma-separated: ")).trim();
      const parts = raw.split(",").map((p) => Number(p.trim()));
      if (opts.voluntary && parts.length === 1 && parts[0] === declineNum) return DECLINE;
      if (parts.length === 1 && parts[0] === skipNum) return null;
      if (parts.every((n) => Number.isInteger(n) && n >= 1 && n <= options.length)) {
        const chosen = [...new Set(parts)].map((n) => options[n - 1]!.value);
        if (chosen.length > 0) return chosen;
      }
      this.print("  (invalid selection)");
    }
  }
}
