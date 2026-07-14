import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { cosineSimilarity, similarityToFit } from "../src/llm/embeddings";
import {
  serializeVector,
  deserializeVector,
  sourceHash,
  ProfileEmbeddingRepo,
  JobEmbeddingRepo,
} from "../src/db/embeddings-repo";
import { openDatabase, type DB } from "../src/db/database";
import { ProfileRepo } from "../src/db/profile-repo";
import { DiscoveredJobsRepo } from "../src/db/discovered-jobs-repo";
import { createBlankProfile } from "../src/profile/factory";

describe("cosine similarity", () => {
  it("is 1 for identical vectors and 0 for orthogonal", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });
  it("handles degenerate vectors without NaN", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
  it("similarityToFit rescales and clamps to 0..1", () => {
    expect(similarityToFit(0.3)).toBe(0); // below floor
    expect(similarityToFit(0.9)).toBe(1); // above ceiling
    expect(similarityToFit(0.625)).toBeCloseTo(0.5, 2); // midpoint
  });
});

describe("vector serialization", () => {
  it("round-trips a vector through Float32 BLOB", () => {
    const v = [0.1, -0.5, 0.9, 1.25, -2.0];
    const back = deserializeVector(serializeVector(v));
    expect(back).toHaveLength(v.length);
    for (let i = 0; i < v.length; i++) expect(back[i]).toBeCloseTo(v[i]!, 5);
  });
  it("sourceHash is stable and model-sensitive", () => {
    expect(sourceHash("m1", "abc")).toBe(sourceHash("m1", "abc"));
    expect(sourceHash("m1", "abc")).not.toBe(sourceHash("m2", "abc"));
  });
});

describe("embedding repos", () => {
  let dir: string;
  let db: DB;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "applypilot-embed-"));
    db = openDatabase(join(dir, "e.sqlite"));
    new ProfileRepo(db, undefined).save(createBlankProfile("emb"));
  });
  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores and reads a profile embedding, upserting on change", () => {
    const repo = new ProfileEmbeddingRepo(db);
    expect(repo.get("emb")).toBeNull();
    repo.set("emb", "nomic-embed-text", [0.1, 0.2, 0.3], "h1");
    const got = repo.get("emb")!;
    expect(got.model).toBe("nomic-embed-text");
    expect(got.sourceHash).toBe("h1");
    expect(got.vector[1]).toBeCloseTo(0.2, 5);

    repo.set("emb", "nomic-embed-text", [0.9, 0.8], "h2");
    expect(repo.get("emb")!.sourceHash).toBe("h2");
    expect(repo.get("emb")!.vector).toHaveLength(2);
  });

  it("stores and reads a job embedding by id", () => {
    const jobs = new DiscoveredJobsRepo(db);
    const { job } = jobs.upsert(
      "emb",
      {
        company: "Acme",
        title: "Engineer",
        jobUrl: "https://job-boards.greenhouse.io/acme/jobs/9",
        atsType: "greenhouse",
        score: 0.7,
        rationale: "ok",
        knockouts: [],
      },
      "scored"
    );
    const embRepo = new JobEmbeddingRepo(db);
    expect(embRepo.get(job.id)).toBeNull();
    embRepo.set(job.id, "nomic-embed-text", [0.5, 0.5, 0.5]);
    const got = embRepo.get(job.id)!;
    expect(got.model).toBe("nomic-embed-text");
    expect(got.vector).toHaveLength(3);
  });
});
