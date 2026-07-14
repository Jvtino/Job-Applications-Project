#!/usr/bin/env node
/**
 * Live E2E validation: Ollama embeddings + LLM rerank + discovery against real ATS boards.
 * Dev validation against a live local model server (`ollama serve`) — the packaged product uses the bundled models instead.
 *
 * Exit 0 when semantic discovery works; rerank is required only when the chat model is healthy.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { BrowserSession } = await import("../src/ats/browser.ts");
const { openDatabase, closeDatabase } = await import("../src/db/database.ts");
const { ProfileRepo } = await import("../src/db/profile-repo.ts");
const { LedgerRepo } = await import("../src/db/ledger-repo.ts");
const { CompaniesRepo } = await import("../src/db/companies-repo.ts");
const { createBlankProfile } = await import("../src/profile/factory.ts");
const { buildLedger } = await import("../src/ingestion/ledger-ops.ts");
const { runDiscovery } = await import("../src/discovery/discover.ts");
const { getEmbeddingClient, resetEmbeddingClientCache } = await import("../src/llm/embeddings.ts");
const { getLlmClient, resetLlmClientCache } = await import("../src/llm/client.ts");
const { normalizeBoard } = await import("../src/discovery/registry.ts");
const { loadLlmConfig } = await import("../src/llm/config.ts");

// This script validates a LIVE Ollama server specifically — pin the env to it before any engine
// import resolves providers, since the product default is now the bundled in-process model.
process.env.APPLYPILOT_LLM_PROVIDER ||= "ollama";
process.env.APPLYPILOT_EMBED_BASE_URL ||= "http://localhost:11434/v1";
process.env.APPLYPILOT_EMBED_MODEL ||= "nomic-embed-text";

const PROFILE_ID = "live-validate";
const BOARDS = [{ name: "1Password", url: "https://jobs.ashbyhq.com/1password" }];

function log(section, msg) {
  process.stdout.write(`[${section}] ${msg}\n`);
}

/** Returns true when Ollama chat completions respond (embeddings alone are not enough). */
async function chatModelHealthy(model) {
  try {
    const res = await fetch("http://127.0.0.1:11434/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with exactly: ok" }],
        stream: false,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      log("preflight", `chat unhealthy (${res.status}): ${err.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    log("preflight", `chat unreachable: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function main() {
  resetEmbeddingClientCache();
  resetLlmClientCache();

  const llmCfg = loadLlmConfig();
  const chatOk = llmCfg ? await chatModelHealthy(llmCfg.model) : false;
  log("preflight", `chat model (${llmCfg?.model ?? "none"}): ${chatOk ? "healthy" : "UNAVAILABLE"}`);

  const dir = mkdtempSync(join(tmpdir(), "applypilot-live-"));
  const dbPath = join(dir, "live.sqlite");
  const db = openDatabase(dbPath);

  log("setup", `temp db ${dbPath}`);

  const profile = createBlankProfile(PROFILE_ID);
  profile.preferences.targetRoles = ["Data Engineer"];
  profile.preferences.workModePreference = { value: ["remote"], source: "user", updatedAt: "" };
  profile.workAuthorization.authorizedToWorkInUS = { value: true, source: "user", updatedAt: "" };
  profile.workAuthorization.requiresSponsorshipNowOrFuture = { value: false, source: "user", updatedAt: "" };
  new ProfileRepo(db, undefined).save(profile);

  const facts = buildLedger(PROFILE_ID, [
    {
      id: "e1",
      type: "employment",
      approved: true,
      title: "Senior Data Engineer",
      employer: "Contoso",
      startDate: "2016",
      endDate: "present",
      bullets: ["Built Spark ETL pipelines on AWS", "Owned the analytics data warehouse"],
    },
    { id: "s1", type: "skill", approved: true, statement: "Python" },
    { id: "s2", type: "skill", approved: true, statement: "SQL" },
    { id: "s3", type: "skill", approved: true, statement: "Spark" },
    { id: "s4", type: "skill", approved: true, statement: "Airflow" },
  ]).facts;
  new LedgerRepo(db, undefined).save(buildLedger(PROFILE_ID, facts));

  const companies = new CompaniesRepo(db);
  for (const b of BOARDS) {
    const n = normalizeBoard(b.url);
    companies.add(b.name, n.boardUrl, n.atsType);
  }

  const embed = getEmbeddingClient();
  const llm = getLlmClient();
  log("ollama", `embedding client: ${embed ? embed.model : "NONE"}`);
  log("ollama", `chat client: ${llm ? llm.model : "NONE"}`);
  if (!embed) {
    throw new Error("Embedding client unavailable — is ollama serve running with nomic-embed-text?");
  }

  const session = new BrowserSession({ headed: false, minActionDelayMs: 800, maxActionDelayMs: 1500 });
  await session.start();
  const progress = [];
  try {
    log("discovery", "starting live pass (1Password Ashby board)…");
    const run = await runDiscovery(session, db, profile, facts, {
      onProgress: (m) => {
        progress.push(m);
        if (/semantic|rerank|Reading/i.test(m)) log("progress", m);
      },
    });

    const semanticEnabled = progress.some((m) => /Semantic matching enabled/i.test(m));
    const rerankRan = progress.some((m) => /Reranking .* with AI/i.test(m));
    log("check", `semantic path active: ${semanticEnabled}`);
    log("check", `rerank attempted: ${rerankRan}`);

    const scored = run.scored.filter((s) => s.knockouts.length === 0).sort((a, b) => b.score - a.score);
    const withSemantic = scored.filter((s) => /semantic fit/i.test(s.rationale));
    const withRerank = scored.filter((s) => /AI rerank/i.test(s.rationale));
    log("check", `knockout-free scored: ${scored.length}`);
    log("check", `with semantic fit in rationale: ${withSemantic.length}`);
    log("check", `with AI rerank in rationale: ${withRerank.length}`);

    const irrelevant = scored.filter((s) =>
      /account executive|sales development|marketing manager|office manager/i.test(s.title)
    );
    log("check", `likely irrelevant titles above 0.5: ${irrelevant.filter((s) => s.score >= 0.5).length}`);

    log("top", "top 8 matches:");
    for (const m of scored.slice(0, 8)) {
      log(
        "top",
        `${m.score.toFixed(3)} ${m.title.slice(0, 52)} | ${m.rationale.slice(0, 120)}${m.rationale.length > 120 ? "…" : ""}`
      );
    }

    const failures = [];
    if (!semanticEnabled) failures.push("semantic matching did not activate");
    if (withSemantic.length === 0) failures.push("no postings received semantic fit scores");
    if (scored.length === 0) failures.push("no knockout-free postings scored");
    if (irrelevant.some((s) => s.score >= 0.5)) {
      const bad = irrelevant.find((s) => s.score >= 0.5);
      failures.push(`irrelevant role above 0.5: ${bad?.title ?? "unknown"}`);
    }
    if (chatOk) {
      if (!rerankRan) failures.push("LLM rerank did not run");
      if (withRerank.length === 0) failures.push("no postings received AI rerank scores");
    } else {
      log("warn", "chat model segfaulted/unavailable on this host — rerank skipped (semantic path still validated)");
    }

    if (failures.length) {
      log("FAIL", failures.join("; "));
      process.exitCode = 1;
    } else {
      log("PASS", chatOk ? "full live validation (semantic + rerank)" : "semantic discovery validation (rerank blocked by Ollama chat on this host)");
    }
  } finally {
    await session.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
