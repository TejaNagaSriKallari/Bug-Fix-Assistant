// types.ts — shared shapes for the knowledge base.

// One mined bug->fix record. This is what the mining step produces and what
// the retriever searches over.
export interface BugFixRecord {
  id: string;
  // Which repo/installation this belongs to. THE isolation key: every query is
  // filtered on this so one user can never see another repo's history.
  repo: string; // e.g. "acme/payments"
  installationId: string; // GitHub App installation that owns this repo

  problem: string; // human description of the symptom (from the issue)
  error?: string; // the error text / stack trace, if known
  rootCause?: string;
  fix: string; // what actually fixed it
  filesChanged: string[];
  issueUrl?: string;
  prUrl?: string;
  commitUrl?: string;

  // Precomputed embedding of (problem + error). Filled in at load time.
  embedding?: number[];
}

// One earlier message in the chat, sent back by the panel so the LLM can
// follow the conversation.
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

// A retrieval hit returned to the caller.
export interface RetrievalHit {
  record: BugFixRecord;
  score: number;
}