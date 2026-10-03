# GitHub Bug-Fix Assistant

**"Have we seen this error before?"** — a chat panel on github.com that finds
similar past bugs in your repositories and shows how they were fixed.

[**➜ Get it from the Microsoft Edge Add-ons store**](https://microsoftedge.microsoft.com/addons/detail/github-bugfix-assistant/djhdhmmlcmbebammjpdbcnmgejihdkae)

It learns from your repos' history: every closed issue that was fixed by a
linked pull request or commit becomes a searchable *problem → fix* record. Ask
about an error and it answers with the matching past fixes, with links to the
issue and the fix.

Two ways to use it, one knowledge base:

- **Chat panel** — a 🐛 button on every github.com page opens a chat. Paste an
  error or describe a bug.
- **CI hook** — when a GitHub Actions build fails, the error log is sent to the
  assistant and it comments on the commit with similar past fixes.

---

## For users

### Install

Install from the [Edge Add-ons store](https://microsoftedge.microsoft.com/addons/detail/github-bugfix-assistant/djhdhmmlcmbebammjpdbcnmgejihdkae) and click **Get**.

Using Chrome? Download this repo, open `chrome://extensions`, turn on
**Developer mode**, click **Load unpacked** and choose the `extension` folder.

### Use it

1. Open any page on github.com and click the 🐛 button (bottom right).
2. Click **Sign in with GitHub** and approve access in the tab that opens.
3. Click **Index my repos**. The assistant reads your repositories' closed
   issues and the pull requests/commits that fixed them. This can take a few
   minutes; the panel shows progress.
4. Ask something like *"TypeError: Cannot read properties of undefined (reading
   'name')"* or *"have we had a JWT expired bug before?"*.

The chat remembers the conversation, so follow-ups such as *"which files changed
in that fix?"* work. **New chat** starts over.

> The server runs on a free plan and sleeps when idle. The first request after a
> while can take up to a minute — that's normal.

### What gets indexed

A closed issue is stored only if GitHub links it to the PR or commit that fixed
it — for example a PR description or commit message containing `fixes #12`, or
a PR linked from the issue's sidebar. Fixes with no issue, and issues closed
without a linked fix, are skipped. Indexing is a snapshot: click **Index my
repos** again to pick up new fixes. Per run it scans up to 15 of your most
recently updated repos and 30 closed issues each.

If you see "Indexed 0 records", your repos don't have closed issues linked to
fixes yet.

### Comments on failed CI runs (optional)

1. Open the repo on github.com, open the 🐛 panel and click **CI key**. You need
   push access to the repo. Copy the key — it's shown once.
2. In the repo go to **Settings → Secrets and variables → Actions** and add:
   - `BUGFIX_CI_SECRET` — the key from step 1
   - `BUGFIX_BACKEND_URL` — `https://bug-fix-assistant.onrender.com`
3. Copy [`ci-workflow-template.yml`](ci-workflow-template.yml) into the repo as
   `.github/workflows/bugfix.yml` and replace the `npm ci` / `npm test` lines
   with your real build and test commands.

When the build fails, a **🐛 Bug-Fix Assistant** comment appears on the commit.
CI only catches what your build or tests detect, so the repo needs tests or a
build step that fails on the error. Clicking **CI key** again replaces the old
key.

### Privacy

See [PRIVACY.md](PRIVACY.md). In short: the assistant only reads your repos and
never writes to them; your GitHub token is stored encrypted on the server; a
repo's history is shown only to people GitHub says can access that repo; chat
messages aren't stored on the server. Revoke access any time at GitHub →
Settings → Applications.

---

## How it works

```
github.com page ──► extension (panel) ──► backend (Express, on Render)
                                             │
                    ┌────────────────────────┼────────────────────────┐
                    ▼                        ▼                        ▼
            GitHub API              Postgres + pgvector         LLM (Groq)
       (sign-in, repo access,       (bug→fix records +       writes the reply
        issues, PRs, commits)        their embeddings)       from the matches
```

1. **Indexing** (`scripts/mine.ts`): for each repo the user can access, list
   closed issues, find the PR or commit that closed each one, and store
   *problem* (issue title + text) and *fix* (PR/commit description + files
   changed). The problem text is turned into a 768-number vector (an
   embedding) so similar errors can be found even when worded differently.
2. **Chat** (`/api/chat`): embed the question (plus the previous question, for
   follow-ups), find the closest past bugs above a similarity threshold, and
   have the LLM write an answer citing them.
3. **CI** (`/api/ci-failure`): the same lookup for an error log, scoped to the
   one repo whose CI key was sent.

### Security model

- **Sign-in:** GitHub OAuth. The extension opens a normal tab to
  `/auth/start`; GitHub redirects back to `/auth/callback`; the extension polls
  `/auth/poll` to pick up a random session token. The extension only ever holds
  that session token — never the GitHub token or the OAuth secret.
- **Sessions:** stored in Postgres as a hash of the session token, with the
  GitHub token encrypted (AES-256-GCM, key from `SESSION_SECRET`). They last 30
  days and survive server restarts.
- **Isolation:** a user only searches repos in their own GitHub repo list
  (owner, collaborator or org member, refreshed every 10 minutes), enforced in
  SQL with `WHERE repo = ANY(...)`. There is no query across all repos.
- **CI keys:** one random key per repo, stored hashed. Creating one requires
  push access, and a key only unlocks its own repo's history.
- **Limits:** per user, 40 chats/hour and 3 index runs/hour; per repo, 20 CI
  lookups/hour; at most 2 index runs at once. These protect the free API quotas
  everyone shares.
- **CORS:** browsers may call the API only from extension origins.

---

## For developers

### Project layout

```
backend/
  src/server.ts    HTTP API: auth, /api/chat, /api/index, /api/ci-key,
                   /api/ci-failure, /privacy, /health
  src/auth.ts      sessions, repo access, CI keys
  src/github.ts    GitHub API calls (OAuth, repo lists, issues, PRs, commits)
  src/store.ts     upsert + scoped vector search
  src/db.ts        Postgres pool + schema (records, sessions, ci_keys)
  src/embed.ts     text -> vector (Gemini or local Ollama)
  src/llm.ts       matches + conversation -> reply (Groq/OpenAI-compatible,
                   Anthropic, or Ollama)
  scripts/mine.ts  indexing (also runnable from the CLI)
  data/seed.json   demo records for the offline demo users
extension/         Manifest V3 extension (Edge / Chrome)
ci-workflow-template.yml   GitHub Actions workflow for the CI hook
```

### Run locally

Needs Node 20+, Docker, and [Ollama](https://ollama.com/download).

1. **Database:**
   ```bash
   docker run -d --name bugfix-pg -p 5432:5432 \
     -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=bugfix \
     pgvector/pgvector:pg16
   ```
2. **Embeddings model:** `ollama pull nomic-embed-text`
3. **Backend:**
   ```bash
   cd backend
   cp .env.example .env    # then fill in the keys (see below)
   npm install
   npm run dev             # http://localhost:8787
   ```
   On start it creates the tables and, while demo logins are on, loads the demo
   records.
4. **Extension:** in `extension/background.js` set
   `BACKEND = "http://localhost:8787"`, and add `"http://localhost:8787/*"` to
   `host_permissions` in `extension/manifest.json`. Then load the `extension`
   folder with **Load unpacked**. (Don't publish those local changes.)
5. **GitHub sign-in:** create an OAuth App at
   <https://github.com/settings/developers> with callback URL
   `http://localhost:8787/auth/callback`, and put its client ID and secret in
   `.env`.

Without an OAuth App you can use the demo users: in the extension's service
worker console run `chrome.storage.local.set({ demoUser: "alice" })`, then ask
*"payment.id is undefined"*. From the command line:

```bash
curl -s http://localhost:8787/api/chat \
  -H "authorization: Bearer demo:alice" -H "content-type: application/json" \
  -d '{"message":"payment fails, payment.id is undefined"}'
```

### Configuration

Set in `backend/.env` locally, or as environment variables on the host.

| Variable | Needed | What it is |
|---|---|---|
| `DATABASE_URL` | yes | Postgres with pgvector |
| `LLM_PROVIDER`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | yes | Chat model. For Groq: `openai`, `https://api.groq.com/openai/v1`, your key, `openai/gpt-oss-120b` |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | yes | GitHub OAuth App |
| `PUBLIC_URL` | deployed | The server's public URL; the OAuth callback is `${PUBLIC_URL}/auth/callback` |
| `SESSION_SECRET` | deployed | Long random string. Without it, sign-ins reset on every restart |
| `GEMINI_API_KEY`, `EMBED_PROVIDER` | deployed | `gemini` for hosted embeddings; defaults to local Ollama when no Gemini key is set |
| `ALLOW_DEMO_AUTH` | — | `true` (default) enables `demo:alice` / `demo:bob`. Set `false` when deployed |
| `GITHUB_OAUTH_SCOPE` | — | Default `repo read:user`. `public_repo read:user` limits it to public repos |
| `CHAT_LIMIT_PER_HOUR`, `INDEX_LIMIT_PER_HOUR`, `CI_LIMIT_PER_HOUR` | — | Rate limits (40 / 3 / 20) |
| `MINE_MAX_REPOS`, `MINE_MAX_ISSUES` | — | Indexing caps (15 / 30) |
| `RELEVANCE_THRESHOLD` | — | Minimum similarity for a past bug to be shown (0.6) |

Gemini and Ollama vectors are not interchangeable. If you switch embedding
providers on an existing database, re-index.

### Deployment (free tiers)

The live version runs entirely on free plans:

- **Backend:** [Render](https://render.com) web service — root directory
  `backend`, build `npm install`, start `npm start`, health check `/health`.
  Free services sleep after 15 minutes idle.
- **Database:** [Neon](https://neon.tech) Postgres (pgvector is created
  automatically on first start).
- **Embeddings:** Google Gemini API (`gemini-embedding-001`, 768 dimensions).
- **Chat:** Groq.
- **Extension:** Microsoft Edge Add-ons store (free to publish).

Set the variables from the table above on Render, with `ALLOW_DEMO_AUTH=false`,
and create a separate OAuth App whose callback is
`https://<your-app>.onrender.com/auth/callback`. Point `BACKEND` in
`extension/background.js` and `host_permissions` in `extension/manifest.json`
at your Render URL.

To publish an extension update, bump `version` in `manifest.json`, zip the
**contents** of `extension/` (with `manifest.json` at the top of the zip), and
upload it under **Packages** in Partner Center.

### Known limitations

- Sign-in uses an OAuth App, which asks GitHub for the broad `repo` scope
  (read and write) even though the assistant only reads. A GitHub App with
  read-only permissions would be narrower.
- Indexing runs inside the web server process and its progress is kept in
  memory; a restart mid-run loses that run's progress (records already stored
  are kept).
- Rate limits are in memory, which is fine for a single server instance.
