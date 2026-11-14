# Memnora

Memnora is a web-aware chat agent that remembers useful context across conversations, knows when information may have changed, and can re-check an earlier answer against fresh sources.

> **Search live. Remember what matters.**

The project deliberately gives the agent **one tool: web search**. Memory is not another tool the model chooses to call; it is a small, deterministic context layer that runs around the agent loop. This keeps the architecture fast, testable, and easy to explain.

## What makes the memory layer different

Most chat demos either paste the full transcript into every prompt or store an unstructured summary. Memnora instead treats memory as a lifecycle:

```text
Completed exchange
      ↓
Durable ingestion queue
      ↓
Relevance gate ─────────────→ reject noise and failed answers
      ↓
Small dated note + structured candidate
      ↓
Candidate resolution ───────→ deduplicate / supersede / reject
      ↓
SQLite + FTS5
      ↓
Retrieve only a few relevant notes for the next answer
```

### Implemented today

- **Compact dated notes:** finished exchanges become small memories containing a topic, claim, sources, original search query, timestamp, and volatility.
- **Cross-chat recall:** a new conversation can retrieve useful notes from earlier conversations without copying the full history into the prompt.
- **Durable asynchronous ingestion:** extraction jobs survive restarts, retry safely, and do not delay the visible answer stream.
- **Relevance gating:** greetings, low-information exchanges, and assistant failure messages are not promoted into long-term memory.
- **Candidate resolution:** exact and near-duplicate findings are consolidated; newer preferences, decisions, and plans can supersede older ones while preserving revision history.
- **Layered retrieval:** date resolution and date filtering run before FTS5 full-text search. Porter stemming and weak-term filtering improve lexical matching while reducing accidental recall.
- **Volatility-aware re-checks:** changeable facts retain their original query and a structured snapshot, allowing Memnora to search again and explain what changed.
- **Explicit forgetting:** memory can be inspected and forgotten by exact ID. Tombstones prevent a forgotten item from being silently recreated by a queued job.
- **Scoped deletion:** deleting a chat removes that conversation and its derived notes without erasing unrelated history.
- **Inspectable personalization:** answer length, tone, structure, technical depth, source display, and recommendation style are stored separately from factual memory and remain reversible.
- **JSON fallback:** SQLite is the primary store, while the original JSON message store remains available if SQLite cannot start.
- **Bring your own model:** developers select Anthropic or OpenAI and provide their own model and Tavily keys through the local, gitignored `.env` file. Fast/main model IDs can be overridden without changing the agent loop, and credentials never enter browser storage, chat requests, SQLite, or long-term memory.

The SQLite schema indexes both dates and conversations, keeps complete message history for chat reloads, and stores compact notes for model context. FTS5 retrieves only the top few notes instead of sending every prior message to the model.

## Evidence, not assumptions

`npm run bench:memory` evaluates exact recall, lexical variation, semantic paraphrases, unrelated negative queries, and context reduction.

Current deterministic results:

| Retrieval case | Top-1 recall |
| --- | ---: |
| Exact wording | 100% (6/6) |
| Lexical variation | 100% (6/6) |
| Semantic paraphrase without shared wording | 50% (3/6) |
| Unrelated negative queries | 0 false positives (0/3) |

Compact notes reduced the synthetic benchmark context by **95%** compared with its full transcripts. The semantic score is intentionally reported rather than hidden: it is the measured reason for the hybrid-retrieval roadmap below.

## Future: hybrid document memory

The next memory stage is designed, but is **not presented as shipped**:

1. Keep SQLite FTS as the fast, inexpensive first retrieval path.
2. Add cached embeddings when a query is a semantic paraphrase with little keyword overlap.
3. Parse user-approved documents into small cited chunks and pass them through the same relevance, resolution, provenance, and forgetting lifecycle.
4. Keep vectors in SQLite at this scale; adopt `sqlite-vec` or a dedicated vector database only when corpus-size and latency measurements justify the extra dependency.

Document parsing does not require an API key. Semantic embeddings can use either a hosted embedding API (simpler deployment, small usage cost) or a local model (no key, but a larger download and runtime). In either case, RAG remains an internal memory path—not a second agent tool.

## Architecture

```text
Plain HTML/CSS/JS UI
        ↓ SSE
Node HTTP server
        ↓
Agent loop ─── fast routing/extraction model
    │
    ├── web search (the only tool)
    ├── SQLite memory (messages, notes, FTS, ledger, profile)
    └── main streaming answer model
```

- TypeScript on Node.js
- Provider-agnostic model interface
- Provider-neutral model interface with Anthropic, OpenAI Responses API, and keyless stub adapters
- Tavily-compatible search wrapper with persistent caching
- SQLite through Node's built-in `node:sqlite`
- No frontend build step or framework

## Run locally

```bash
npm install
cp .env.example .env
npm run dev
```

Open `http://localhost:3040`. With no API keys, the application still starts in stub mode. Secrets belong only in the local, gitignored `.env` file.

Configure one model provider in `.env`:

```dotenv
MODEL_PROVIDER=openai
OPENAI_API_KEY=
FAST_MODEL=gpt-6-luna
MAIN_MODEL=gpt-6.1-sol
SEARCH_API_KEY=
```

For Anthropic, set `MODEL_PROVIDER=anthropic`, fill `ANTHROPIC_API_KEY`, and choose compatible Claude model IDs. Provider keys are not interchangeable because each provider has a different endpoint and protocol. If `MODEL_PROVIDER` is omitted, Memnora uses the configured Anthropic key first, then OpenAI, then stub mode.

## Verify

```bash
npm run typecheck
npm test
npm run bench:memory
npm run bench
```

## Design principle

Memnora does not try to remember everything. It remembers the smallest useful, attributable representation; retrieves only what is relevant; re-checks facts that can change; and gives the user a direct way to inspect, correct, or forget what was retained.
