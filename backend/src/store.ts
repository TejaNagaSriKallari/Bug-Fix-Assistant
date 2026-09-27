// store.ts
// -----------------------------------------------------------------------------
// Retrieval over the bug->fix records, now backed by Postgres + pgvector.
//
// CRITICAL SECURITY PROPERTY (unchanged): retrieval is ALWAYS scoped to repos
// the caller is allowed to see, via a `WHERE repo = ANY(...)` filter in SQL.
// There is no query that searches across all repos.
// -----------------------------------------------------------------------------

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pool, initSchema } from "./db.js";
import { embed, toVectorLiteral } from "./embed.js";
import type { BugFixRecord, RetrievalHit } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Insert or update one record (embeds problem + error). Re-indexing an
// unchanged record skips the embedding call, which saves the free-tier quota.
export async function upsert(rec: BugFixRecord): Promise<void> {
  const { rows: existing } = await pool.query(
    `SELECT problem, error FROM bugfix_records WHERE id = $1`,
    [rec.id],
  );
  if (
    existing.length &&
    existing[0].problem === rec.problem &&
    (existing[0].error ?? null) === (rec.error ?? null)
  ) {
    await pool.query(
      `UPDATE bugfix_records SET
         repo=$2, installation=$3, root_cause=$4, fix=$5, files_changed=$6,
         issue_url=$7, pr_url=$8, commit_url=$9
       WHERE id=$1`,
      [
        rec.id,
        rec.repo,
        rec.installationId,
        rec.rootCause ?? null,
        rec.fix,
        rec.filesChanged,
        rec.issueUrl ?? null,
        rec.prUrl ?? null,
        rec.commitUrl ?? null,
      ],
    );
    return;
  }

  const vec = toVectorLiteral(await embed(`${rec.problem}\n${rec.error ?? ""}`));
  await pool.query(
    `INSERT INTO bugfix_records
       (id, repo, installation, problem, error, root_cause, fix, files_changed, issue_url, pr_url, commit_url, embedding)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::vector)
     ON CONFLICT (id) DO UPDATE SET
       repo=$2, installation=$3, problem=$4, error=$5, root_cause=$6, fix=$7,
       files_changed=$8, issue_url=$9, pr_url=$10, commit_url=$11, embedding=$12::vector`,
    [
      rec.id,
      rec.repo,
      rec.installationId,
      rec.problem,
      rec.error ?? null,
      rec.rootCause ?? null,
      rec.fix,
      rec.filesChanged,
      rec.issueUrl ?? null,
      rec.prUrl ?? null,
      rec.commitUrl ?? null,
      vec,
    ],
  );
}

// Load the demo seed file into Postgres (idempotent). Safe to run on boot.
// Skipped when demo logins are off: nobody could see the demo repos anyway.
export async function loadSeedData(): Promise<void> {
  await initSchema();
  if ((process.env.ALLOW_DEMO_AUTH ?? "true") !== "true") {
    console.log("[store] demo auth off, not seeding demo records");
    return;
  }
  const path = join(__dirname, "..", "data", "seed.json");
  const parsed = JSON.parse(await readFile(path, "utf8")) as BugFixRecord[];
  for (const rec of parsed) await upsert(rec);
  console.log(`[store] seeded ${parsed.length} bug/fix records into Postgres`);
}

// Distinct repos we have history for. Used to build a user's visible-repo list.
export async function distinctRepos(): Promise<string[]> {
  const { rows } = await pool.query(`SELECT DISTINCT repo FROM bugfix_records`);
  return rows.map((r: any) => r.repo as string);
}

/**
 * Retrieve the top-k most similar past bugs — ONLY within the given repos.
 * Uses pgvector cosine distance (<=>). similarity = 1 - distance.
 */
export async function retrieve(
  queryText: string,
  allowedRepos: string[],
  k = 3,
): Promise<RetrievalHit[]> {
  if (allowedRepos.length === 0) return [];
  const queryVec = toVectorLiteral(await embed(queryText));

  const { rows } = await pool.query(
    `SELECT id, repo, installation, problem, error, root_cause, fix,
            files_changed, issue_url, pr_url, commit_url,
            1 - (embedding <=> $1::vector) AS score
       FROM bugfix_records
      WHERE repo = ANY($2)          -- the isolation gate, enforced by the DB
      ORDER BY embedding <=> $1::vector
      LIMIT $3`,
    [queryVec, allowedRepos, k],
  );

  return rows.map((r: any) => ({
    record: {
      id: r.id,
      repo: r.repo,
      installationId: r.installation,
      problem: r.problem,
      error: r.error ?? undefined,
      rootCause: r.root_cause ?? undefined,
      fix: r.fix,
      filesChanged: r.files_changed ?? [],
      issueUrl: r.issue_url ?? undefined,
      prUrl: r.pr_url ?? undefined,
      commitUrl: r.commit_url ?? undefined,
    },
    score: Number(r.score),
  }));
}