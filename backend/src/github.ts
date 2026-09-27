// github.ts
// -----------------------------------------------------------------------------
// Talks to GitHub on the server side. This is how "everyone" works: instead of
// a hardcoded user list, we ask GitHub who the user is and what they can read.
//
// Uses a GitHub OAuth App (client id + secret). The secret lives ONLY here on
// the server — the extension never sees it.
//
// >>> MORE LOCKED-DOWN PRODUCTION OPTION <<<
// A GitHub *App* (installed per-repo) with user-to-server tokens restricts the
// token to just the installed repos, instead of an OAuth App's broad `repo`
// scope. The shape below is the same; only the token source changes.
// -----------------------------------------------------------------------------

const GH_API = "https://api.github.com";

function ghHeaders(token: string) {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "bugfix-assistant",
  };
}

// Step 2 of OAuth: trade the temporary code for a user access token.
export async function exchangeCodeForToken(code: string): Promise<string> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });
  const data = (await res.json()) as { access_token?: string; error?: string };
  if (!data.access_token) {
    throw new Error(`OAuth exchange failed: ${data.error ?? "no token returned"}`);
  }
  return data.access_token;
}

// Who is this token's owner? Returns the GitHub login.
export async function getLogin(token: string): Promise<string> {
  const res = await fetch(`${GH_API}/user`, { headers: ghHeaders(token) });
  if (!res.ok) throw new Error(`GitHub /user failed (${res.status})`);
  const u = (await res.json()) as { login: string };
  return u.login;
}

// Can THIS user read THIS repo? 200 on the repo endpoint means yes (GitHub only
// returns a private repo if the token's user has access). This is the real
// per-user gate that replaces the hardcoded map.
export async function userCanReadRepo(
  token: string,
  repo: string,
): Promise<boolean> {
  const res = await fetch(`${GH_API}/repos/${repo}`, {
    headers: ghHeaders(token),
  });
  if (res.status !== 200) return false;
  const r = (await res.json()) as { permissions?: { pull?: boolean } };
  // If permissions are present, require pull (read). If absent, 200 already
  // implies visibility.
  return r.permissions ? !!r.permissions.pull : true;
}

// Can THIS user push to THIS repo? Required to create the repo's CI key, so a
// mere reader of a public repo can't replace the owner's key.
export async function userCanPushRepo(
  token: string,
  repo: string,
): Promise<boolean> {
  const res = await fetch(`${GH_API}/repos/${repo}`, {
    headers: ghHeaders(token),
  });
  if (res.status !== 200) return false;
  const r = (await res.json()) as { permissions?: { push?: boolean } };
  return !!r.permissions?.push;
}

// -----------------------------------------------------------------------------
// Mining helpers — used by scripts/mine.ts to read a user's repo history.
// -----------------------------------------------------------------------------

export interface RepoRef {
  fullName: string; // "owner/name"
  owner: string;
  name: string;
}

// Repos the signed-in user can access (owner, collaborator, org member).
export async function listAccessibleRepos(
  token: string,
  maxRepos = 20,
): Promise<RepoRef[]> {
  const out: RepoRef[] = [];
  for (let page = 1; out.length < maxRepos && page <= 5; page++) {
    const res = await fetch(
      `${GH_API}/user/repos?per_page=100&page=${page}&affiliation=owner,collaborator,organization_member&sort=updated`,
      { headers: ghHeaders(token) },
    );
    if (!res.ok) {
      console.error(
        `[github] /user/repos page ${page} failed (${res.status}):`,
        await res.text(),
        "| token scopes:", res.headers.get("x-oauth-scopes"),
      );
      break;
    }
    const rows = (await res.json()) as { full_name: string; owner: { login: string }; name: string }[];
    if (rows.length === 0) {
      console.log(
        `[github] /user/repos page ${page} returned no repos | token scopes:`,
        res.headers.get("x-oauth-scopes"),
      );
      break;
    }
    for (const r of rows) {
      out.push({ fullName: r.full_name, owner: r.owner.login, name: r.name });
      if (out.length >= maxRepos) break;
    }
  }
  return out;
}

// Closed issues (not PRs) for a repo, newest first.
export async function listClosedIssues(
  token: string,
  owner: string,
  repo: string,
  max = 30,
): Promise<{ number: number; title: string; body: string; url: string }[]> {
  const res = await fetch(
    `${GH_API}/repos/${owner}/${repo}/issues?state=closed&per_page=${Math.min(max, 100)}&sort=updated`,
    { headers: ghHeaders(token) },
  );
  if (!res.ok) return [];
  const rows = (await res.json()) as any[];
  return rows
    .filter((r) => !r.pull_request) // exclude PRs, which also appear here
    .map((r) => ({
      number: r.number,
      title: r.title ?? "",
      body: r.body ?? "",
      url: r.html_url ?? "",
    }));
}

// For a closed issue, find the PR or commit that closed it (via the timeline).
export async function findFixForIssue(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<{
  fixText: string;
  filesChanged: string[];
  prUrl?: string;
  commitUrl?: string;
} | null> {
  const res = await fetch(
    `${GH_API}/repos/${owner}/${repo}/issues/${issueNumber}/timeline?per_page=100`,
    { headers: { ...ghHeaders(token), accept: "application/vnd.github+json" } },
  );
  if (!res.ok) return null;
  const events = (await res.json()) as any[];

  // Prefer a linked PR (best: has a title/body describing the fix + files).
  for (const ev of events) {
    const src = ev.source?.issue;
    if (
      (ev.event === "cross-referenced" || ev.event === "connected") &&
      src?.pull_request
    ) {
      const prNumber = src.number;
      const prRes = await fetch(
        `${GH_API}/repos/${owner}/${repo}/pulls/${prNumber}`,
        { headers: ghHeaders(token) },
      );
      if (prRes.ok) {
        const pr = (await prRes.json()) as any;
        const files = await listPullFiles(token, owner, repo, prNumber);
        return {
          fixText: `${pr.title ?? ""}\n${pr.body ?? ""}`.trim(),
          filesChanged: files,
          prUrl: pr.html_url,
        };
      }
    }
  }

  // Otherwise, the commit that closed the issue.
  for (const ev of events) {
    if (ev.event === "closed" && ev.commit_id) {
      const cRes = await fetch(
        `${GH_API}/repos/${owner}/${repo}/commits/${ev.commit_id}`,
        { headers: ghHeaders(token) },
      );
      if (cRes.ok) {
        const c = (await cRes.json()) as any;
        return {
          fixText: c.commit?.message ?? "closing commit",
          filesChanged: (c.files ?? []).map((f: any) => f.filename),
          commitUrl: c.html_url,
        };
      }
    }
  }
  return null;
}

async function listPullFiles(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<string[]> {
  const res = await fetch(
    `${GH_API}/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`,
    { headers: ghHeaders(token) },
  );
  if (!res.ok) return [];
  const files = (await res.json()) as { filename: string }[];
  return files.map((f) => f.filename);
}