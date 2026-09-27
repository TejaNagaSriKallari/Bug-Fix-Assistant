// server.ts — the HTTP API the extension talks to.
import "dotenv/config";
import express from "express";
import cors from "cors";
import { loadSeedData, retrieve } from "./store.js";
import {
  identify,
  allowedReposFor,
  endSession,
  startLink,
  completeLink,
  pollLink,
  forgetRepoList,
  createCiKey,
  verifyCiKey,
} from "./auth.js";
import { answer } from "./llm.js";
import type { ChatTurn } from "./types.js";
import { mineUserRepos } from "../scripts/mine.js";

const app = express();
// Only the browser extension calls the API from a browser; the auth pages are
// plain navigations and the CI hook is a server-to-server call, neither needs
// CORS. So allow extension origins only.
app.use(
  cors({
    origin: (origin, cb) =>
      cb(null, !origin || /^(chrome-extension|extension):\/\//.test(origin)),
  }),
);
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT) || 8787;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const OAUTH_SCOPE = process.env.GITHUB_OAUTH_SCOPE || "repo read:user";
const RELEVANCE = Number(process.env.RELEVANCE_THRESHOLD ?? 0.6);

// Small helper: pull the caller's identity or 401.
async function requireIdentity(req: express.Request, res: express.Response) {
  const id = await identify(req.header("authorization"));
  if (!id) {
    res.status(401).json({ error: "unauthenticated" });
    return null;
  }
  return id;
}

// --- rate limiting -------------------------------------------------------------
// In-memory fixed windows (one instance is all a free host runs). Protects the
// free LLM/embedding quotas that every user shares.
const hits = new Map<string, { count: number; resetAt: number }>();
function allow(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.resetAt <= now) {
    hits.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (h.count >= limit) return false;
  h.count++;
  return true;
}
const HOUR = 60 * 60 * 1000;
const CHAT_PER_HOUR = Number(process.env.CHAT_LIMIT_PER_HOUR ?? 40);
const INDEX_PER_HOUR = Number(process.env.INDEX_LIMIT_PER_HOUR ?? 3);
const CI_PER_HOUR = Number(process.env.CI_LIMIT_PER_HOUR ?? 20);

// Keep only well-formed, recent chat turns from the client. Starts on a user
// turn (Anthropic requires it) and caps length so prompts stay small.
const MAX_HISTORY_TURNS = 10;
function cleanHistory(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw)) return [];
  const turns = raw
    .filter(
      (t): t is ChatTurn =>
        !!t &&
        (t.role === "user" || t.role === "assistant") &&
        typeof t.content === "string" &&
        t.content.trim() !== "",
    )
    .map((t) => ({ role: t.role, content: t.content.slice(0, 4000) }))
    .slice(-MAX_HISTORY_TURNS);
  while (turns.length && turns[0].role !== "user") turns.shift();
  return turns;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

app.get("/health", (_req, res) => res.json({ ok: true }));

// Privacy policy — the Edge Add-ons store asks for a URL to one.
app.get("/privacy", (_req, res) => {
  res.send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bug-Fix Assistant — Privacy</title></head>
<body style="font-family:sans-serif;max-width:720px;margin:40px auto;padding:0 16px;line-height:1.6">
<h1>Bug-Fix Assistant — Privacy Policy</h1>
<p><b>What we collect.</b> When you sign in with GitHub we receive your GitHub username and an
access token. The token is stored encrypted on our server and used only to read your repositories'
closed issues, the pull requests/commits that fixed them, and which repositories you can access.
We never write to your repositories.</p>
<p><b>What we store.</b> When you click "Index my repos", the title and text of closed issues and the
description and changed file names of their fixes are stored so they can be searched. Chat messages
are not stored on our server; the extension keeps the current conversation in your browser tab only.</p>
<p><b>Who can see it.</b> Stored history for a repository is shown only to signed-in users whom GitHub
reports as having access to that repository, and to CI runs using that repository's CI key.</p>
<p><b>Third parties.</b> Messages and matching past bugs are sent to an AI provider (Groq) to write
replies, and issue text is sent to Google's Gemini API to create search embeddings.</p>
<p><b>Your control.</b> Signing out deletes your session and stored token. You can also revoke access at
any time at GitHub → Settings → Applications. To have indexed data for your repositories removed,
open an issue on this project's GitHub repository.</p>
</body></html>`);
});

// --- Auth (GitHub OAuth, tab-based) -------------------------------------------
// Flow: extension opens /auth/start?link=<id> in a normal tab -> we redirect to
// GitHub -> GitHub redirects to /auth/callback -> we make a session and stash it
// under <id> -> the extension polls /auth/poll?link=<id> to pick it up.
// (A normal tab is required: GitHub refuses to authorize inside the embedded
// webview that chrome.identity.launchWebAuthFlow uses.)

app.get("/auth/start", (req, res) => {
  const link = String(req.query.link ?? "");
  if (!link) return res.status(400).send("missing link id");
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) return res.status(500).send("GITHUB_CLIENT_ID not set on the backend");

  startLink(link);
  const redirectUri = `${PUBLIC_URL}/auth/callback`;
  const authUrl =
    `https://github.com/login/oauth/authorize` +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(OAUTH_SCOPE)}` +
    `&state=${encodeURIComponent(link)}`;
  res.redirect(authUrl);
});

