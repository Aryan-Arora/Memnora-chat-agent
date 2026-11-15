# Memnora: design and engineering decisions

## Problem and scope

Memnora is a web-search chat agent with durable conversational memory. It is designed around three questions:

1. When should an answer use the web?
2. What from an earlier conversation is worth remembering?
3. When an earlier fact may have changed, how can the agent compare the old answer with current evidence?

The challenge permits one tool, so **web search is the agent's only tool**. Memory is application infrastructure, not a second tool the model may choose to call. The application controls retrieval, provenance, deletion and context budgets; the model controls language generation.

The submitted application is deliberately local-first and single-user: one Node process, one browser client and one local SQLite database. Authentication and cross-user isolation are outside the submission scope.

## Architecture

```text
Browser (plain HTML/CSS/JS)
        │ POST /api/chat + SSE response
        ▼
Node HTTP server
        ▼
Agent loop
  ├── date and recall resolution
  ├── SQLite/FTS memory retrieval
  ├── fast-model search router
  ├── web search (only agent tool)
  ├── main-model streamed answer
  └── asynchronous memory ingestion

SQLite
  ├── complete message log
  ├── compact memory notes + FTS5
  ├── volatile-fact baselines
  ├── durable ingestion jobs
  ├── structured memory candidates
  ├── forgetting tombstones
  └── response preferences
```

The implementation uses TypeScript on Node 22.5 or newer. The UI has no framework or build step. The server uses `node:http`, and persistence uses Node's built-in `node:sqlite` module.

## Request lifecycle

### Recall before routing

The loop first resolves dates and conversational recall cues. Date phrases become UTC ranges using the browser's IANA timezone, so “3 November” means the user's local day rather than a UTC day.

Retrieval is layered from cheapest to most expensive:

1. resolve a date range in plain code;
2. restrict candidates by date when one was supplied;
3. run FTS5 over compact note topics and claims;
4. return only the top few notes;
5. fall back to that bounded day's messages when history predates note extraction.

An important edge case is “Is the earlier answer still correct today?” Here, `today` is the comparison point, not the old memory's date. The loop therefore searches older notes instead of restricting recall to today.

### Search routing

Two deterministic cases bypass the router model:

- a re-check with a recalled query reuses that query;
- a message that is only a greeting skips search.

Everything else goes to the fast model as a classification task. It receives the local date, up to four recent turns and up to three recalled notes, then returns exactly `NO` or `SEARCH: <query>`.

The first implementation used keyword rules. They were fast but unreliable because words such as “current,” “price” and “previous” appear in both searchable and non-searchable requests. A labelled benchmark showed the old rules getting 38 of 57 cases right. The current real-model routing suite reaches **61 of 61 scored cases**, with three judgement calls reported separately.

The router fails toward search: an empty, malformed or failed reply becomes a search for the original request. A needless search costs time; skipping a necessary search can present stale information as verified.

### Search and answer streaming

Tavily implements the `SearchTool` interface. The wrapper:

- times out after 15 seconds;
- normalizes and deduplicates URLs;
- allows at most two results from one domain;
- returns up to five diverse results;
- caches results in memory and SQLite for ten minutes;
- uses the news index and a day limit for “what happened since?” searches.

The answer streams to the browser through server-sent events. Stable instructions and response preferences are separate from per-request evidence so provider prompt caching can reuse the stable prefix.

The writer uses low reasoning effort. Live comparisons showed that the provider's default high effort spent most output tokens on private reasoning before the first visible word. Low effort reduced latency while preserving the tested comparison accuracy. A 3,000-token ceiling prevents hidden reasoning from truncating a detailed answer; it is a ceiling, not a target.

## Memory design

### Compact notes, not unlimited transcript context

Complete messages are retained for chat reloads and exact fallback, but they are not the default long-term prompt context. After a completed exchange, the fast model extracts one validated note:

```ts
{ topic, claim, sources, query, volatility, snapshot }
```

Notes are small, attributable and date-stamped. The deterministic benchmark shows a **95% context reduction** compared with injecting its full synthetic transcripts.

