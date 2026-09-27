// db.ts
// -----------------------------------------------------------------------------
// Postgres connection pool + schema setup for pgvector.
//
// Prereq: a Postgres with the pgvector extension. Easiest:
//   docker run -d --name bugfix-pg -p 5432:5432 \
//     -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=bugfix \
//     pgvector/pgvector:pg16
//
// Set DATABASE_URL in .env, e.g.
//   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/bugfix
// -----------------------------------------------------------------------------

import pg from "pg";
import { EMBED_DIM } from "./embed.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://postgres:postgres@localhost:5432/bugfix",
});

// Create the extension and table if they don't exist.
export async function initSchema(): Promise<void> {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS vector;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bugfix_records (
      id            TEXT PRIMARY KEY,
      repo          TEXT NOT NULL,
      installation  TEXT NOT NULL,
      problem       TEXT NOT NULL,
      error         TEXT,
      root_cause    TEXT,
      fix           TEXT NOT NULL,
      files_changed TEXT[] NOT NULL DEFAULT '{}',
      issue_url     TEXT,
      pr_url        TEXT,
      commit_url    TEXT,
      embedding     vector(${EMBED_DIM}) NOT NULL
    );
  `);
  // Index for fast cosine-distance search. Scoping by repo is a plain WHERE.
  // HNSW, not ivfflat: ivfflat built on an empty/small table has poor recall.
  await pool.query(`DROP INDEX IF EXISTS bugfix_records_embedding_idx;`);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS bugfix_records_embedding_hnsw
    ON bugfix_records USING hnsw (embedding vector_cosine_ops);
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS bugfix_records_repo_idx ON bugfix_records (repo);`,
  );

  // Signed-in sessions. Stored so logins survive restarts (free hosts sleep).
  // Only a hash of the session token is kept, and the GitHub token is encrypted.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash    TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      github_token  TEXT NOT NULL,
      expires_at    TIMESTAMPTZ NOT NULL
    );
  `);
  await pool.query(`DELETE FROM sessions WHERE expires_at < now();`);

  // One CI key per repo (hashed), used by the CI-failure hook.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ci_keys (
      repo        TEXT PRIMARY KEY,
      key_hash    TEXT NOT NULL,
      created_by  TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log("[db] schema ready");
}