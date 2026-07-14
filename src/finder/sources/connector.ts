import type { NetGuard } from '../net';
import type { RawJob, SourceDescriptor, SourceType } from '../shared';

export interface ConnectorContext {
  net: NetGuard;
  signal?: AbortSignal;
  /** Decrypted secret lookup (main process injects SettingsRepo.getSecret). */
  getSecret?: (key: string) => string | null;
}

/**
 * The interface every source connector implements from M3 on. Connectors
 * fetch + map to RawJob; they never touch the database and never make a
 * request outside the injected NetGuard. Failures are thrown as
 * ConnectorError (../shared) with a code the scan runner maps to a
 * crawl_logs status.
 */
export interface Connector {
  readonly sourceType: SourceType;
  fetchJobs(source: SourceDescriptor, ctx: ConnectorContext): Promise<RawJob[]>;
}