app.get("/auth/callback", async (req, res) => {
  const code = String(req.query.code ?? "");
  const state = String(req.query.state ?? "");
  if (!code || !state) return res.status(400).send("missing code/state");
  try {
    await completeLink(state, code);
    res.send(
      `<html><body style="font-family:sans-serif;text-align:center;padding:48px">
         <h2>Signed in &#10003;</h2>
         <p>You can close this tab and go back to GitHub.</p>
         <script>setTimeout(function(){window.close();}, 1200)</script>
       </body></html>`,
    );
  } catch (e: any) {
    res.status(401).send("Sign-in failed: " + escapeHtml(String(e.message ?? "error")));
  }
});

app.get("/auth/poll", (req, res) => {
  const link = String(req.query.link ?? "");
  const result = pollLink(link);
  if (!result) return res.json({ pending: true });
  res.json(result);
});

// Who am I? Lets the panel show the signed-in user or a sign-in button.
app.get("/auth/me", async (req, res) => {
  try {
    const id = await identify(req.header("authorization"));
    if (!id) return res.status(401).json({ error: "unauthenticated" });
    res.json({ user: id.userId, demo: !!id.demo });
  } catch (e: any) {
    console.error("[auth/me]", e);
    res.status(500).json({ error: "session lookup failed" });
  }
});

app.post("/auth/logout", async (req, res) => {
  const m = (req.header("authorization") ?? "").match(/^Bearer\s+(.+)$/);
  try {
    if (m) await endSession(m[1].trim());
  } catch (e) {
    console.error("[auth/logout]", e);
  }
  res.json({ ok: true });
});

// What repos can the caller see? Lets the panel show a repo picker / status.
app.get("/api/repos", async (req, res) => {
  try {
    const id = await requireIdentity(req, res);
    if (!id) return;
    res.json({ user: id.userId, repos: await allowedReposFor(id) });
  } catch (e: any) {
    console.error("[repos]", e);
    res.status(500).json({ error: e.message ?? "failed" });
  }
});

// --- Indexing (runs in the background) -------------------------------------------
// Indexing can take minutes (GitHub calls + embedding rate limits), longer than a
// browser request should wait. POST starts a job; the panel polls the status.
interface IndexJob {
  status: "running" | "done" | "error";
  indexed: number;
  message: string;
}
const indexJobs = new Map<string, IndexJob>();
const MAX_CONCURRENT_INDEX = 2;

app.post("/api/index", async (req, res) => {
  try {
    const id = await requireIdentity(req, res);
    if (!id) return;
    if (id.demo || !id.githubToken) {
      return res.status(400).json({ error: "sign in with GitHub to index your repos" });
    }
    if (indexJobs.get(id.userId)?.status === "running") {
      return res.json({ status: "running" });
    }
    const running = [...indexJobs.values()].filter((j) => j.status === "running").length;
    if (running >= MAX_CONCURRENT_INDEX) {
      return res.status(429).json({ error: "The server is busy indexing for others. Try again in a few minutes." });
    }
    if (!allow(`index:${id.userId}`, INDEX_PER_HOUR, HOUR)) {
      return res.status(429).json({ error: "You've indexed a lot recently. Try again in an hour." });
    }

    const job: IndexJob = { status: "running", indexed: 0, message: "Starting..." };
    indexJobs.set(id.userId, job);
    const token = id.githubToken;
    mineUserRepos(token, {
      maxRepos: Number(process.env.MINE_MAX_REPOS ?? 15),
      maxIssuesPerRepo: Number(process.env.MINE_MAX_ISSUES ?? 30),
      onProgress: (m) => {
        job.message = m;
        console.log(`[index ${id.userId}]`, m);
      },
    })
      .then((count) => {
        job.status = "done";
        job.indexed = count;
        forgetRepoList(id.userId);
      })
      .catch((e) => {
        console.error(`[index ${id.userId}]`, e);
        job.status = "error";
        job.message = e.message ?? "indexing failed";
      });

    res.json({ status: "running" });
  } catch (e: any) {
    console.error("[index]", e);
    res.status(500).json({ error: e.message ?? "indexing failed" });
  }
});

