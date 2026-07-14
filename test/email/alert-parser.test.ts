import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAlertMessage, readAlertMail } from '../../src/email/alert-parser';
import { splitMbox } from '../../src/email/mime';

const fixturesDir = fileURLToPath(new URL('./fixtures', import.meta.url));
const read = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

describe('parseAlertMessage — LinkedIn', () => {
  const jobs = parseAlertMessage(read('linkedin-alert.eml'));

  it('yields one RawJob per distinct job, tagged assisted_linkedin', () => {
    expect(jobs).toHaveLength(3);
    expect(jobs.every((j) => j.sourceType === 'assisted_linkedin')).toBe(true);
  });

  it('canonicalizes job URLs and captures ids (tracking stripped)', () => {
    const byId = new Map(jobs.map((j) => [j.raw.externalJobId, j]));
    expect([...byId.keys()].sort()).toEqual(['3811234567', '3822345678', '3833456789']);

    const j1 = byId.get('3811234567')!;
    expect(j1.raw.canonicalUrl).toBe('https://www.linkedin.com/jobs/view/3811234567');
    expect(j1.raw.applyUrl).toBe('https://www.linkedin.com/jobs/view/3811234567');
  });

  it('extracts title/company/location best-effort (proving UTF-8 quoted-printable decode)', () => {
    const j1 = parseAlertMessage(read('linkedin-alert.eml')).find(
      (j) => j.raw.externalJobId === '3811234567',
    )!;
    expect(j1.raw.title).toBe('Senior AML Analyst');
    expect(j1.raw.company).toBe('Northwind Bank');
    expect(j1.raw.locationRaw).toContain('New York, NY');
    expect(j1.raw.locationRaw).toContain('·'); // U+00B7 decoded from =C2=B7
  });

  it('emits metadata + links only — never the email body', () => {
    for (const j of jobs) {
      expect(j.raw.descriptionRaw).toBe('');
      expect(j.raw.salaryPeriod).toBe('unknown');
      expect(j.raw.remoteType).toBe('unknown');
      expect(j.raw.employmentType).toBe('unknown');
    }
    // "Unsubscribe" appears only in the body chrome, never in a job field.
    expect(JSON.stringify(jobs)).not.toContain('Unsubscribe');
  });
});

describe('parseAlertMessage — Indeed', () => {
  const jobs = parseAlertMessage(read('indeed-alert.eml'));

  it('yields RawJobs tagged assisted_indeed (base64 HTML part decoded)', () => {
    expect(jobs).toHaveLength(3);
    expect(jobs.every((j) => j.sourceType === 'assisted_indeed')).toBe(true);
  });

  it('canonicalizes viewjob / rc/clk / pagead/clk links to viewjob?jk=<id>', () => {
    const byId = new Map(jobs.map((j) => [j.raw.externalJobId, j]));
    expect([...byId.keys()].sort()).toEqual([
      'a1b2c3d4e5f60001',
      'a1b2c3d4e5f60002',
      'a1b2c3d4e5f60003',
    ]);

    const j1 = byId.get('a1b2c3d4e5f60001')!; // came in via rc/clk
    expect(j1.raw.canonicalUrl).toBe('https://www.indeed.com/viewjob?jk=a1b2c3d4e5f60001');
    expect(j1.raw.title).toBe('Staff Accountant');
    expect(j1.raw.company).toBe('Contoso LLC');
    expect(j1.raw.locationRaw).toBe('Austin, TX');
  });
});

describe('non-alert mail is ignored (acceptance)', () => {
  it('returns [] for a normal personal email', () => {
    expect(parseAlertMessage(read('not-an-alert.eml'))).toEqual([]);
  });

  it('returns [] for a marketing newsletter', () => {
    expect(parseAlertMessage(read('marketing.eml'))).toEqual([]);
  });
});

describe('readAlertMail', () => {
  it('aggregates alert jobs and ignores non-alert files', () => {
    const all = readAlertMail(fixturesDir);
    // 3 (linkedin.eml) + 3 (indeed.eml) + 2 (mbox) = 8; the 2 non-alert files add nothing.
    expect(all).toHaveLength(8);
    expect(all.filter((j) => j.sourceType === 'assisted_linkedin')).toHaveLength(4);
    expect(all.filter((j) => j.sourceType === 'assisted_indeed')).toHaveLength(4);
    expect(all.every((j) => j.raw.descriptionRaw === '')).toBe(true);
  });

  it('returns [] for a missing directory (never throws)', () => {
    expect(readAlertMail(fileURLToPath(new URL('./does-not-exist', import.meta.url)))).toEqual([]);
  });
});

describe('mbox splitting', () => {
  it('splits into two messages worth of jobs (one linkedin, one indeed)', () => {
    const messages = splitMbox(read('alerts.mbox'));
    expect(messages).toHaveLength(2);

    const jobs = messages.flatMap(parseAlertMessage);
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.sourceType).sort()).toEqual([
      'assisted_indeed',
      'assisted_linkedin',
    ]);
  });
});
