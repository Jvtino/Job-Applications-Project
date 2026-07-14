// src/ats/robots.ts
//
// robots.txt support (RFC 9309 subset) for the discovery scraper. AUTOMATED HTML scraping consults
// the target host's robots.txt before opening any page (commercial M4); user-initiated single-page
// actions (add-by-URL, the apply/review flow) do not — they navigate like the user's own browser.
// The no-auth ATS JSON APIs and keyed job APIs are plain REST calls and are out of scope.
//
// Behavior:
//  - Group selection: the group whose User-agent token equals "applypilot" (case-insensitive) wins;
//    otherwise the "*" group; no group -> everything allowed.
//  - Rule matching: LINEAR-TIME glob (two-pointer, no regex) — patterns support "*" wildcards and a
//    "$" end anchor and are prefix matches otherwise. Longest-pattern match wins; Allow wins length
//    ties (RFC 9309 §2.2.2). Empty Disallow values are ignored (allow-all). Percent-encoding is
//    normalized on both sides before matching (§2.2.2).
//  - Fetch policy: 2xx -> parse; 4xx (incl. 404/401/403) -> allow-all (robots "unavailable");
//    5xx -> disallow-all (server up but erroring: back off) on a SHORT ttl; a NETWORK error/timeout
//    -> allow-all on a short ttl. The robots probe uses the SAME transport as the scraper (the
//    browser's own request context is injected by BrowserSession), so a network failure means the
//    origin is unreachable for scraping too — failing open there avoids a self-inflicted "one
//    unreachable robots.txt kills all discovery" outage while a corporate proxy / TLS-inspecting
//    firewall is in play (global fetch would ignore OS proxy + cert store; the browser transport
//    does not).

export const ROBOTS_PRODUCT_TOKEN = "applypilot";
/** Same self-identifying UA the no-auth ATS API client sends — no spoofing anywhere. */
export const ROBOTS_FETCH_USER_AGENT = "ApplyPilot/1.0 (local job-search assistant)";

const MAX_ROBOTS_BYTES = 512 * 1024; // RFC 9309 requires parsing at least 500 KiB; ignore the rest.

export class RobotsDisallowedError extends Error {
  constructor(url: string) {
    super(`robots.txt disallows automated fetching of ${url} — skipping this page.`);
    this.name = "RobotsDisallowedError";
  }
}

export interface RobotsRule {
  allow: boolean;
  /** Path pattern, percent-normalized at parse time ("*" wildcards, optional trailing "$"). */
  pattern: string;
}

/** Parse robots.txt into product-token -> rules. Tokens are lowercased; "*" is the catch-all. */
export function parseRobotsGroups(text: string): Map<string, RobotsRule[]> {
  const groups = new Map<string, RobotsRule[]>();
  let currentAgents: string[] = [];
  let collectingAgents = true;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();

    if (key === "user-agent") {
      if (!collectingAgents) {
        // A User-agent line after rules starts a new group.
        currentAgents = [];
        collectingAgents = true;
      }
      const token = value.toLowerCase();
      if (token) {
        currentAgents.push(token);
        if (!groups.has(token)) groups.set(token, []);
      }
      continue;
    }
    if (key === "allow" || key === "disallow") {
      collectingAgents = false;
      if (!currentAgents.length) continue; // rules before any User-agent line — ignored per RFC
      if (!value) continue; // empty Disallow/Allow = no restriction
      const pattern = normalizeEncoding(value);
      for (const agent of currentAgents) {
        groups.get(agent)!.push({ allow: key === "allow", pattern });
      }
    }
    // Other directives (Sitemap, Crawl-delay, ...) are ignored.
  }
  return groups;
}

/** The rule set that applies to our product token, per RFC 9309 group selection. */
export function selectRules(groups: Map<string, RobotsRule[]>, productToken = ROBOTS_PRODUCT_TOKEN): RobotsRule[] {
  return groups.get(productToken.toLowerCase()) ?? groups.get("*") ?? [];
}