### Durable asynchronous ingestion

Extraction happens after the visible answer. Before processing starts, the exchange is written to a SQLite queue. An interrupted job can be reclaimed after restart, so memory work is not silently lost.

```text
completed exchange
    → durable job
    → relevance gate
    → compact note
    → structured candidate
    → duplicate/update resolution
    → active memory
```

The deterministic relevance gate rejects greetings, acknowledgements, empty answers and failure messages before spending an extraction call. Reusable exchanges are categorized as preferences, decisions, plans, personal facts or research findings.

### Candidate resolution

Each candidate has a normalized SHA-256 fingerprint and evidence references. Resolution can insert, mark an exact duplicate, supersede an older preference/decision/plan while retaining history, or reject a candidate matching a forgetting tombstone.

Token overlap is used conservatively as a duplicate signal, never as proof that two claims mean the same thing.

### Volatile facts and re-checks

Prices, versions, availability and office-holders are volatile. Their notes retain the query that produced the answer and a small baseline snapshot.

On a re-check, Memnora:

1. recalls the dated note;
2. reruns the saved query for a like-for-like comparison;
3. supplies the old claim, baseline values and current sources to the writer;
4. streams a `then / now / status` table;
5. distinguishes **changed**, **unchanged** and **not confirmed**;
6. gives the verdict after the evidence.

“Not confirmed” is not treated as “changed.” Missing evidence is not evidence of a change.

An earlier version made another model call to extract current values and diffed snapshots in code. It added 2.2–4.9 seconds before the first word and could classify missing values as changes. The current design preserves the structured baseline but lets one answer model compare it directly with cited evidence.

### What happened since

A saved pricing query cannot also prove whether a company launched something important. During a re-check, the fast model identifies the products or companies in the saved note while the primary query runs. Code performs one parallel `<name> news` search per item, limited to the days since the note.

The first comparison streams without waiting for this work. A small fast-model call classifies the surviving news results into pricing, launch or company events; code—not another prose-writing model—renders `Since <date>`. Rejected results never reach the answer, undated and older results are removed before classification, and citation numbering continues across both sections.

This adds depth without delaying the first section, at the cost of follow-up planning, one small classification call and up to five searches per re-check.

### Legacy query repair

Old notes sometimes contain the user's complete sentence instead of a useful search query. A bulk migration could rewrite already-good queries, so repair is lazy:

1. detect unmistakable conversational prose;
2. rewrite it once using the note topic and claim;
3. use it immediately;
4. persist it onto the original note;
5. reuse it directly on later re-checks.

Malformed or failed rewrites keep the original query. The real routing benchmark covers this path.

### Explicit forgetting and scoped deletion

Forgetting requires exact memory IDs and confirmation. It records a content-free fingerprint tombstone so queued ingestion cannot recreate the forgotten memory.

Deleting a conversation removes only its messages, notes and ledger entries. The server rejects global history deletion. Personalization is stored separately and can be cleared independently.

## Storage decisions

SQLite is the primary store because it provides transactions, indexes on date and conversation, FTS5, a durable queue and one inspectable local artifact without another service. The original JSON message store remains a startup fallback. It preserves basic chat operation but not the full note lifecycle.

The message log remains complete because the sidebar and chat reload APIs derive their state from `recent()`. Compact notes optimize model context; they do not replace user-visible history.

## Provider boundary and credentials

The loop depends on one small `ModelAdapter` interface with streaming and non-streaming completion methods. Anthropic, OpenAI and the keyless stub implement that boundary. Provider selection and model IDs are environment configuration, not branches in the agent loop.

The browser never receives provider credentials. The Node process loads them from the local, gitignored `.env`. OpenAI response storage is disabled.

Supported environment values are:

- `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` for one selected model provider;
- `SEARCH_API_KEY` for live Tavily search;
- `MODEL_PROVIDER`, `FAST_MODEL` and `MAIN_MODEL` as non-secret configuration.

With no keys, the application runs in deterministic stub mode.

## UI and protocol

The frontend is plain HTML, CSS and JavaScript so the submission has no frontend build pipeline. The SSE protocol exposes:

