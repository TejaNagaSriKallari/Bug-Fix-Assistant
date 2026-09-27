// auth.ts
// -----------------------------------------------------------------------------
// Identity + per-repo authorization for ANY GitHub user.
//
// How it works (no hardcoded user list):
//   1. The user signs in with GitHub OAuth (tab-based, see server.ts).
//   2. The backend exchanges the code for the user's GitHub token and stores it
//      server-side (encrypted, in Postgres), handing the extension a random
//      SESSION TOKEN. Only a hash of that session token is stored.
//   3. On each request, we look up the session, and decide access from the
//      user's real GitHub repo list. So access == real GitHub permissions.
//
// A `demo:<login>` path is kept (gated by ALLOW_DEMO_AUTH, default on) so the
// offline demo still runs without setting up an OAuth App. Turn it off when
// deployed.
//
// SESSION_SECRET encrypts stored GitHub tokens. Set it to a long random string
// in production; without it a random key is used and every restart signs
// everyone out.
// -----------------------------------------------------------------------------

import crypto from "node:crypto";
import {
  exchangeCodeForToken,
  getLogin,
  listAccessibleRepos,
  userCanPushRepo,
  userCanReadRepo,
} from "./github.js";
import { distinctRepos } from "./store.js";
import { pool } from "./db.js";

export interface Identity {
  userId: string;
  githubToken?: string; // present for real sessions, absent for demo
  demo?: boolean;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// --- demo fallback (offline, no OAuth App needed) ------------------------------
const ALLOW_DEMO = (process.env.ALLOW_DEMO_AUTH ?? "true") === "true";
const DEMO_ACCESS: Record<string, string[]> = {
  alice: ["acme/payments", "acme/web"],
  bob: ["bob/side-project"],
};

// --- crypto helpers ------------------------------------------------------------
if (!process.env.SESSION_SECRET) {
  console.warn(
    "[auth] SESSION_SECRET not set: using a random key, so sign-ins won't survive a restart.",
  );
}
const ENC_KEY = crypto
  .createHash("sha256")
  .update(process.env.SESSION_SECRET || crypto.randomBytes(32))
  .digest();

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENC_KEY, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}

