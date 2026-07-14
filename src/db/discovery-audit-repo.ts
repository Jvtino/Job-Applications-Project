import { randomUUID } from "node:crypto";
import type { DB } from "./database";
import { dedupKeyForUrl } from "./applications-repo";
import { dedupeConfidence, type DedupeCandidate, type DedupeDecision } from "../jobs/dedupe";
import type { DiscoveredPosting, ScoredPosting } from "../jobs/types";

export type SourceQueryStatus = "issued" | "success" | "partial_failure" | "failure" | "no_results";
export type RawObservationStatus = "observed" | "normalized" | "parse_failed" | "needs_description";
export type NormalizedJobStatus = "candidate_pool" | "duplicate_linked" | "filtered_out" | "scored" | "low_match" | "recommended";

export interface DiscoveryRunAudit {
  traceId: string;
  startedAt: string;
}

export interface SourceQueryInput {
  traceId: string;
  profileId: string;
  sourceType: string;
  queryText: string;
  sourceLabel?: string;
  params?: unknown;
  resultCount?: number;
  status?: SourceQueryStatus;
  failureReason?: string;
}

export interface RawObservationInput {
  traceId: string;
  profileId: string;
  sourceType: string;
  sourceUrl: string;
  queryId?: string;
  fetchedUrl?: string;
  httpStatus?: number;
  contentType?: string;
  rawPayload?: unknown;
  rawHtmlText?: string;
  detectedJsonLd?: unknown;
  parseStatus?: RawObservationStatus;
  parseErrors?: string[];
}

export interface NormalizedJobInput {
  traceId: string;
  profileId: string;
  jobId: string;
  observationId: string;
  posting: DiscoveredPosting;
  isNew: boolean;
  descriptionText?: string;
  salaryMin?: number;
  salaryMax?: number;
  postedAt?: string;
}

export interface DiscoveryExplanation {
  normalizedJob: Record<string, unknown> | null;
  dedupeGroup: Record<string, unknown> | null;
  observations: Record<string, unknown>[];
  filterDecisions: Record<string, unknown>[];
  scorecards: Record<string, unknown>[];
}

export class DiscoveryAuditRepo {
  constructor(private readonly db: DB) {}

  startRun(profileId: string, targetSnapshot?: unknown): DiscoveryRunAudit {
    const startedAt = new Date().toISOString();
    const traceId = `disc_${startedAt.replace(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}`;
    this.db
      .prepare(
        `INSERT INTO discovery_runs (trace_id, profile_id, started_at, status, target_snapshot_json)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(traceId, profileId, startedAt, "running", jsonOrNull(targetSnapshot));
    return { traceId, startedAt };
  }

  finishRun(traceId: string, status: "success" | "partial_failure" | "failure", summary?: unknown): void {
    this.db
      .prepare("UPDATE discovery_runs SET ended_at = ?, status = ?, summary_json = ? WHERE trace_id = ?")
      .run(new Date().toISOString(), status, jsonOrNull(summary), traceId);
  }

  recordSourceQuery(input: SourceQueryInput): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO source_queries (id, trace_id, profile_id, source_type, source_label, query_text, params_json, result_count, status, failure_reason, created_at)
         VALUES (@id, @trace_id, @profile_id, @source_type, @source_label, @query_text, @params_json, @result_count, @status, @failure_reason, @created_at)`
      )
      .run({
        id,
        trace_id: input.traceId,
        profile_id: input.profileId,
        source_type: input.sourceType,
        source_label: input.sourceLabel ?? null,
        query_text: input.queryText,
        params_json: jsonOrNull(input.params),
        result_count: input.resultCount ?? null,
        status: input.status ?? "issued",
        failure_reason: input.failureReason ?? null,
        created_at: new Date().toISOString(),
      });
    return id;
  }

  updateSourceQuery(id: string, patch: { resultCount?: number; status?: SourceQueryStatus; failureReason?: string }): void {
    const row = this.db.prepare("SELECT result_count, status, failure_reason FROM source_queries WHERE id = ?").get(id) as
      | { result_count: number | null; status: string; failure_reason: string | null }
      | undefined;
    if (!row) return;
    this.db
      .prepare("UPDATE source_queries SET result_count = ?, status = ?, failure_reason = ? WHERE id = ?")
      .run(
        patch.resultCount ?? row.result_count,
        patch.status ?? row.status,
        patch.failureReason ?? row.failure_reason,
        id
      );
  }

