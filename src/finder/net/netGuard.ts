import PQueue from 'p-queue';
import { Agent, EnvHttpProxyAgent, request, type Dispatcher } from 'undici';
import { ALLOWED_HOSTS, ALLOWED_HOST_SUFFIXES, DENIED_HOST_SUFFIXES } from './hosts';

export type NetGuardErrorCode =
  | 'invalid_url'
  | 'insecure_protocol'
  | 'method_not_allowed'
  | 'host_denied'
  | 'host_not_allowlisted'
  | 'body_not_allowed';

export class NetGuardError extends Error {
  constructor(
    message: string,
    readonly code: NetGuardErrorCode,
  ) {
    super(message);
    this.name = 'NetGuardError';
  }
}

export interface NetGuardOptions {
  allowedHosts?: readonly string[];
  allowedHostSuffixes?: readonly string[];
  deniedHostSuffixes?: readonly string[];
  /** Tests inject an undici MockAgent here. */
  dispatcher?: Dispatcher;
  /** Minimum spacing between requests to the same host. */
  minIntervalMs?: number;
  /** ± ratio applied to minIntervalMs. */
  jitterRatio?: number;
  perHostConcurrency?: number;
  headersTimeoutMs?: number;
  bodyTimeoutMs?: number;
}

export interface NetResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}