/**
 * Normalize percent-encoding for comparison (RFC 9309 §2.2.2): percent-encode any byte > 0x7F
 * (uppercase hex, per RFC 3986) and uppercase any existing %xx escapes, leaving robots
 * meta-characters (* $ / ? = & etc., all ASCII) untouched. Applied to both patterns and the match
 * target so a rule written in raw UTF-8 or lowercase hex still matches the URL's canonical form.
 */
function normalizeEncoding(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code > 0x7f) {
      for (const b of new TextEncoder().encode(ch)) out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
    } else {
      out += ch;
    }
  }
  // Uppercase existing %xx escapes (e.g. %c3%a9 -> %C3%A9).
  return out.replace(/%[0-9a-fA-F]{2}/g, (m) => m.toUpperCase());
}

/**
 * Linear-time glob match (two-pointer with a single backtrack anchor): does `pattern` match `text`?
 * "*" matches any run; a trailing "$" anchors the end, otherwise the match is a PREFIX match
 * (modeled by appending an implicit trailing "*"). O(len(pattern) * len(text)) worst case with NO
 * exponential backtracking, so a hostile robots.txt line cannot wedge the event loop.
 */
function globMatches(rawPattern: string, text: string): boolean {
  const anchored = rawPattern.endsWith("$");
  const pat = anchored ? rawPattern.slice(0, -1) : rawPattern + "*";
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pat.length && pat[p] !== "*" && pat[p] === text[t]) {
      p++;
      t++;
    } else if (p < pat.length && pat[p] === "*") {
      star = p;
      mark = t;
      p++;
    } else if (star >= 0) {
      p = star + 1;
      mark++;
      t = mark;
    } else {
      return false;
    }
  }
  while (p < pat.length && pat[p] === "*") p++;
  return p === pat.length;
}

/** Longest-match evaluation: most specific matching rule wins; Allow wins exact-length ties. */
export function isPathAllowed(rules: RobotsRule[], pathAndQuery: string): boolean {
  const target = normalizeEncoding(pathAndQuery);
  let winner: { allow: boolean; length: number } | undefined;
  for (const rule of rules) {
    if (!globMatches(rule.pattern, target)) continue;
    const length = rule.pattern.length;
    if (!winner || length > winner.length || (length === winner.length && rule.allow && !winner.allow)) {
      winner = { allow: rule.allow, length };
    }
  }
  return winner ? winner.allow : true;
}

/** HTTP response shape the cache needs. `text` is already byte-capped by the fetcher. */
export interface RobotsHttpResponse {
  status: number;
  text: string;
}
/**
 * Fetch a robots.txt URL. Throws on a network/transport error (caller fails open); returns the
 * status + already-capped body on any HTTP response. Injected by BrowserSession with the browser's
 * own request context so robots egress == scrape egress; defaults to a bounded global fetch.
 */
export type RobotsFetcher = (url: string, opts: { timeoutMs: number; maxBytes: number }) => Promise<RobotsHttpResponse>;

/** Default fetcher: global fetch with a bounded streaming read (never buffers a whole large body). */
export const defaultRobotsFetcher: RobotsFetcher = async (url, { timeoutMs, maxBytes }) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": ROBOTS_FETCH_USER_AGENT, accept: "text/plain,*/*" },
      redirect: "follow",
      signal: controller.signal,
    });
    return { status: res.status, text: await readCappedBody(res, maxBytes) };
  } finally {
    clearTimeout(timer);
  }
};

/** Read at most maxBytes from a fetch Response body, cancelling the rest (bounded memory). */
async function readCappedBody(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, maxBytes);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // best-effort — the body may already be closed
    }
  }
  const capped = new Uint8Array(Math.min(total, maxBytes));
  let off = 0;
  for (const c of chunks) {
    if (off >= capped.length) break;
    const take = Math.min(c.length, capped.length - off);
    capped.set(c.subarray(0, take), off);
    off += take;
  }
  return new TextDecoder().decode(capped);
}

