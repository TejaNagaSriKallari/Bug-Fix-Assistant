// content.js — injects the chat panel into github.com and wires it up.
//
// It reads which repo you're viewing from the URL, sends your messages to the
// background worker, and renders replies. It holds no secrets.

(function () {
  // --- figure out the current repo from the URL: github.com/{owner}/{repo}/...
  function currentRepo() {
    const parts = location.pathname.split("/").filter(Boolean);
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
    return null;
  }

  // --- build the panel DOM once ---
  if (document.getElementById("bfa-root")) return;

  const root = document.createElement("div");
  root.id = "bfa-root";
  root.classList.add("bfa-collapsed");
  root.innerHTML = `
    <button id="bfa-toggle" title="Bug-Fix Assistant">🐛</button>
    <div id="bfa-panel">
      <div id="bfa-header">
        <span>Bug-Fix Assistant</span>
        <span id="bfa-repo"></span>
        <button id="bfa-newchat" title="Forget this conversation">New chat</button>
      </div>
      <div id="bfa-auth">
        <button id="bfa-signin">Sign in with GitHub</button>
        <span id="bfa-user"></span>
        <button id="bfa-index" title="Mine your repos into the knowledge base">Index my repos</button>
        <button id="bfa-cikey" title="Create the key this repo's CI workflow uses">CI key</button>
        <button id="bfa-signout" title="Sign out">Sign out</button>
      </div>
      <div id="bfa-messages"></div>
      <form id="bfa-form">
        <input id="bfa-input" type="text" autocomplete="off"
               placeholder="Ask about a past bug or paste an error..." />
        <button type="submit">Send</button>
      </form>
    </div>`;
  document.body.appendChild(root);

  const messagesEl = root.querySelector("#bfa-messages");
  const repoEl = root.querySelector("#bfa-repo");
  const form = root.querySelector("#bfa-form");
  const input = root.querySelector("#bfa-input");
  const signinBtn = root.querySelector("#bfa-signin");
  const signoutBtn = root.querySelector("#bfa-signout");
  const indexBtn = root.querySelector("#bfa-index");
  const ciKeyBtn = root.querySelector("#bfa-cikey");
  const userEl = root.querySelector("#bfa-user");

  let authed = false;

  // --- conversation memory ---
  // Past turns ({ role, content }) sent with each message so the bot can follow
  // up. Kept in sessionStorage so it survives page reloads in this tab.
  const HISTORY_KEY = "bfa-history";
  const MAX_TURNS = 10;
  let history = [];
  try {
    history = JSON.parse(sessionStorage.getItem(HISTORY_KEY) || "[]");
  } catch (e) {
    history = [];
  }
  function saveHistory() {
    history = history.slice(-MAX_TURNS);
    try {
      sessionStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch (e) {
      // storage unavailable — memory still works until reload
    }
  }

  function renderAuth(me) {
    authed = !!(me && me.authenticated);
    signinBtn.style.display = authed ? "none" : "inline-block";
    signoutBtn.style.display = authed ? "inline-block" : "none";
    indexBtn.style.display = authed && !me.demo ? "inline-block" : "none";
    ciKeyBtn.style.display = authed && !me.demo ? "inline-block" : "none";
    userEl.textContent = authed
      ? `Signed in as ${me.user}${me.demo ? " (demo)" : ""}`
      : "";
    form.style.opacity = authed ? "1" : "0.5";
    input.disabled = !authed;
  }

  // Indexing runs on the server in the background; poll until it finishes.
  indexBtn.addEventListener("click", () => {
    indexBtn.disabled = true;
    const progress = addMessage("Indexing your repos... this can take a few minutes.", "bot");
    chrome.runtime.sendMessage({ type: "index" }, (resp) => {
      if (!resp || resp.error) {
        indexBtn.disabled = false;
        return addMessage(`Index error: ${resp ? resp.error : "no response"}`, "bot");
      }
      const timer = setInterval(() => {
        chrome.runtime.sendMessage({ type: "indexStatus" }, (st) => {
          if (!st || st.error) return; // transient; keep polling
          if (st.status === "running") {
            progress.textContent = `Indexing your repos... ${st.message || ""}`;
            return;
          }
          clearInterval(timer);
          indexBtn.disabled = false;
          if (st.status === "error") return addMessage(`Index error: ${st.message}`, "bot");
          addMessage(
            `Indexed ${st.indexed} bug/fix record(s) from your repos. Ask me about a bug now!`,
            "bot",
          );
        });
      }, 3000);
    });
  });

  ciKeyBtn.addEventListener("click", () => {
    const repo = currentRepo();
    if (!repo) return addMessage("Open a repository page first, then click CI key.", "bot");
    chrome.runtime.sendMessage({ type: "ciKey", repo }, (resp) => {
      if (!resp || resp.error) {
        return addMessage(`CI key error: ${resp ? resp.error : "no response"}`, "bot");
      }
      addMessage(
        `CI key for ${resp.repo} (shown only once — creating a new one replaces it):

${resp.key}

` +
          "Add it in this repo under Settings → Secrets and variables → Actions as BUGFIX_CI_SECRET.",
        "bot",
      );
    });
  });

  function refreshAuth() {
    chrome.runtime.sendMessage({ type: "getMe" }, renderAuth);
  }
  refreshAuth();

  signinBtn.addEventListener("click", () => {
    userEl.textContent = "Opening GitHub...";
    chrome.runtime.sendMessage({ type: "signIn" }, (resp) => {
      if (resp && resp.error) {
        addMessage(resp.error, "bot");
        userEl.textContent = "";
        return;
      }
      addMessage(`Signed in as ${resp.login}. Ask away!`, "bot");
      refreshAuth();
    });
  });

  signoutBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "signOut" }, () => {
      addMessage("Signed out.", "bot");
      refreshAuth();
    });
  });

  function refreshRepo() {
    const repo = currentRepo();
    repoEl.textContent = repo ? repo : "(not a repo page)";
    return repo;
  }
  refreshRepo();

  root.querySelector("#bfa-toggle").addEventListener("click", () => {
    root.classList.toggle("bfa-collapsed");
    refreshRepo();
  });

  function addMessage(text, who) {
    const el = document.createElement("div");
    el.className = `bfa-msg bfa-${who}`;
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  function addSources(sources) {
    if (!sources || !sources.length) return;
    const wrap = document.createElement("div");
    wrap.className = "bfa-sources";
    for (const s of sources) {
      const item = document.createElement("div");
      item.className = "bfa-source";
      const link = s.url
        ? `<a href="${s.url}" target="_blank" rel="noreferrer">reference</a>`
        : "";
      item.innerHTML =
        (s.repo ? `<div class="bfa-files">${escapeHtml(s.repo)}</div>` : "") +
        `<strong>${escapeHtml(s.problem)}</strong>` +
        `<div>Fix: ${escapeHtml(s.fix)}</div>` +
        `<div class="bfa-files">${escapeHtml((s.filesChanged || []).join(", "))}</div>` +
        link;
      wrap.appendChild(item);
    }
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
    );
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!authed) {
      addMessage("Please sign in with GitHub first.", "bot");
      return;
    }
    const message = input.value.trim();
    if (!message) return;
    addMessage(message, "user");
    input.value = "";
    const pending = addMessage("Thinking...", "bot");

    chrome.runtime.sendMessage({ type: "chat", message, history }, (resp) => {
      pending.remove();
      if (!resp) {
        addMessage("No response from the backend. Is it running on :8787?", "bot");
        return;
      }
      if (resp.error) {
        addMessage(`Error: ${resp.error}`, "bot");
        return;
      }
      addMessage(resp.reply, "bot");
      addSources(resp.sources);
      // Only remember turns that got a real answer.
      history.push({ role: "user", content: message }, { role: "assistant", content: resp.reply });
      saveHistory();
    });
  });

  const GREETING =
    "Hi! Ask me things like \"have we seen a JWT expired error before?\" while viewing a repo.";

  function startConversation() {
    messagesEl.innerHTML = "";
    addMessage(GREETING, "bot");
    for (const turn of history) {
      addMessage(turn.content, turn.role === "user" ? "user" : "bot");
    }
  }
  startConversation();

  root.querySelector("#bfa-newchat").addEventListener("click", () => {
    history = [];
    saveHistory();
    startConversation();
  });
})();