  recordRawObservation(input: RawObservationInput): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO raw_job_observations (id, trace_id, query_id, profile_id, source_type, source_url, fetched_url, http_status, content_type, raw_payload_json, raw_html_text, detected_jsonld_json, parse_status, parse_errors_json, observed_at)
         VALUES (@id, @trace_id, @query_id, @profile_id, @source_type, @source_url, @fetched_url, @http_status, @content_type, @raw_payload_json, @raw_html_text, @detected_jsonld_json, @parse_status, @parse_errors_json, @observed_at)`
      )
      .run({
        id,
        trace_id: input.traceId,
        query_id: input.queryId ?? null,
        profile_id: input.profileId,
        source_type: input.sourceType,
        source_url: input.sourceUrl,
        fetched_url: input.fetchedUrl ?? input.sourceUrl,
        http_status: input.httpStatus ?? null,
        content_type: input.contentType ?? null,
        raw_payload_json: jsonOrNull(input.rawPayload),
        raw_html_text: input.rawHtmlText ?? null,
        detected_jsonld_json: jsonOrNull(input.detectedJsonLd),
        parse_status: input.parseStatus ?? "observed",
        parse_errors_json: jsonOrNull(input.parseErrors),
        observed_at: new Date().toISOString(),
      });
    return id;
  }

  recordNormalizedCandidate(input: NormalizedJobInput): DedupeDecision | undefined {
    const now = new Date().toISOString();
    const current = toDedupeCandidate(input);
    const duplicate = this.findBestDuplicate(input.profileId, input.jobId, current);
    const canonicalJobId = duplicate && duplicate.decision.confidence >= 0.75 ? duplicate.jobId : input.jobId;
    const status: NormalizedJobStatus = canonicalJobId === input.jobId ? "candidate_pool" : "duplicate_linked";
    const linkAlreadyExists = this.db
      .prepare("SELECT 1 FROM job_observation_links WHERE job_id = ? AND observation_id = ?")
      .get(input.jobId, input.observationId) !== undefined;
    const observationIncrement = linkAlreadyExists ? 0 : 1;
    const existing = this.db
      .prepare("SELECT first_seen_at, observation_count FROM normalized_jobs WHERE job_id = ?")
      .get(input.jobId) as { first_seen_at: string; observation_count: number } | undefined;

    this.db
      .prepare(
        `INSERT INTO normalized_jobs (
          job_id, profile_id, canonical_company, canonical_title, location, country, remote_type,
          canonical_url, application_url, ats_type, salary_min, salary_max, description_text,
          posting_date, normalization_confidence, status, first_seen_at, last_seen_at, observation_count
        ) VALUES (
          @job_id, @profile_id, @canonical_company, @canonical_title, @location, @country, @remote_type,
          @canonical_url, @application_url, @ats_type, @salary_min, @salary_max, @description_text,
          @posting_date, @normalization_confidence, @status, @first_seen_at, @last_seen_at, @observation_count
        )
        ON CONFLICT(job_id) DO UPDATE SET
          canonical_company = excluded.canonical_company,
          canonical_title = excluded.canonical_title,
          location = excluded.location,
          country = excluded.country,
          remote_type = excluded.remote_type,
          canonical_url = excluded.canonical_url,
          application_url = excluded.application_url,
          ats_type = excluded.ats_type,
          salary_min = excluded.salary_min,
          salary_max = excluded.salary_max,
          description_text = COALESCE(excluded.description_text, normalized_jobs.description_text),
          posting_date = COALESCE(excluded.posting_date, normalized_jobs.posting_date),
          normalization_confidence = excluded.normalization_confidence,
          status = excluded.status,
          last_seen_at = excluded.last_seen_at,
          observation_count = normalized_jobs.observation_count + @observation_increment`
      )
      .run({
        job_id: input.jobId,
        profile_id: input.profileId,
        canonical_company: input.posting.company,
        canonical_title: input.posting.title,
        location: input.posting.location ?? null,
        country: inferCountry(input.posting.location, input.descriptionText),
        remote_type: inferRemoteType(input.posting.location, input.descriptionText),
        canonical_url: dedupKeyForUrl(input.posting.jobUrl),
        application_url: input.posting.jobUrl,
        ats_type: input.posting.atsType,
        salary_min: input.salaryMin ?? null,
        salary_max: input.salaryMax ?? null,
        description_text: input.descriptionText ?? null,
        posting_date: input.postedAt ?? null,
        normalization_confidence: input.posting.title && input.posting.company ? 0.95 : 0.6,
        status,
        first_seen_at: existing?.first_seen_at ?? now,
        last_seen_at: now,
        observation_count: existing ? existing.observation_count + observationIncrement : 1,
        observation_increment: observationIncrement,
      });

    this.linkObservation(input.jobId, input.observationId, input.traceId, canonicalJobId === input.jobId, 0, duplicate?.decision.confidence ?? 1);
    if (canonicalJobId !== input.jobId && duplicate) {
      this.linkObservation(canonicalJobId, input.observationId, input.traceId, true, 1, duplicate.decision.confidence);
    }

    this.upsertDedupeGroup({
      profileId: input.profileId,
      jobId: canonicalJobId,
      dedupeKey: dedupKeyForUrl(input.posting.jobUrl),
      confidence: duplicate?.decision.confidence ?? 1,
      survivorReason: duplicate
        ? { decision: duplicate.decision.decision, signals: duplicate.decision.signals, matchedJobId: duplicate.jobId }
        : { decision: "primary_source", signal: "first_observation" },
      mergedFields: {
        observationId: input.observationId,
        sourceUrl: input.posting.jobUrl,
        currentJobId: input.jobId,
      },
    });
    this.updateFts(input.jobId, input.posting, input.descriptionText);
    return duplicate?.decision;
  }

  recordFilterDecisions(traceId: string, jobId: string, scored: ScoredPosting): void {
    if (scored.knockouts.length === 0) {
      this.insertFilterDecision(traceId, jobId, {
        filterName: "hard_filters",
        result: "pass",
        reasonCode: "no_hard_filter",
        reasonText: "No deterministic hard filters fired.",
        evidence: { title: scored.title, location: scored.location ?? null },
      });
      return;
    }
    for (const knockout of scored.knockouts) {
      this.insertFilterDecision(traceId, jobId, {
        filterName: "hard_filters",
        result: "reject",
        reasonCode: reasonCode(knockout),
        reasonText: knockout,
        evidence: { title: scored.title, location: scored.location ?? null, jobUrl: scored.jobUrl },
      });
    }
    this.updateNormalizedStatus(jobId, "filtered_out");
  }

  recordScorecard(traceId: string, jobId: string, scored: ScoredPosting, scoreVersion = "legacy-fit-v1"): void {
    this.db
      .prepare(
        `INSERT INTO scorecards (id, job_id, trace_id, component_scores_json, overall_score, score_version, explanation_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        randomUUID(),
        jobId,
        traceId,
        JSON.stringify({
          ...(scored.fitFactors ?? {}),
          ...(scored.fit ? { categories: scored.fit.categoryScores } : {}),
        }),
        scored.score,
        scoreVersion,
        JSON.stringify({
          rationale: scored.rationale,
          knockouts: scored.knockouts,
          tags: scored.tags ?? [],
          fit: scored.fit ?? null,
        }),
        new Date().toISOString()
      );
    if (scored.knockouts.length === 0) {
      this.updateNormalizedStatus(jobId, scored.score >= 0.5 ? "recommended" : "low_match");
    }
  }

  recordRerankDecision(traceId: string, jobId: string, output: unknown, opts: { inputFacts?: unknown; modelName?: string; promptHash?: string; latencyMs?: number } = {}): void {
    this.db
      .prepare(
        `INSERT INTO rerank_decisions (id, job_id, trace_id, input_facts_json, output_json, model_name, prompt_hash, latency_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        randomUUID(),
        jobId,
        traceId,
        jsonOrNull(opts.inputFacts),
        JSON.stringify(output),
        opts.modelName ?? null,
        opts.promptHash ?? null,
        opts.latencyMs ?? null,
        new Date().toISOString()
      );
  }

  explainJob(jobId: string): DiscoveryExplanation {
    const normalizedJob = this.db.prepare("SELECT * FROM normalized_jobs WHERE job_id = ?").get(jobId) as Record<string, unknown> | undefined;
    const dedupeKey = typeof normalizedJob?.canonical_url === "string" ? normalizedJob.canonical_url : "";
    const dedupeGroup = this.db.prepare("SELECT * FROM dedupe_groups WHERE job_id = ? OR dedupe_key = ? ORDER BY updated_at DESC LIMIT 1").get(jobId, dedupeKey) as
      | Record<string, unknown>
      | undefined;
    const observations = this.db
      .prepare(
        `SELECT o.* FROM raw_job_observations o
         JOIN job_observation_links l ON l.observation_id = o.id
         WHERE l.job_id = ?
         ORDER BY o.observed_at DESC`
      )
      .all(jobId) as Record<string, unknown>[];
    const filterDecisions = this.db
      .prepare("SELECT * FROM filter_decisions WHERE job_id = ? ORDER BY decided_at DESC")
      .all(jobId) as Record<string, unknown>[];
    const scorecards = this.db
      .prepare("SELECT * FROM scorecards WHERE job_id = ? ORDER BY created_at DESC")
      .all(jobId) as Record<string, unknown>[];
    return {
      normalizedJob: normalizedJob ?? null,
      dedupeGroup: dedupeGroup ?? null,
      observations,
      filterDecisions,
      scorecards,
    };
  }

  private findBestDuplicate(profileId: string, jobId: string, current: DedupeCandidate): { jobId: string; decision: DedupeDecision } | undefined {
    const rows = this.db
      .prepare(
        `SELECT job_id, canonical_company, canonical_title, location, application_url, ats_type, description_text
         FROM normalized_jobs
         WHERE profile_id = ? AND job_id <> ?`
      )
      .all(profileId, jobId) as {
        job_id: string;
        canonical_company: string;
        canonical_title: string;
        location: string | null;
        application_url: string;
        ats_type: string | null;
        description_text: string | null;
      }[];
    let best: { jobId: string; decision: DedupeDecision } | undefined;
    for (const row of rows) {
      const decision = dedupeConfidence(current, {
        company: row.canonical_company,
        title: row.canonical_title,
        location: row.location,
        jobUrl: row.application_url,
        atsType: row.ats_type,
        description: row.description_text,
      });
      if (!best || decision.confidence > best.decision.confidence) best = { jobId: row.job_id, decision };
    }
    return best && best.decision.confidence >= 0.55 ? best : undefined;
  }

  private linkObservation(jobId: string, observationId: string, traceId: string, primary: boolean, sourceRank: number, confidence: number): void {
    this.db
      .prepare(
        `INSERT INTO job_observation_links (job_id, observation_id, trace_id, is_primary_source, source_rank, match_confidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(job_id, observation_id) DO UPDATE SET
           match_confidence = excluded.match_confidence,
           is_primary_source = excluded.is_primary_source`
      )
      .run(jobId, observationId, traceId, primary ? 1 : 0, sourceRank, confidence, new Date().toISOString());
  }

  private upsertDedupeGroup(input: { profileId: string; jobId: string; dedupeKey: string; confidence: number; survivorReason: unknown; mergedFields: unknown }): void {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO dedupe_groups (id, profile_id, job_id, dedupe_key, group_confidence, survivor_reason_json, merged_fields_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(profile_id, dedupe_key) DO UPDATE SET
           job_id = excluded.job_id,
           group_confidence = excluded.group_confidence,
           survivor_reason_json = excluded.survivor_reason_json,
           merged_fields_json = excluded.merged_fields_json,
           updated_at = excluded.updated_at`
      )
      .run(
        id,
        input.profileId,
        input.jobId,
        input.dedupeKey,
        input.confidence,
        JSON.stringify(input.survivorReason),
        JSON.stringify(input.mergedFields),
        now,
        now
      );
  }

  private insertFilterDecision(traceId: string, jobId: string, input: { filterName: string; result: string; reasonCode: string; reasonText: string; evidence: unknown }): void {
    this.db
      .prepare(
        `INSERT INTO filter_decisions (id, job_id, trace_id, filter_name, result, reason_code, reason_text, evidence_json, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(randomUUID(), jobId, traceId, input.filterName, input.result, input.reasonCode, input.reasonText, JSON.stringify(input.evidence), new Date().toISOString());
  }

  private updateNormalizedStatus(jobId: string, status: NormalizedJobStatus): void {
    this.db
      .prepare(
        `UPDATE normalized_jobs
         SET status = CASE
           WHEN status = 'duplicate_linked' AND ? IN ('scored', 'low_match', 'recommended') THEN status
           ELSE ?
         END
         WHERE job_id = ?`
      )
      .run(status, status, jobId);
  }

  private updateFts(jobId: string, posting: DiscoveredPosting, descriptionText?: string): void {
    this.db.prepare("DELETE FROM normalized_jobs_fts WHERE job_id = ?").run(jobId);
    this.db
      .prepare("INSERT INTO normalized_jobs_fts (job_id, title, company, location, description) VALUES (?, ?, ?, ?, ?)")
      .run(jobId, posting.title, posting.company, posting.location ?? "", descriptionText ?? "");
  }
}

function toDedupeCandidate(input: NormalizedJobInput): DedupeCandidate {
  return {
    company: input.posting.company,
    title: input.posting.title,
    location: input.posting.location ?? null,
    jobUrl: input.posting.jobUrl,
    atsType: input.posting.atsType,
    description: input.descriptionText ?? null,
  };
}

function jsonOrNull(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function reasonCode(reason: string): string {
  return reason.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "hard_filter";
}

function inferCountry(location?: string, description?: string): string | null {
  const text = `${location ?? ""} ${description ?? ""}`.toLowerCase();
  if (/\b(canada|united kingdom|uk|london|ontario|toronto|vancouver|european union|eu)\b/.test(text)) return "non_us";
  if (/\b(united states|usa|u\.s\.|us remote|remote us|new york|ny|austin|tx|california|ca)\b/.test(text)) return "US";
  return null;
}

function inferRemoteType(location?: string, description?: string): string | null {
  const text = `${location ?? ""} ${description ?? ""}`.toLowerCase();
  if (/\bhybrid\b/.test(text)) return "hybrid";
  if (/\bremote\b/.test(text)) return "remote";
  if (/\bon[- ]?site|onsite\b/.test(text)) return "onsite";
  return null;
}
