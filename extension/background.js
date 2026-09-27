// background.js — the extension service worker.
//
// Owns talking to the backend AND the GitHub sign-in flow. After sign-in it
// holds only a SESSION TOKEN for our backend — never the GitHub token, which
// stays server-side.

// Your deployed backend. For local development use "http://localhost:8787"
// (and add it to host_permissions in manifest.json).
const BACKEND = "https://YOUR-APP.onrender.com";

async function getSessionToken() {
  const { sessionToken } = await chrome.storage.local.get("sessionToken");
  return sessionToken || null;
}

// Build the Authorization header. Prefers a real session; falls back to the
// demo user if one was set and no session exists (offline demo).
async function getAuthHeader() {
  const token = await getSessionToken();
  if (token) return `Bearer ${token}`;
  const { demoUser } = await chrome.storage.local.get("demoUser");
  return demoUser ? `Bearer demo:${demoUser}` : null;
}

// --- GitHub OAuth sign-in via a normal browser tab --------------------------
// GitHub refuses to authorize inside an embedded webview, so we open a real tab
// (BACKEND/auth/start), let GitHub redirect to the backend, and poll for the
// finished session.
async function signIn() {
  const linkId = crypto.randomUUID();
  await chrome.tabs.create({ url: `${BACKEND}/auth/start?link=${encodeURIComponent(linkId)}` });

  const deadline = Date.now() + 120000; // give the user 2 minutes
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const res = await fetch(`${BACKEND}/auth/poll?link=${encodeURIComponent(linkId)}`);
      const data = await res.json();
      if (data.sessionToken) {
        await chrome.storage.local.set({ sessionToken: data.sessionToken, login: data.login });
        return { login: data.login };
      }
    } catch (e) {
      // backend not up yet / transient — keep polling
    }
  }
  return { error: "Sign-in timed out. Try again." };
}

async function getMe() {
  const auth = await getAuthHeader();
  if (!auth) return { authenticated: false };
  const res = await fetch(`${BACKEND}/auth/me`, { headers: { authorization: auth } });
  if (!res.ok) return { authenticated: false };
  const data = await res.json();
  return { authenticated: true, user: data.user, demo: data.demo };
}

async function signOut() {
  const auth = await getAuthHeader();
  if (auth) await fetch(`${BACKEND}/auth/logout`, { method: "POST", headers: { authorization: auth } }).catch(() => {});
  await chrome.storage.local.remove(["sessionToken", "login"]);
  return { ok: true };
}

async function chat(message, history) {
  const auth = await getAuthHeader();
  if (!auth) return { error: "Please sign in first." };
  const res = await fetch(`${BACKEND}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify({ message, history }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { error: err.error || `request failed (${res.status})` };
  }
  return res.json();
}

// Start mining the signed-in user's repos. Runs in the background on the
// server; the panel polls indexStatus() for progress.
async function indexRepos() {
  const auth = await getAuthHeader();
  if (!auth) return { error: "Please sign in first." };
  const res = await fetch(`${BACKEND}/api/index`, {
    method: "POST",
    headers: { authorization: auth },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { error: data.error || `request failed (${res.status})` };
  return data; // { status: "running" }
}

async function indexStatus() {
  const auth = await getAuthHeader();
  if (!auth) return { error: "Please sign in first." };
  const res = await fetch(`${BACKEND}/api/index/status`, { headers: { authorization: auth } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { error: data.error || `request failed (${res.status})` };
  return data; // { status, indexed, message }
}

// Create (or replace) the CI key for a repo, used by its CI workflow.
async function createCiKey(repo) {
  const auth = await getAuthHeader();
  if (!auth) return { error: "Please sign in first." };
  const res = await fetch(`${BACKEND}/api/ci-key`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify({ repo }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { error: data.error || `request failed (${res.status})` };
  return data; // { repo, key }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const routes = {
    chat: () => chat(msg.message, msg.history || []),
    index: () => indexRepos(),
    indexStatus: () => indexStatus(),
    ciKey: () => createCiKey(msg.repo),
    signIn: () => signIn(),
    signOut: () => signOut(),
    getMe: () => getMe(),
  };
  const handler = routes[msg.type];
  if (!handler) return false;
  // fetch() throws (not just !res.ok) when the backend is down or restarting;
  // report it to the panel instead of leaving an uncaught error.
  handler()
    .then(sendResponse)
    .catch((e) =>
      sendResponse({ error: `Can't reach the server (${e.message}). If it was idle it may be waking up — try again in a minute.` }),
    );
  return true; // async
});