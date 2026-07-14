import type { SourceType } from '../shared';
import type { Connector } from './connector';
import { adzunaConnector, REQUIRED_ADZUNA_SECRETS } from './adzuna';
import { ashbyConnector } from './ashby';
import { greenhouseConnector } from './greenhouse';
import { leverConnector } from './lever';
import { smartRecruitersConnector } from './smartrecruiters';
import { workableConnector } from './workable';
import { workdayConnector } from './workday';
import { REQUIRED_USAJOBS_SECRETS, usajobsConnector } from './usajobs';

const CONNECTORS: Partial<Record<SourceType, Connector>> = {
  ats_greenhouse: greenhouseConnector,
  ats_lever: leverConnector,
  ats_ashby: ashbyConnector,
  ats_smartrecruiters: smartRecruitersConnector,
  ats_workable: workableConnector,
  ats_workday: workdayConnector,
  api_usajobs: usajobsConnector,
  api_adzuna: adzunaConnector,
};

/** null for source types with no MVP connector (assisted links, career pages). */
export function connectorFor(sourceType: SourceType): Connector | null {
  return CONNECTORS[sourceType] ?? null;
}

/** Secret keys a source type needs before its connector can run (empty = none). */
export function requiredSecretsFor(sourceType: SourceType): string[] {
  switch (sourceType) {
    case 'api_usajobs':
      return REQUIRED_USAJOBS_SECRETS;
    case 'api_adzuna':
      return REQUIRED_ADZUNA_SECRETS;
    default:
      return [];
  }
}