type CacheEntry =
  | { kind: "rules"; rules: RobotsRule[]; expiresAt: number }
  | { kind: "allow-all"; expiresAt: number }
  | { kind: "disallow-all"; expiresAt: number };

export interface RobotsCacheOptions {
  /** Injectable robots.txt fetcher (tests + BrowserSession's browser-context transport). */
  fetcher?: RobotsFetcher;
  /** How long a successfully fetched (or 4xx allow-all) verdict is cached. Default 1 hour. */
  ttlMs?: number;
  /** How long a 5xx/network verdict is cached. Default 5 minutes. */
  errorTtlMs?: number;
  /** Per-request robots.txt fetch timeout. Default 8s. */
  timeoutMs?: number;
  productToken?: string;
}

/** Per-host robots.txt verdict cache with in-flight request dedup. One instance per browser session. */
export class RobotsCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<CacheEntry>>();
  private readonly fetcher: RobotsFetcher;
  private readonly ttlMs: number;
  private readonly errorTtlMs: number;
  private readonly timeoutMs: number;
  private readonly productToken: string;

  constructor(opts: RobotsCacheOptions = {}) {
    this.fetcher = opts.fetcher ?? defaultRobotsFetcher;
    this.ttlMs = opts.ttlMs ?? 60 * 60 * 1000;
    this.errorTtlMs = opts.errorTtlMs ?? 5 * 60 * 1000;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.productToken = opts.productToken ?? ROBOTS_PRODUCT_TOKEN;
  }

  /** Whether automated scraping may open this URL. Non-http(s) and unparseable URLs are allowed. */
  async isAllowed(rawUrl: string): Promise<boolean> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return true;
    }
    if (!/^https?:$/.test(url.protocol)) return true;
    if (url.pathname === "/robots.txt") return true;

    const entry = await this.entryFor(url.origin);
    if (entry.kind === "allow-all") return true;
    if (entry.kind === "disallow-all") return false;
    return isPathAllowed(entry.rules, url.pathname + url.search);
  }

  private async entryFor(origin: string): Promise<CacheEntry> {
    const cached = this.entries.get(origin);
    if (cached && cached.expiresAt > Date.now()) return cached;

    const pending = this.inflight.get(origin);
    if (pending) return pending;

    const promise = this.fetchEntry(origin)
      .then((entry) => {
        this.entries.set(origin, entry);
        return entry;
      })
      .finally(() => this.inflight.delete(origin));
    this.inflight.set(origin, promise);
    return promise;
  }

  private async fetchEntry(origin: string): Promise<CacheEntry> {
    try {
      const res = await this.fetcher(`${origin}/robots.txt`, { timeoutMs: this.timeoutMs, maxBytes: MAX_ROBOTS_BYTES });
      if (res.status >= 200 && res.status < 300) {
        const rules = selectRules(parseRobotsGroups(res.text), this.productToken);
        return { kind: "rules", rules, expiresAt: Date.now() + this.ttlMs };
      }
      if (res.status >= 400 && res.status < 500) {
        // Robots "unavailable" — the site opted out of publishing one; crawling is permitted.
        return { kind: "allow-all", expiresAt: Date.now() + this.ttlMs };
      }
      // 5xx: server is up but erroring — back off politely, but only briefly.
      return { kind: "disallow-all", expiresAt: Date.now() + this.errorTtlMs };
    } catch {
      // Network error / timeout via the SAME transport the scraper uses: the origin is unreachable
      // for scraping too, so fail OPEN (a short-TTL allow) rather than turning our own connectivity
      // problem into a blanket discovery outage. The subsequent page open will itself fail if the
      // host is truly down.
      return { kind: "allow-all", expiresAt: Date.now() + this.errorTtlMs };
    }
  }
}
