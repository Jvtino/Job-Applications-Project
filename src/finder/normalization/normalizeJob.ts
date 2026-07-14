import type { NormalizedJob, RawJob } from '../shared';
import { htmlToText } from './html';
import { normalizeLocation } from './normalizeLocation';
import { parseSalaryText } from './normalizeSalary';

/**
 * RawJob → NormalizedJob: canonical location + remote inference, HTML-stripped
 * description, and conservative salary fill from the description when the
 * connector provided none. Canonical title/company forms (for dedupe keys)
 * are exported separately — the stored job keeps human-readable values.
 */
export function normalizeJob(raw: RawJob): NormalizedJob {
  const location = normalizeLocation(raw.locationRaw);
  const descriptionClean = htmlToText(raw.descriptionRaw);

  // The connector's remote signal wins; location text fills the gap.
  const remoteType = raw.remoteType !== 'unknown' ? raw.remoteType : location.remoteType;

  let { salaryMin, salaryMax, salaryCurrency, salaryPeriod } = raw;
  if (salaryMin === null && salaryMax === null) {
    const parsed = parseSalaryText(descriptionClean);
    if (parsed) {
      salaryMin = parsed.min;
      salaryMax = parsed.max;
      salaryCurrency = parsed.currency;
      salaryPeriod = parsed.period;
    }
  }

  return {
    ...raw,
    company: raw.company.trim(),
    title: raw.title.trim(),
    locationNormalized: location.locationNormalized,
    remoteType,
    descriptionClean,
    salaryMin,
    salaryMax,
    salaryCurrency,
    salaryPeriod,
    requirements: [],
    responsibilities: [],
  };
}
