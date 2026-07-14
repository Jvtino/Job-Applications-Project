import { z } from 'zod';
import { SEARCH_DEPTHS, TRACKS } from './types';
import type { SearchProfileView } from './types';

const strings = (max: number, itemMax = 100) => z.array(z.string().min(1).max(itemMax)).max(max);

/** Runtime validation for search-profile updates crossing the IPC boundary. */
export const searchProfileViewSchema = z.object({
  track: z.enum(TRACKS),
  targetTitles: strings(30),
  excludedTitles: strings(30),
  preferredLocations: strings(20),
  remotePreferences: z.array(z.enum(['remote', 'hybrid', 'onsite'])).max(3),
  salaryMin: z.number().int().min(0).max(2_000_000).nullable(),
  employmentTypes: strings(6, 40),
  industries: strings(20),
  dealbreakers: strings(20, 200),
  searchDepth: z.enum(SEARCH_DEPTHS),
  scanIntervalHours: z.number().int().min(1).max(168),
}) satisfies z.ZodType<SearchProfileView>;
