import type {
  DbHealth,
  JobDetail,
  JobFilter,
  JobListItem,
  MatchLabel,
  ParsedResumeProfile,
  ResumeSourceType,
  ScanProgressEvent,
  ScanSummary,
  SearchProfileSuggestion,
  SearchProfileView,
} from './types';

/** Result of resume:import — either a reviewable draft or a friendly failure. */
export type ResumeImportResult =
  | {
      ok: true;
      resumeProfileId: string;
      fileName: string;
      sourceType: ResumeSourceType;
      profile: ParsedResumeProfile;
      warnings: string[];
    }
  | {
      ok: false;
      code: 'canceled' | 'unreadable_file' | 'no_text_content' | 'unsupported_format';
      message: string;
    };

export interface ActiveResumeProfile {
  id: string;
  sourceType: ResumeSourceType;
  fileName: string | null;
  parseConfirmed: boolean;
  profile: ParsedResumeProfile;
}

/**
 * The single source of truth for renderer ⇄ main IPC. Both the preload client
 * and the main-process handler map are typed against this contract, so a
 * channel cannot drift between the two sides. Grows with each milestone.
 */
export interface IpcInvokeContract {
  'app:ping': { req: void; res: { version: string } };
  'db:health': { req: void; res: DbHealth };
  'jobs:list': { req: JobFilter; res: JobListItem[] };
  'jobs:get': { req: { id: string }; res: JobDetail | null };
  'jobs:action': {
    req: { id: string; action: 'favorite' | 'hide' | 'reject' | 'restore' | 'view' };
    res: { ok: boolean };
  };
  'jobs:clearLowMatches': { req: void; res: { hidden: number } };
  'jobs:openApplyLink': { req: { id: string }; res: { opened: boolean } };
  'jobs:saveManual': {
    req: {
      company: string;
      title: string;
      location: string;
      applyUrl: string;
      description: string;
    };
    res: { ok: boolean; id?: string };
  };
  'jobs:assistedLink': {
    req: { provider: 'linkedin' | 'indeed'; keywords: string; location?: string };
    res: { opened: boolean };
  };
  'dashboard:stats': {
    req: void;
    res: {
      byLabel: Record<MatchLabel, number>;
      total: number;
      hidden: number;
      lastScanAt: string | null;
      nextScanAt: string | null;
    };
  };
  'data:exportCsv': { req: void; res: { ok: boolean; path?: string } };
  'data:exportAll': { req: void; res: { ok: boolean; path?: string } };
  'data:deleteAll': { req: void; res: { ok: boolean } };
  'scan:start': { req: void; res: { started: boolean; scanId?: string; reason?: string } };
  'scan:status': { req: void; res: { running: boolean; nextRunAt: string | null } };
  'scan:cancel': { req: void; res: { cancelled: boolean } };
  /** Opens a file dialog in main, parses locally, returns a reviewable draft. */
  'resume:import': { req: void; res: ResumeImportResult };
  /** Persists the user-confirmed (§14) profile; null id = manual builder. */
  'resume:saveProfile': {
    req: { resumeProfileId: string | null; profile: ParsedResumeProfile };
    res: { ok: boolean };
  };
  'profile:get': { req: void; res: ActiveResumeProfile | null };
  'searchProfile:get': { req: void; res: SearchProfileView | null };
  /** Builds §13 smart defaults from the active confirmed resume. */
  'searchProfile:suggest': {
    req: void;
    res: { ok: true; suggestion: SearchProfileSuggestion } | { ok: false; reason: string };
  };
  'searchProfile:update': { req: SearchProfileView; res: { ok: boolean } };
  'sources:list': { req: void; res: SourceListItem[] };
  /** Paste-a-URL company add (string parsing only; §8.5 crawler is v1.5). */
  'sources:add': {
    req: { url: string };
    res: { ok: true; slug: string; created: boolean } | { ok: false; reason: string };
  };
  'sources:toggle': { req: { id: string; enabled: boolean }; res: { ok: boolean } };
  /** Save + live-validate USAJOBS/Adzuna credentials; enables the source on success. */
  'sources:setCredentials': {
    req: { provider: 'usajobs' | 'adzuna'; values: Record<string, string> };
    res: { ok: true; validated: boolean; sampleCount?: number } | { ok: false; reason: string };
  };
  'sources:credentialStatus': {
    req: void;
    res: { usajobs: boolean; adzuna: boolean };
  };
}

export interface SourceListItem {
  id: string;
  slug: string;
  sourceName: string;
  sourceType: string;
  enabled: boolean;
  connectorStatus: string;
  failureCount: number;
  lastSuccessAt: string | null;
  seeded: boolean;
}