- `status`: current activity;
- `token`: streamed answer text;
- `sources`: attributed web evidence;
- `memory`: notes or past messages used;
- `error`: request failure;
- `done`: completion.

Memory provenance is separate from web sources. The interface supports scoped chat deletion, phone widths, dark mode, reduced motion, reduced transparency and high contrast.

## Failure handling

- **Router failure:** search the original request rather than silently skip verification.
- **Search failure:** answer with an explicit statement that the web could not be checked.
- **Malformed extraction:** reject it before storage.
- **Background failure:** mark the durable job failed and retry later.
- **Follow-up planning failure:** return the primary comparison without the news section.
- **SQLite startup failure:** use the JSON message-store fallback.
- **Authentication failure:** return a generic error that cannot echo a key.

Every model-produced structured value is parsed and bounded before crossing the storage boundary.

## Measurement

| Command | Purpose |
| --- | --- |
| `npm test` | deterministic unit and integration tests |
| `npm run typecheck` | TypeScript boundary validation |
| `npm run bench` | keyless latency and routing harness |
| `npm run bench:memory` | retrieval quality and context reduction |
| `npm run bench:routing` | labelled real fast-model routing evaluation |
| `npm run bench:live` | opt-in paid end-to-end latency and cost |

Current deterministic retrieval results:

| Tier | Top-1 | Top-3 |
| --- | ---: | ---: |
| Exact wording | 6/6 | 6/6 |
| Lexical variation | 6/6 | 6/6 |
| Semantic paraphrase | 3/6 | 3/6 |

The negative set has 0/3 false positives. The 50% semantic result is intentionally reported: it motivates a future hybrid layer rather than supporting an unmeasured claim.

The routing evaluation separately checks the primary search decision and follow-up item planning. Follow-up planning retries once only when the fast model returns no names, reducing stochastic `NONE` replies without adding latency to the normal path.

Live latency varies with provider load and cache state. In measured challenge journeys, routing and low-effort writing reduced first-word latency from roughly 8–12 seconds to roughly 2–6 seconds. Six representative questions fell from about $0.11 to about $0.067 in aggregate. The deeper `Since` work runs in parallel with the first comparison; its exact completion time and cost depend on how many products are identified.

## Trade-offs

**FTS5 before embeddings.** FTS5 has no extra service or embedding cost and has perfect measured exact/lexical recall in the current set. Its semantic limitation is measured. Embeddings are deferred until the gap justifies another provider or local model dependency.

**One broad primary comparison query.** Reusing the saved query preserves like-for-like intent and low latency. Per-product price searches could improve coverage but would increase requests and delay the first answer. Item-level searches are currently reserved for the later news section.

**Model routing instead of many rules.** The fast router costs about one second for non-trivial messages, but measured accuracy is substantially better than keyword rules. Only deterministic cases bypass it.

**Local single-user storage.** SQLite makes the repository runnable with one command and memory easy to inspect. It is not safe for multiple accounts on a shared server.

## Known limitations and next steps

- Semantic paraphrases without shared wording can miss FTS retrieval.
- Broad multi-product price queries can have incomplete coverage.
- Phrases such as `11/3`, `this morning` and `since Monday` need more date grammar.
- OpenAI has mocked adapter tests but not the same paid live evaluation as Anthropic.
- Every re-check takes the additional dated-news path, trading cost for completeness.
- The application is single-user and local-first.
- Document ingestion and vector retrieval are future work, not shipped features.

The next retrieval stage would keep FTS as the first pass, add cached embeddings only for low-overlap paraphrases, and send document chunks through the same relevance, provenance, resolution and forgetting lifecycle. Memory would remain internal context, so web search would still be the only agent tool.

## Running the submission

Requirements: Node.js 22.5 or newer.

```bash
npm install
cp .env.example .env
npm run dev
```

Open `http://localhost:3040`. With no keys the application starts in stub mode. For live operation, configure one model-provider key and `SEARCH_API_KEY`. These are the only supported credentials listed in `.env.example`.