export interface NetRequestInit {
  /** Only 'GET' is accepted — present so callers passing a method fail loudly, not silently. */
  method?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * Every outbound request in the app flows through this class. It enforces, at runtime, the
 * guarantees the product makes:
 *   - READS ONLY: GET, plus a narrow read-only JSON *search* POST (Workday's CXS jobs endpoint
 *     requires POST-with-body to return a job list — it is a query, not a mutation). PUT/PATCH/DELETE
 *     are always refused. An employer job APPLICATION is NEVER submitted through here — that path is
 *     Playwright + the human review gate, entirely separate from this HTTP client.
 *   - an exact-match host allowlist (+ a tiny suffix allowlist for Workday's per-tenant hosts),
 *   - a LinkedIn/Indeed/Glassdoor denylist checked BEFORE any allowlist,
 *   - per-host politeness pacing.
 *
 * Under JD_EGRESS_TEST=1 it routes through EnvHttpProxyAgent so the release egress audit (mitmproxy)
 * observes real traffic — the audit asserts a nonzero capture count, so it can never pass vacuously.
 */
export class NetGuard {
  private readonly allowedHosts: ReadonlySet<string>;
  private readonly allowedHostSuffixes: readonly string[];
  private readonly deniedHostSuffixes: readonly string[];
  private readonly dispatcher: Dispatcher;
  private readonly minIntervalMs: number;
  private readonly jitterRatio: number;
  private readonly perHostConcurrency: number;
  private readonly headersTimeoutMs: number;
  private readonly bodyTimeoutMs: number;
  private readonly queues = new Map<string, PQueue>();
  private readonly lastRequestAt = new Map<string, number>();

  constructor(opts: NetGuardOptions = {}) {
    this.allowedHosts = new Set(opts.allowedHosts ?? ALLOWED_HOSTS);
    this.allowedHostSuffixes = opts.allowedHostSuffixes ?? ALLOWED_HOST_SUFFIXES;
    this.deniedHostSuffixes = opts.deniedHostSuffixes ?? DENIED_HOST_SUFFIXES;
    this.dispatcher =
      opts.dispatcher ??
      (process.env.JD_EGRESS_TEST === '1' ? new EnvHttpProxyAgent() : new Agent());
    this.minIntervalMs = opts.minIntervalMs ?? 500;
    this.jitterRatio = opts.jitterRatio ?? 0.3;
    this.perHostConcurrency = opts.perHostConcurrency ?? 2;
    this.headersTimeoutMs = opts.headersTimeoutMs ?? 10_000;
    this.bodyTimeoutMs = opts.bodyTimeoutMs ?? 10_000;
  }

  /** Validates a URL against the guard rules without sending anything. */
  assertAllowed(rawUrl: string, init: NetRequestInit = {}): URL {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new NetGuardError(`Not a valid URL: ${rawUrl}`, 'invalid_url');
    }
    if (url.protocol !== 'https:') {
      throw new NetGuardError(`Only https is allowed: ${rawUrl}`, 'insecure_protocol');
    }
    const method = (init.method ?? 'GET').toUpperCase();
    // Reads only: GET and a read-only search POST are permitted; anything that could mutate is not.
    if (method !== 'GET' && method !== 'POST') {
      throw new NetGuardError(
        `Method ${init.method} is not allowed — this app only ever reads (GET, or a read-only search POST).`,
        'method_not_allowed',
      );
    }
    const host = url.hostname.toLowerCase();
    // Denylist FIRST: these hosts can never be allowlisted, even by mistake.
    for (const suffix of this.deniedHostSuffixes) {
      if (host === suffix || host.endsWith(`.${suffix}`)) {
        throw new NetGuardError(`Host ${host} is hard-denied.`, 'host_denied');
      }
    }
    if (!this.allowedHosts.has(host) && !this.matchesAllowedSuffix(host)) {
      throw new NetGuardError(`Host ${host} is not on the allowlist.`, 'host_not_allowlisted');
    }
    return url;
  }

  /** Paced, guarded GET returning the body as text. */
  async get(rawUrl: string, init: NetRequestInit = {}): Promise<NetResponse> {
    const url = this.assertAllowed(rawUrl, init);
    const host = url.hostname.toLowerCase();
    const queue = this.queueFor(host);
    return queue.add(async (): Promise<NetResponse> => {
      await this.pace(host);
      const res = await request(url, {
        method: 'GET',
        headers: init.headers,
        signal: init.signal,
        dispatcher: this.dispatcher,
        headersTimeout: this.headersTimeoutMs,
        bodyTimeout: this.bodyTimeoutMs,
      });
      const text = await res.body.text();
      return { statusCode: res.statusCode, headers: res.headers, text };
    }) as Promise<NetResponse>;
  }

  /** Paced, guarded GET that parses the body as JSON. */
  async getJson(
    rawUrl: string,
    init: NetRequestInit = {},
  ): Promise<{
    statusCode: number;
    headers: NetResponse['headers'];
    body: unknown;
  }> {
    const res = await this.get(rawUrl, init);
    let body: unknown;
    try {
      body = JSON.parse(res.text) as unknown;
    } catch {
      body = undefined;
    }
    return { statusCode: res.statusCode, headers: res.headers, body };
  }

  /**
   * Paced, guarded read-only search POST (JSON in, text/JSON out). The ONLY non-GET path — it exists
   * for query endpoints that require a POST body (Workday's CXS jobs endpoint). Same host/denylist/
   * pacing rules as GET; it never submits an employer application (that is Playwright + the human gate).
   */
  async postJson(rawUrl: string, body: unknown, init: NetRequestInit = {}): Promise<NetResponse> {
    const url = this.assertAllowed(rawUrl, { ...init, method: 'POST' });
    const host = url.hostname.toLowerCase();
    const queue = this.queueFor(host);
    return queue.add(async (): Promise<NetResponse> => {
      await this.pace(host);
      const res = await request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...init.headers },
        body: JSON.stringify(body),
        signal: init.signal,
        dispatcher: this.dispatcher,
        headersTimeout: this.headersTimeoutMs,
        bodyTimeout: this.bodyTimeoutMs,
      });
      const text = await res.body.text();
      return { statusCode: res.statusCode, headers: res.headers, text };
    }) as Promise<NetResponse>;
  }

  private matchesAllowedSuffix(host: string): boolean {
    return this.allowedHostSuffixes.some((s) => host === s || host.endsWith(`.${s}`));
  }

  private queueFor(host: string): PQueue {
    let queue = this.queues.get(host);
    if (!queue) {
      queue = new PQueue({ concurrency: this.perHostConcurrency });
      this.queues.set(host, queue);
    }
    return queue;
  }

  private async pace(host: string): Promise<void> {
    if (this.minIntervalMs <= 0) {
      this.lastRequestAt.set(host, Date.now());
      return;
    }
    const jitter = 1 + (Math.random() * 2 - 1) * this.jitterRatio;
    const interval = Math.max(0, Math.round(this.minIntervalMs * jitter));
    const last = this.lastRequestAt.get(host);
    const now = Date.now();
    const waitMs = last === undefined ? 0 : Math.max(0, last + interval - now);
    // Reserve the slot before sleeping so concurrent callers space out too.
    this.lastRequestAt.set(host, now + waitMs);
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

/** Production instance: the app's entire network surface. */
export const netGuard = new NetGuard();
