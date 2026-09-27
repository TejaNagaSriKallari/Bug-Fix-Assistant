// embed.ts
// -----------------------------------------------------------------------------
// Turns text into a vector. Two providers:
//
//   gemini — Google's hosted embeddings (free tier). Used when deployed, since
//            free hosts can't run Ollama. Needs GEMINI_API_KEY.
//   ollama — local nomic-embed-text. No key, no cloud. Used for local dev.
//
// EMBED_PROVIDER picks one; default is gemini if GEMINI_API_KEY is set, else
// ollama. Both return 768-dim vectors, but they are NOT interchangeable: if you
// switch providers on an existing database, re-index so every vector comes from
// the same model.
// -----------------------------------------------------------------------------

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_EMBED_MODEL = process.env.GEMINI_EMBED_MODEL || "gemini-embedding-001";
const PROVIDER =
  process.env.EMBED_PROVIDER || (GEMINI_API_KEY ? "gemini" : "ollama");

export const EMBED_DIM = 768;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function embedOllama(text: string): Promise<number[]> {
  const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, prompt: text }),
  });
  if (!res.ok) {
    throw new Error(
      `Ollama embeddings failed (${res.status}). Is Ollama running and is "${OLLAMA_EMBED_MODEL}" pulled?`,
    );
  }
  const data = (await res.json()) as { embedding: number[] };
  return data.embedding;
}

// The free tier is rate-limited per minute, so indexing many issues can hit
// 429s. Back off and retry instead of failing the whole index run.
async function embedGemini(text: string): Promise<number[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBED_MODEL}:embedContent`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      body: JSON.stringify({
        content: { parts: [{ text: text.slice(0, 8000) }] },
        outputDimensionality: EMBED_DIM,
      }),
    });
    if (res.status === 429 && attempt < 5) {
      await sleep(Math.min(60_000, 2_000 * 2 ** attempt));
      continue;
    }
    if (!res.ok) {
      throw new Error(`Gemini embeddings failed (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as { embedding: { values: number[] } };
    return data.embedding.values;
  }
}

export async function embed(text: string): Promise<number[]> {
  const vec = PROVIDER === "gemini" ? await embedGemini(text) : await embedOllama(text);
  if (!vec || vec.length !== EMBED_DIM) {
    throw new Error(
      `Expected ${EMBED_DIM}-dim embedding from ${PROVIDER}, got ${vec?.length}. ` +
        `Update EMBED_DIM and the vector() column if you changed models.`,
    );
  }
  return vec;
}

// Format a JS number[] as a pgvector literal: [0.1,0.2,...]
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}
