// llm.ts
// -----------------------------------------------------------------------------
// Generates the reply. Uses a HOSTED API (Anthropic Claude or OpenAI) so the
// bot chats well; falls back to local Ollama if no API key is set.
//
// Config (in .env):
//   LLM_PROVIDER = anthropic | openai | ollama   (default: anthropic if a key
//                  is set, otherwise ollama)
//   LLM_API_KEY  = your provider key
//   LLM_MODEL    = model name (defaults per provider below)
//
// Embeddings stay local (see embed.ts) — only the chat answer uses the API.
// -----------------------------------------------------------------------------

import type { ChatTurn, RetrievalHit } from "./types.js";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_CHAT_MODEL || "llama3.1";
const API_KEY = process.env.LLM_API_KEY || "";
const PROVIDER =
  process.env.LLM_PROVIDER || (API_KEY ? "anthropic" : "ollama");

function buildContext(hits: RetrievalHit[]): string {
  return hits
    .map((h, i) => {
      const r = h.record;
      return [
        `Past bug ${i + 1} in ${r.repo} (similarity ${(h.score * 100).toFixed(0)}%):`,
        `  Problem: ${r.problem}`,
        r.rootCause ? `  Root cause: ${r.rootCause}` : "",
        `  Fix: ${r.fix}`,
        r.filesChanged.length ? `  Files: ${r.filesChanged.join(", ")}` : "",
        r.prUrl || r.issueUrl ? `  Link: ${r.prUrl || r.issueUrl}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

const SYSTEM = [
  "You are a friendly, sharp engineering assistant embedded in a developer's",
  "GitHub account. You help recall similar past bugs and their fixes across",
  "their repositories, and you can also just chat normally.",
  "",
  "Rules:",
  "- If the user is greeting you or making small talk, reply briefly and",
  "  naturally. Do NOT mention past bugs.",
  "- If the user describes an error or asks about a bug, use the past bugs",
  "  provided when relevant, name which repo each came from, and cite links.",
  "  If none fit, say so and offer general debugging help.",
  "- Be concise and practical.",
].join("\n");

function userPrompt(query: string, hits: RetrievalHit[]): string {
  return [
    `User message:\n${query}`,
    "",
    hits.length
      ? `Relevant past bugs from their repos:\n${buildContext(hits)}`
      : "Relevant past bugs from their repos: (none)",
  ].join("\n");
}

// Earlier turns first, then the new message (with retrieved bugs attached).
// The retrieved-bug context only goes on the latest message.
function conversation(
  query: string,
  hits: RetrievalHit[],
  history: ChatTurn[],
): ChatTurn[] {
  return [...history, { role: "user", content: userPrompt(query, hits) }];
}

async function callAnthropic(messages: ChatTurn[]): Promise<string> {
  const model = process.env.LLM_MODEL || "claude-3-5-sonnet-latest";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 700,
      system: SYSTEM,
      messages,
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API failed (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { content: { text: string }[] };
  return data.content.map((c) => c.text).join("").trim();
}

async function callOpenAI(messages: ChatTurn[]): Promise<string> {
  const model = process.env.LLM_MODEL || "gpt-4o-mini";
  const baseUrl = process.env.LLM_BASE_URL || "https://api.openai.com/v1";
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: SYSTEM }, ...messages],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI API failed (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  return data.choices[0].message.content.trim();
}

async function callOllama(messages: ChatTurn[]): Promise<string> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [{ role: "system", content: SYSTEM }, ...messages],
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`Ollama failed (${res.status}). Is it running?`);
  const data = (await res.json()) as { message: { content: string } };
  return data.message.content.trim();
}

export async function answer(
  query: string,
  hits: RetrievalHit[],
  history: ChatTurn[] = [],
): Promise<string> {
  const messages = conversation(query, hits, history);
  if (PROVIDER === "anthropic" && API_KEY) return callAnthropic(messages);
  if (PROVIDER === "openai" && API_KEY) return callOpenAI(messages);
  return callOllama(messages);
}
