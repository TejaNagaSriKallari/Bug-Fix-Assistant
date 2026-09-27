// mine.ts
// -----------------------------------------------------------------------------
// Builds the knowledge base from a user's real GitHub history.
//
// For each repo the user can access:
//   1. list closed issues (the PROBLEM, in human language)
//   2. find the PR/commit that closed each one (the FIX + files changed)
//   3. turn it into a BugFixRecord and upsert() it into Postgres
//
// Exposed as mineUserRepos() so the backend can run it for the signed-in user
// (see POST /api/index). Also runnable from the CLI with a token in GITHUB_TOKEN
// for testing: `GITHUB_TOKEN=ghp_xxx npm run mine`.
// -----------------------------------------------------------------------------

import {
  listAccessibleRepos,
  listClosedIssues,
  findFixForIssue,
} from "../src/github.js";
import { upsert } from "../src/store.js";
import type { BugFixRecord } from "../src/types.js";

export interface MineOptions {
  maxRepos?: number;
  maxIssuesPerRepo?: number;
  onProgress?: (msg: string) => void;
}

// Mine every accessible repo for this token. Returns how many records were stored.
export async function mineUserRepos(
  token: string,
  opts: MineOptions = {},
): Promise<number> {
  const maxRepos = opts.maxRepos ?? 15;
  const maxIssues = opts.maxIssuesPerRepo ?? 30;
  const log = opts.onProgress ?? (() => {});

  const repos = await listAccessibleRepos(token, maxRepos);
  log(`Found ${repos.length} repo(s) to scan`);

  let stored = 0;
  for (const repo of repos) {
    const issues = await listClosedIssues(token, repo.owner, repo.name, maxIssues);
    log(`${repo.fullName}: ${issues.length} closed issue(s)`);

    for (const issue of issues) {
      const fix = await findFixForIssue(token, repo.owner, repo.name, issue.number);
      if (!fix) continue; // no linked PR/commit -> not a usable bug->fix pair

      const rec: BugFixRecord = {
        id: `${repo.fullName}#${issue.number}`,
        repo: repo.fullName,
        installationId: "oauth", // OAuth flow; not an App installation
        problem: issue.title,
        error: issue.body?.slice(0, 2000) || undefined,
        fix: fix.fixText.slice(0, 2000),
        filesChanged: fix.filesChanged.slice(0, 30),
        issueUrl: issue.url,
        prUrl: fix.prUrl,
        commitUrl: fix.commitUrl,
      };
      await upsert(rec);
      stored++;
    }
  }
  log(`Stored ${stored} bug/fix record(s)`);
  return stored;
}

// --- CLI entry point ----------------------------------------------------------
// Only runs when invoked directly (npm run mine), not when imported.
const isCli = process.argv[1]?.endsWith("mine.ts") || process.argv[1]?.endsWith("mine.js");
if (isCli) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error("Set GITHUB_TOKEN=<a token> to mine from the CLI.");
    process.exit(1);
  }
  mineUserRepos(token, { onProgress: (m) => console.log("[mine]", m) })
    .then((n) => {
      console.log(`Done. ${n} records stored.`);
      process.exit(0);
    })
    .catch((e) => {
      console.error("Mining failed:", e);
      process.exit(1);
    });
}