app.get("/api/index/status", async (req, res) => {
  try {
    const id = await requireIdentity(req, res);
    if (!id) return;
    res.json(indexJobs.get(id.userId) ?? { status: "idle", indexed: 0, message: "" });
  } catch (e: any) {
    res.status(500).json({ error: e.message ?? "failed" });
  }
});

// --- CI keys ------------------------------------------------------------------
// Creates (or replaces) the key a repo's CI workflow uses to call
// /api/ci-failure. Shown once; only its hash is stored. Body: { repo }.
app.post("/api/ci-key", async (req, res) => {
  try {
    const id = await requireIdentity(req, res);
    if (!id) return;
    const repo = String(req.body?.repo ?? "");
    if (!REPO_RE.test(repo)) return res.status(400).json({ error: "open a repo page first" });
    if (id.demo) return res.status(400).json({ error: "sign in with GitHub to create CI keys" });
    const key = await createCiKey(id, repo);
    res.json({ repo, key });
  } catch (e: any) {
    res.status(403).json({ error: e.message ?? "could not create key" });
  }
});

// The chat endpoint. Body: { message, history }. Retrieval spans EVERY repo the
// user can access (that we have history for), not just one.
app.post("/api/chat", async (req, res) => {
  try {
    const id = await requireIdentity(req, res);
    if (!id) return;

    const { message } = req.body ?? {};
    if (typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "message is required" });
    }
    if (!allow(`chat:${id.userId}`, CHAT_PER_HOUR, HOUR)) {
      return res.status(429).json({ error: "You've sent a lot of messages. Please wait a bit and try again." });
    }
    const history = cleanHistory(req.body?.history);

    // The set of repos this user is allowed to see (already access-checked).
    const repos = await allowedReposFor(id);

    // Search with the previous question too, so follow-ups like "how did we fix
    // it?" still match the bug being discussed.
    const lastUser = [...history].reverse().find((t) => t.role === "user");
    const searchText = lastUser ? `${lastUser.content}\n${message}` : message;

    // Only keep past bugs above a similarity threshold, so greetings and small
    // talk don't drag in unrelated history.
    const allHits = repos.length ? await retrieve(searchText.slice(0, 8000), repos, 8) : [];
    const hitsAbove = allHits.filter((h) => h.score >= RELEVANCE).slice(0, 4);
    const reply = await answer(message.slice(0, 8000), hitsAbove, history);

    res.json({
      reply,
      sources: hitsAbove.map((h) => ({
        repo: h.record.repo,
        problem: h.record.problem,
        fix: h.record.fix,
        filesChanged: h.record.filesChanged,
        url: h.record.prUrl || h.record.issueUrl || h.record.commitUrl || null,
        score: Number(h.score.toFixed(3)),
      })),
    });
  } catch (e: any) {
    console.error("[chat]", e);
    res.status(500).json({ error: e.message ?? "chat failed" });
  }
});

// The CI-failure hook (Flow B). A GitHub Actions workflow POSTs the error log
// here on failure; we return similar past bugs, and the workflow posts them as a
// commit comment. Body: { repo, errorLog }. Header x-ci-secret: the repo's CI
// key (created from the panel), which only unlocks that one repo's history.
app.post("/api/ci-failure", async (req, res) => {
  try {
    const { repo, errorLog } = req.body ?? {};
    if (typeof repo !== "string" || typeof errorLog !== "string") {
      return res.status(400).json({ error: "repo and errorLog are required" });
    }
    if (!(await verifyCiKey(repo, req.header("x-ci-secret")))) {
      return res.status(401).json({ error: "bad or missing CI key for this repo" });
    }
    if (!allow(`ci:${repo}`, CI_PER_HOUR, HOUR)) {
      return res.status(429).json({ error: "too many CI lookups for this repo; try later" });
    }

    const log = errorLog.slice(-8000);
    const allHits = await retrieve(log, [repo], 5);
    const hitsAbove = allHits.filter((h) => h.score >= RELEVANCE).slice(0, 3);
    const reply = await answer(log, hitsAbove);

    res.json({
      reply,
      sources: hitsAbove.map((h) => ({
        problem: h.record.problem,
        url: h.record.prUrl || h.record.issueUrl || h.record.commitUrl || null,
      })),
    });
  } catch (e: any) {
    console.error("[ci-failure]", e);
    res.status(500).json({ error: e.message ?? "ci lookup failed" });
  }
});

loadSeedData()
  .then(() => {
    app.listen(PORT, () => console.log(`[server] listening on ${PUBLIC_URL} (port ${PORT})`));
  })
  .catch((e) => {
    console.error("[server] startup failed (is DATABASE_URL correct?)", e);
    process.exit(1);
  });