export type IpcChannel = keyof IpcInvokeContract;
export type IpcRequest<C extends IpcChannel> = IpcInvokeContract[C]['req'];
export type IpcResponse<C extends IpcChannel> = IpcInvokeContract[C]['res'];

/** Runtime list for registering handlers / validating senders. */
export const IPC_CHANNELS = [
  'app:ping',
  'db:health',
  'jobs:list',
  'jobs:get',
  'jobs:action',
  'jobs:clearLowMatches',
  'jobs:openApplyLink',
  'jobs:saveManual',
  'jobs:assistedLink',
  'dashboard:stats',
  'data:exportCsv',
  'data:exportAll',
  'data:deleteAll',
  'scan:start',
  'scan:status',
  'scan:cancel',
  'resume:import',
  'resume:saveProfile',
  'profile:get',
  'searchProfile:get',
  'searchProfile:suggest',
  'searchProfile:update',
  'sources:list',
  'sources:add',
  'sources:toggle',
  'sources:setCredentials',
  'sources:credentialStatus',
] as const satisfies readonly IpcChannel[];

/** Event channels pushed main → renderer. */
export type IpcEventChannel = 'scan:progress' | 'scan:done' | 'notify:newMatches';

/**
 * The object the preload exposes as `window.api`. The renderer only ever sees
 * this surface — no ipcRenderer, no Node globals. Event subscriptions return
 * an unsubscribe function.
 */
export interface JdApi {
  ping(): Promise<IpcResponse<'app:ping'>>;
  dbHealth(): Promise<IpcResponse<'db:health'>>;
  jobsList(req?: IpcRequest<'jobs:list'>): Promise<IpcResponse<'jobs:list'>>;
  jobsGet(req: IpcRequest<'jobs:get'>): Promise<IpcResponse<'jobs:get'>>;
  jobsAction(req: IpcRequest<'jobs:action'>): Promise<IpcResponse<'jobs:action'>>;
  jobsClearLowMatches(): Promise<IpcResponse<'jobs:clearLowMatches'>>;
  jobsOpenApplyLink(
    req: IpcRequest<'jobs:openApplyLink'>,
  ): Promise<IpcResponse<'jobs:openApplyLink'>>;
  jobsSaveManual(req: IpcRequest<'jobs:saveManual'>): Promise<IpcResponse<'jobs:saveManual'>>;
  jobsAssistedLink(req: IpcRequest<'jobs:assistedLink'>): Promise<IpcResponse<'jobs:assistedLink'>>;
  dashboardStats(): Promise<IpcResponse<'dashboard:stats'>>;
  dataExportCsv(): Promise<IpcResponse<'data:exportCsv'>>;
  dataExportAll(): Promise<IpcResponse<'data:exportAll'>>;
  dataDeleteAll(): Promise<IpcResponse<'data:deleteAll'>>;
  scanStart(): Promise<IpcResponse<'scan:start'>>;
  scanStatus(): Promise<IpcResponse<'scan:status'>>;
  scanCancel(): Promise<IpcResponse<'scan:cancel'>>;
  resumeImport(): Promise<IpcResponse<'resume:import'>>;
  resumeSaveProfile(
    req: IpcRequest<'resume:saveProfile'>,
  ): Promise<IpcResponse<'resume:saveProfile'>>;
  profileGet(): Promise<IpcResponse<'profile:get'>>;
  searchProfileGet(): Promise<IpcResponse<'searchProfile:get'>>;
  searchProfileSuggest(): Promise<IpcResponse<'searchProfile:suggest'>>;
  searchProfileUpdate(
    req: IpcRequest<'searchProfile:update'>,
  ): Promise<IpcResponse<'searchProfile:update'>>;
  sourcesList(): Promise<IpcResponse<'sources:list'>>;
  sourcesAdd(req: IpcRequest<'sources:add'>): Promise<IpcResponse<'sources:add'>>;
  sourcesToggle(req: IpcRequest<'sources:toggle'>): Promise<IpcResponse<'sources:toggle'>>;
  sourcesSetCredentials(
    req: IpcRequest<'sources:setCredentials'>,
  ): Promise<IpcResponse<'sources:setCredentials'>>;
  sourcesCredentialStatus(): Promise<IpcResponse<'sources:credentialStatus'>>;
  onScanProgress(listener: (event: ScanProgressEvent) => void): () => void;
  onScanDone(listener: (summary: ScanSummary) => void): () => void;
}
