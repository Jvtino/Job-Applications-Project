import type { SalaryPeriod } from '../shared';

export interface ParsedSalary {
  min: number | null;
  max: number | null;
  currency: string;
  period: SalaryPeriod;
}

const RANGE_PATTERN =
  /\$\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d{1,2})?)\s*(k)?\s*(?:[-–—]|to)\s*\$?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d{1,2})?)\s*(k)?/i;
const SINGLE_PATTERN =
  /(?:starting at|from|up to)\s*\$\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d{1,2})?)\s*(k)?/i;
const HOURLY_PATTERN = /(per\s*hour|\/\s*(?:hr|hour)|hourly|an hour)/i;
const YEARLY_PATTERN = /(per\s*(?:year|annum)|\/\s*(?:yr|year)|annually|a year|per anno)/i;

function toNumber(raw: string, k: string | undefined): number {
  const n = Number(raw.replace(/,/g, ''));
  return k ? n * 1000 : n;
}

/**
 * Conservative salary extraction from free text ("$80k–$100k", "$18.50 - $22.00
 * per hour", "starting at $65,000"). Only fires on explicit dollar amounts —
 * a false salary is worse than a missing one. The period stays as stated
 * (schema keeps salary_period; nothing is silently annualized).
 */
export function parseSalaryText(text: string): ParsedSalary | null {
  const window = text.slice(0, 4000);

  let min: number | null = null;
  let max: number | null = null;
  let matchEnd = -1;

  const range = RANGE_PATTERN.exec(window);
  if (range) {
    min = toNumber(range[1]!, range[2]);
    max = toNumber(range[3]!, range[4] ?? range[2]);
    matchEnd = range.index + range[0].length;
  } else {
    const single = SINGLE_PATTERN.exec(window);
    if (single) {
      min = toNumber(single[1]!, single[2]);
      matchEnd = single.index + single[0].length;
    }
  }
  if (min === null && max === null) return null;

  // Period from text near the amount (trailing 40 chars), else inferred from magnitude.
  const vicinity = window.slice(Math.max(0, matchEnd - 60), matchEnd + 40);
  let period: SalaryPeriod = 'unknown';
  if (HOURLY_PATTERN.test(vicinity)) period = 'hour';
  else if (YEARLY_PATTERN.test(vicinity)) period = 'year';
  else if ((min ?? max ?? 0) > 0 && (max ?? min ?? 0) < 200) period = 'hour';
  else if ((min ?? max ?? 0) >= 10_000) period = 'year';

  // Sanity: reject absurd ranges (regex matched something that isn't pay).
  if (min !== null && max !== null && max < min) [min, max] = [max, min];
  if ((min ?? 0) > 2_000_000 || (max ?? 0) > 2_000_000) return null;

  return { min, max, currency: 'USD', period };
}