function decrypt(blob: string): string | null {
  try {
    const [iv, tag, data] = blob.split(".").map((p) => Buffer.from(p, "base64"));
    const decipher = crypto.createDecipheriv("aes-256-gcm", ENC_KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return null; // key changed (e.g. SESSION_SECRET rotated) -> treat as signed out
  }
}

// --- sessions --------------------------------------------------------------------
// Small in-memory cache in front of the sessions table.
const sessionCache = new Map<string, { userId: string; githubToken: string; exp: number }>();

export async function createSessionFromCode(
  code: string,
): Promise<{ sessionToken: string; login: string }> {
  const githubToken = await exchangeCodeForToken(code);
  const login = await getLogin(githubToken);
  const sessionToken = crypto.randomBytes(32).toString("hex");
  const exp = Date.now() + SESSION_TTL_MS;
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, github_token, expires_at)
     VALUES ($1, $2, $3, to_timestamp($4 / 1000.0))`,
    [sha256(sessionToken), login, encrypt(githubToken), exp],
  );
  sessionCache.set(sha256(sessionToken), { userId: login, githubToken, exp });
  return { sessionToken, login };
}

export async function endSession(sessionToken: string): Promise<void> {
  const hash = sha256(sessionToken);
  sessionCache.delete(hash);
  await pool.query(`DELETE FROM sessions WHERE token_hash = $1`, [hash]);
}

// --- tab-based sign-in: link handshake ----------------------------------------
// The extension opens a normal tab, GitHub redirects to /auth/callback, and the
// extension polls /auth/poll to pick up the finished session. This avoids the
// embedded-webview window that GitHub refuses to authorize.
interface PendingLink {
  sessionToken?: string;
  login?: string;
  createdAt: number;
}
const pendingLinks = new Map<string, PendingLink>();
const LINK_TTL_MS = 10 * 60 * 1000;

function prunePendingLinks(): void {
  const cutoff = Date.now() - LINK_TTL_MS;
  for (const [id, link] of pendingLinks) {
    if (link.createdAt < cutoff) pendingLinks.delete(id);
  }
}

export function startLink(linkId: string): void {
  prunePendingLinks();
  pendingLinks.set(linkId, { createdAt: Date.now() });
}

export async function completeLink(linkId: string, code: string): Promise<void> {
  const { sessionToken, login } = await createSessionFromCode(code);
  pendingLinks.set(linkId, { sessionToken, login, createdAt: Date.now() });
}

// One-time read: returns the session once ready, then forgets the link.
export function pollLink(
  linkId: string,
): { sessionToken: string; login: string } | null {
  const link = pendingLinks.get(linkId);
  if (link?.sessionToken && link.login) {
    pendingLinks.delete(linkId);
    return { sessionToken: link.sessionToken, login: link.login };
  }
  return null;
}

// --- identity from the Authorization header -----------------------------------
export async function identify(authHeader: string | undefined): Promise<Identity | null> {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/);
  if (!m) return null;
  const token = m[1].trim();

  if (token.startsWith("demo:")) {
    if (!ALLOW_DEMO) return null;
    return { userId: token.slice(5), demo: true };
  }

  const hash = sha256(token);
  const now = Date.now();
  const cached = sessionCache.get(hash);
  if (cached && cached.exp > now) {
    return { userId: cached.userId, githubToken: cached.githubToken };
  }

  const { rows } = await pool.query(
    `SELECT user_id, github_token, extract(epoch FROM expires_at) * 1000 AS exp
       FROM sessions WHERE token_hash = $1 AND expires_at > now()`,
    [hash],
  );
  if (!rows.length) return null;
  const githubToken = decrypt(rows[0].github_token);
  if (!githubToken) return null;
  const s = { userId: rows[0].user_id as string, githubToken, exp: Number(rows[0].exp) };
  sessionCache.set(hash, s);
  return { userId: s.userId, githubToken };
}

// --- authorization -------------------------------------------------------------
// Short-lived cache so we don't hit GitHub on every request.
const accessCache = new Map<string, { ok: boolean; exp: number }>();
const ACCESS_TTL_MS = 60_000;

export async function canAccessRepo(
  id: Identity,
  repo: string,
): Promise<boolean> {
  if (id.demo) return (DEMO_ACCESS[id.userId] ?? []).includes(repo);
  if (!id.githubToken) return false;

  const key = `${id.userId}:${repo}`;
  const now = Date.now();
  const cached = accessCache.get(key);
  if (cached && cached.exp > now) return cached.ok;

  const ok = await userCanReadRepo(id.githubToken, repo);
  accessCache.set(key, { ok, exp: now + ACCESS_TTL_MS });
  return ok;
}

// The user's own repo list from GitHub (owner/collaborator/org member), cached.
// One list call per user every few minutes, instead of one access check per
// repo in the database — that would grow with every user who indexes.
const repoListCache = new Map<string, { repos: Set<string>; exp: number }>();
const REPO_LIST_TTL_MS = 10 * 60_000;

async function userRepoSet(id: Identity): Promise<Set<string>> {
  const now = Date.now();
  const cached = repoListCache.get(id.userId);
  if (cached && cached.exp > now) return cached.repos;
  const repos = new Set(
    (await listAccessibleRepos(id.githubToken!, 500)).map((r) => r.fullName),
  );
  repoListCache.set(id.userId, { repos, exp: now + REPO_LIST_TTL_MS });
  return repos;
}

// Called after indexing so newly indexed repos show up right away.
export function forgetRepoList(userId: string): void {
  repoListCache.delete(userId);
}

// Repos this user can see AND that we have history for.
export async function allowedReposFor(id: Identity): Promise<string[]> {
  if (id.demo) return DEMO_ACCESS[id.userId] ?? [];
  if (!id.githubToken) return [];

  const mine = await userRepoSet(id);
  const known = await distinctRepos(); // repos that exist in our knowledge base
  return known.filter((repo) => mine.has(repo));
}

// --- per-repo CI keys ------------------------------------------------------------
// The CI-failure hook authenticates with a key tied to ONE repo, so a key can
// only ever read that repo's history. Creating a key requires push access.
export async function createCiKey(id: Identity, repo: string): Promise<string> {
  if (!id.githubToken || !(await userCanPushRepo(id.githubToken, repo))) {
    throw new Error(`you need push access to ${repo} to create its CI key`);
  }
  const key = `bfa_${crypto.randomBytes(24).toString("hex")}`;
  await pool.query(
    `INSERT INTO ci_keys (repo, key_hash, created_by) VALUES ($1, $2, $3)
     ON CONFLICT (repo) DO UPDATE SET key_hash = $2, created_by = $3, created_at = now()`,
    [repo, sha256(key), id.userId],
  );
  return key;
}

export async function verifyCiKey(repo: string, key: string | undefined): Promise<boolean> {
  if (!key) return false;
  const { rows } = await pool.query(`SELECT key_hash FROM ci_keys WHERE repo = $1`, [repo]);
  if (!rows.length) return false;
  const a = Buffer.from(rows[0].key_hash, "hex");
  const b = Buffer.from(sha256(key), "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
