import { z } from 'zod';
import type { ParsedResumeProfile } from './types';

const workEntrySchema = z.object({
  title: z.string().nullable(),
  company: z.string().nullable(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  description: z.string().nullable(),
});

const educationEntrySchema = z.object({
  degree: z.string().nullable(),
  institution: z.string().nullable(),
  year: z.string().nullable(),
});

/** Runtime validation for user-submitted profiles crossing the IPC boundary. */
export const parsedResumeProfileSchema = z.object({
  name: z.string().max(200).nullable(),
  location: z.string().max(200).nullable(),
  email: z.string().max(320).nullable(),
  phone: z.string().max(40).nullable(),
  summary: z.string().max(5000).nullable(),
  workHistory: z.array(workEntrySchema).max(50),
  jobTitles: z.array(z.string().max(200)).max(50),
  companies: z.array(z.string().max(200)).max(50),
  skills: z.array(z.string().max(100)).max(200),
  tools: z.array(z.string().max(100)).max(200),
  certifications: z.array(z.string().max(200)).max(50),
  education: z.array(educationEntrySchema).max(20),
  industries: z.array(z.string().max(100)).max(50),
  yearsExperience: z.number().min(0).max(60).nullable(),
  achievements: z.array(z.string().max(500)).max(50),
  languages: z.array(z.string().max(60)).max(30),
  workAuthorizationStatus: z.string().max(200).nullable(),
}) satisfies z.ZodType<ParsedResumeProfile>;
