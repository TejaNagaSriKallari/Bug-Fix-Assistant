# GitHub Bug-Fix Assistant

A RAG assistant that surfaces similar past bugs and their fixes for a GitHub
repo. Two front doors, one knowledge base:

- **Chat panel** — a Chrome extension that injects a ChatGPT-like panel onto
  `github.com` so you never leave the page.
- **CI failure hook** — a backend endpoint a GitHub Action can POST an error
  log to (so the bot can later comment on the PR).

## Stack (fully local, private, no cloud cost)

- **LLM + embeddings:** [Ollama](https://ollama.com) running `llama3.1` (answers)
  and `nomic-embed-text` (768-dim vectors).
- **Vector store:** Postgres + [pgvector](https://github.com/pgvector/pgvector).
- **Backend:** TypeScript / Express.
- **Client:** Chrome MV3 extension.

## Sign-in & multi-user isolation (works for everyone)

Any GitHub user signs in with their own account. Access is decided by their
**real GitHub permissions**, not a hardcoded list:

1. The extension runs GitHub OAuth (`chrome.identity`) and sends the code to the
   backend. The backend exchanges it for the user's GitHub token, stores that
   token **server-side**, and returns a random **session token** — the only
   thing the extension holds. The GitHub token and OAuth secret never reach the
   browser.
2. `canAccessRepo()` (`src/auth.ts`) asks GitHub whether *this user* can read
   *this repo* (`GET /repos/{owner}/{repo}` → 200 = yes). Cached for 60s.
3. `retrieve(query, [repo])` (`src/store.ts`) scopes the SQL search with
   `WHERE repo = ANY(...)`; there is no query that spans all repos.

So User A never sees User B's history — the database only ever returns rows for
a repo the caller's own GitHub account can read.

The offline `demo:alice` / `demo:bob` logins still work (set
`ALLOW_DEMO_AUTH=false` to turn them off). For a more locked-down setup, swap
the OAuth App for a **GitHub App** (per-repo install, narrower token) — same
code shape, see the note in `src/github.ts`.

## Prerequisites (install once)

**1. Ollama** — download from https://ollama.com/download, then pull the models:

```bash
ollama pull llama3.1
ollama pull nomic-embed-text
```

Ollama serves on `http://localhost:11434` automatically.

**2. Postgres with pgvector** — easiest via Docker:

```bash
docker run -d --name bugfix-pg -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=bugfix \
  pgvector/pgvector:pg16
```

(Or install pgvector into an existing Postgres and create a `bugfix` database.)

## Run the backend

Requires Node 18+.

```bash
cd backend
cp .env.example .env      # optional — defaults already match the setup above
npm install
npm run dev               # starts http://localhost:8787
```

On boot it creates the `vector` extension + table and seeds `data/seed.json`.

Smoke-test it:

```bash
# repos alice can see
curl -s http://localhost:8787/api/repos -H "authorization: Bearer demo:alice"

# alice asks about a known bug in a repo she CAN access -> LLM answer + sources
curl -s http://localhost:8787/api/chat \
  -H "authorization: Bearer demo:alice" -H "content-type: application/json" \
  -d '{"repo":"acme/payments","message":"login crashes, JWT expired"}'

# alice asking about BOB's repo -> 403 (isolation working)
curl -s http://localhost:8787/api/chat \
  -H "authorization: Bearer demo:alice" -H "content-type: application/json" \
  -d '{"repo":"bob/side-project","message":"env missing"}'
```

## Load the extension

1. Start the backend (above).
2. Open `chrome://extensions`, turn on **Developer mode**.
3. Click **Load unpacked** and choose the `extension/` folder.
4. Note the extension's **ID** shown on that page.

## Enable GitHub sign-in (for real users)

1. Create a GitHub OAuth App at https://github.com/settings/developers →
   **New OAuth App**.
   - Homepage URL: anything (e.g. `http://localhost:8787`).
   - **Authorization callback URL:**
  `http://localhost:8787/auth/callback`
  (or `${PUBLIC_URL}/auth/callback` if `PUBLIC_URL` is set).
2. Put the client id/secret in `backend/.env`:
   ```
   GITHUB_CLIENT_ID=...
   GITHUB_CLIENT_SECRET=...
   ```
   and restart the backend.
3. On a `github.com` page, open the 🐛 panel → **Sign in with GitHub**. After
   sign-in you can only get answers for repos your GitHub account can read.

**No OAuth App yet?** The offline demo still works: in the extension's
service-worker console run `chrome.storage.local.set({ demoUser: "alice" })`
(or `"bob"`), then ask on `github.com/acme/payments`.

## Files

```
backend/
  src/embed.ts    text -> vector via Ollama (nomic-embed-text)
  src/db.ts       Postgres pool + pgvector schema
  src/store.ts    scoped vector retrieval (WHERE repo = ANY(...))
  src/auth.ts     identity + per-repo authorization (isolation)
  src/llm.ts      retrieved records -> answer via Ollama (llama3.1)
  src/server.ts   /api/chat, /api/ci-failure, /api/repos
  scripts/mine.ts turn repo history into bug->fix records
  data/seed.json  demo knowledge base
extension/        Chrome MV3 extension (panel on github.com)
```

## What's still a stub (the last mile to production)

The LLM, embedder, and vector store are now real. Two things remain:

1. **Mining** (`scripts/mine.ts`): implement `mineReal()` with Octokit —
   list closed issues linked to merged PRs, pull the diffs, `upsert()` each as
   a record. This is what fills the knowledge base with YOUR repo's history.
   `npm i octokit` then follow the commented sketch.
2. **Real GitHub auth** (`src/auth.ts`): swap the demo user map for GitHub
   OAuth (identity) + GitHub App installation tokens (per-repo access check),
   and verify the CI webhook signature in `/api/ci-failure` before posting the
   reply back as a PR comment.
```