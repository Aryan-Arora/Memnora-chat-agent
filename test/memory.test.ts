import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runAgent, waitForMemoryTasks, type AgentEvent } from "../src/agent/loop.js";
import { diffSnapshots } from "../src/memory/ledger.js";
import { assessRelevance, candidateFromNote } from "../src/memory/ingestion.js";
import { parseNoteExtraction } from "../src/memory/notes.js";
import { resolveDate } from "../src/memory/dates.js";
import { buildProfilePrompt, DEFAULT_PROFILE } from "../src/memory/preferences.js";
import { createSqliteMemory } from "../src/memory/sqlite.js";
import type { CompletionRequest, MemoryIngestionSource, MemoryNote, ModelAdapter, SearchTool } from "../src/types.js";

test("note parsing rejects malformed output and snapshot diff stays structured", () => {
  const meta = { id: "n", conversationId: "c", createdAt: "2026-11-10T10:00:00Z" };
  assert.equal(parseNoteExtraction("not json", meta), null);
  assert.deepEqual(diffSnapshots({ price: 10, available: true }, { price: 12, available: true }), [
    { key: "price", before: 10, after: 12 },
  ]);
});

test("date phrases resolve in the user's timezone with explicit dates taking priority", () => {
  const now = new Date("2026-11-10T20:00:00Z"); // 11 November in India
  assert.deepEqual(resolveDate("What did I ask on Nov 3, and is it still correct today?", now, "Asia/Kolkata"), {
    from: "2026-11-02T18:30:00.000Z", to: "2026-11-03T18:30:00.000Z", label: "3 november",
  });
  assert.equal(resolveDate("What happened on Monday?", now, "Asia/Kolkata")?.from, "2026-11-08T18:30:00.000Z");
  assert.equal(resolveDate("What happened two days ago?", now, "Asia/Kolkata")?.from, "2026-11-08T18:30:00.000Z");
  assert.deepEqual(resolveDate("Summarize last week", now, "Asia/Kolkata"), {
    from: "2026-11-01T18:30:00.000Z", to: "2026-11-08T18:30:00.000Z", label: "last week",
  });
  // New York's DST fallback makes this local day 25 hours, not a fixed UTC day.
  const dst = resolveDate("today", new Date("2026-11-01T12:00:00Z"), "America/New_York");
  assert.equal(dst?.from, "2026-11-01T04:00:00.000Z");
  assert.equal(dst?.to, "2026-11-02T05:00:00.000Z");
});

test("dated re-check recalls first and reuses a saved query without requiring a snapshot", async () => {
  const memory = createSqliteMemory(":memory:");
  await memory.saveNote({
    id: "dated-note", conversationId: "old", createdAt: "2026-11-03T09:00:00Z",
    topic: "Node.js support", claim: "Node.js 24 was the current release.",
    sources: ["https://example.com/node"], query: "current Node.js release", volatility: "volatile",
  });
  const searched: string[] = [];
  const contexts: string[] = [];
  const model: ModelAdapter = {
    name: "dated-recheck-test",
    async complete() { return "NO"; },
    async *stream(req) { contexts.push(req.context ?? ""); yield "Checked."; },
  };
  await runAgent({
    fast: model, main: model, memory,
    now: () => new Date("2026-11-10T20:00:00Z"),
    search: { async search(query) { searched.push(query); return [{ title: "Node", url: "https://example.com", snippet: "Current release" }]; } },
  }, "new", "What did I ask on Nov 3, and is it still correct today?", () => {}, { timeZone: "Asia/Kolkata" });
  assert.deepEqual(searched, ["current Node.js release"]);
  assert.match(contexts[0], /Node\.js 24 was the current release/);
  await waitForMemoryTasks("new");
  memory.close();
});

test("an assumed technical feature is still searched when the router's reply is unreadable", async () => {
  const memory = createSqliteMemory(":memory:");
  const searched: string[] = [];
  let routerCalls = 0;
  const model: ModelAdapter = {
    name: "verification-test",
    // Whether to search is the router model's call (measured in bench/routing.ts). What a
    // unit test can pin is the safety net: a reply that is neither NO nor SEARCH still searches.
    async complete(req) { if (req.system.includes("ROUTER")) { routerCalls += 1; return "Let me think about that."; } return "NO"; },
    async *stream() { yield "No such feature was found."; },
  };
  const question = "How do I enable the Quantum Mode feature in Postgres 17?";
  await runAgent({
    fast: model, main: model, memory,
    search: { async search(query) { searched.push(query); return [{ title: "Postgres docs", url: "https://example.com", snippet: "No Quantum Mode" }]; } },
  }, "technical", question, () => {});
  assert.deepEqual(searched, [question]);
  assert.equal(routerCalls, 1);
  await waitForMemoryTasks("technical");
  memory.close();
});

test("ordinary uses of before and still reach the router instead of being treated as memory questions", async () => {
  const memory = createSqliteMemory(":memory:");
  const searched: string[] = [];
  let routerCalls = 0;
  const model: ModelAdapter = {
    name: "factual-routing-test",
    async complete(req) {
      if (!req.system.includes("ROUTER")) return "NO";
      routerCalls += 1;
      return `SEARCH: router query ${routerCalls}`;
    },
    async *stream() { yield "Verified."; },
  };
  const deps = {
    fast: model, main: model, memory,
    search: { async search(query: string) { searched.push(query); return [{ title: "Source", url: "https://example.com", snippet: "Evidence" }]; } },
  };
  const questions = ["What did Apple announce before the iPhone 15?", "Is Python still the best first language?"];
  for (const question of questions) {
    await runAgent(deps, "facts", question, () => {});
    await waitForMemoryTasks("facts");
  }
  assert.deepEqual(searched, ["router query 1", "router query 2"]);
  assert.equal(routerCalls, 2);
  memory.close();
});

test("agent stores, retrieves and re-checks a volatile note", async () => {
  const memory = createSqliteMemory(":memory:");
  const searched: string[] = [];
  const contexts: string[] = [];
  let routerCalls = 0;

  const fast: ModelAdapter = {
    name: "test-fast",
    async complete(req: CompletionRequest) {
      if (req.system.includes("ROUTER")) {
        routerCalls += 1;
        return routerCalls === 1 ? "SEARCH: Acme plan price" : "SEARCH: generic router query";
      }
      return JSON.stringify({
        topic: "Acme hosting price", claim: "Acme costs $10 monthly",
        sources: [], query: "Acme plan price", volatility: "volatile",
        snapshot: { monthly_price_usd: 10 },
      });
    },
    async *stream(req: CompletionRequest) {
      contexts.push(req.context ?? "");
      yield "Acme costs $10 monthly.";
    },
  };
  const search: SearchTool = {
    async search(query) {
      searched.push(query);
      return [{ title: "Acme pricing", url: "https://example.com/price", snippet: "Acme now costs $12 monthly." }];
    },
  };
  const now = () => new Date("2026-11-10T12:00:00Z");

  await runAgent({ fast, main: fast, search, memory, now }, "chat", "What is the Acme hosting price?", () => {});
  await waitForMemoryTasks("chat");
  const notes = await memory.retrieve("Acme hosting price");
  assert.equal(notes.length, 1);
  assert.ok(notes[0].createdAt.startsWith("2026-11-10T12:00"), "notes are dated by the injected clock, not the machine clock");
  assert.deepEqual((await memory.latestRecheck(notes[0].id))?.snapshot, { monthly_price_usd: 10 });

  const events: AgentEvent[] = [];
  await runAgent(
    { fast, main: fast, search, memory, now },
    "chat",
    "Has the Acme hosting price changed since last time?",
    (event) => events.push(event),
  );
  await waitForMemoryTasks("chat");
  assert.deepEqual(searched, ["Acme plan price", "Acme plan price"], "re-check should reuse the exact first query");
  assert.equal(routerCalls, 1, "the re-check reuses the saved query without asking the router again");
  // The answer model gets the saved values and today's results side by side and compares them itself.
  assert.match(contexts.at(-1) ?? "", /Values saved on 2026-11-10 with the answer about "Acme hosting price"/);
  assert.match(contexts.at(-1) ?? "", /\{"monthly_price_usd":10\}/);
  assert.match(contexts.at(-1) ?? "", /Acme now costs \$12 monthly/);
  assert.deepEqual((await memory.latestRecheck(notes[0].id))?.snapshot, { monthly_price_usd: 10 }, "a re-check must not move the baseline");
  const memoryEvent = events.find((event) => event.type === "memory");
  assert.ok(memoryEvent?.type === "memory" && memoryEvent.notes?.[0].topic === "Acme hosting price");
  memory.close();
});

test("a re-check adds a Since section from dated, filtered news while the first part is written", async () => {
  const memory = createSqliteMemory(":memory:");
  await memory.saveNote({
    id: "crm-note", conversationId: "old", createdAt: "2026-11-09T10:00:00Z",
    topic: "CRM shortlist prices", claim: "Acme CRM costs $10 and Bolt CRM costs $12.",
    sources: [], query: "Acme Bolt CRM prices", volatility: "volatile",
  });
  await memory.saveRecheck({
    id: "crm-snapshot", noteId: "crm-note", conversationId: "old", createdAt: "2026-11-09T10:00:00Z",
    query: "Acme Bolt CRM prices", snapshot: { acme_usd: 10, bolt_usd: 12 },
  });

  const searches: { query: string; sinceDays?: number }[] = [];
  const search: SearchTool = {
    async search(query, opts) {
      searches.push({ query, ...(opts?.sinceDays ? { sinceDays: opts.sinceDays } : {}) });
      if (query === "Acme Bolt CRM prices") return [{ title: "Prices", url: "https://example.com/prices", snippet: "Acme $10, Bolt $12" }];
      if (query === "Acme CRM news") {
        return [
          { title: "Acme ships Autopilot", url: "https://example.com/acme-new", snippet: "Acme launched Autopilot.", publishedAt: "Thu, 12 Nov 2026 09:00:00 GMT" },
          { title: "Acme in 2025", url: "https://example.com/acme-old", snippet: "Old news.", publishedAt: "Mon, 03 Mar 2025 09:00:00 GMT" },
          { title: "Acme profile", url: "https://example.com/acme-undated", snippet: "No date." },
        ];
      }
      return []; // nothing in the news for Bolt
    },
  };
  const filterPrompts: string[] = [];
  let filterStarted!: () => void;
  const started = new Promise<void>((resolve) => { filterStarted = resolve; });
  const fast: ModelAdapter = {
    name: "fast-test",
    async complete(req) {
      // The fast model names the products and filters the news; the loop turns each name into a news search.
      if (req.system.startsWith("FOLLOW-UP")) return "Acme CRM\nBolt CRM";
      if (req.system.startsWith("NEWS FILTER")) {
        filterPrompts.push(req.messages[0].content);
        filterStarted();
        return JSON.stringify({ events: [{ ns: [2], kind: "launch", summary: "Acme launched Autopilot, its AI sales assistant." }] });
      }
      return "NO";
    },
    async *stream() { /* the fast model never streams here */ },
  };
  let mainCalls = 0;
  const main: ModelAdapter = {
    name: "main-test",
    async complete() { return "NO"; },
    async *stream() {
      mainCalls += 1;
      // The first part may not finish until the news filter has started. If the filter only ran
      // after the first part (the old order), this wait would time out and fail the test.
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        started,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("the news filter did not start while the first part was being written")), 2000); }),
      ]).finally(() => clearTimeout(timer));
      yield "Prices are unchanged.";
    },
  };
  const events: AgentEvent[] = [];
  await runAgent(
    { fast, main, search, memory, now: () => new Date("2026-11-15T10:00:00Z") },
    "new",
    "The CRM shortlist was made on Monday: has any changed pricing or shipped something big since?",
    (event) => events.push(event),
  );
  await waitForMemoryTasks("new");

  assert.deepEqual(events.filter((event) => event.type === "error"), []);
  // The saved query runs unchanged. Each news search is limited to the days since the note.
  assert.deepEqual(searches, [
    { query: "Acme Bolt CRM prices" },
    { query: "Acme CRM news", sinceDays: 7 },
    { query: "Bolt CRM news", sinceDays: 7 },
  ]);
  assert.equal(mainCalls, 1, "the Since section is written by code, not by a second answer-model call");
  // The filter sees only the result dated after the note, numbered after the first part's sources.
  assert.match(filterPrompts[0], /\[2\] searched for: Acme CRM \| example\.com \| published 12 Nov/);
  assert.doesNotMatch(filterPrompts[0], /acme-old|acme-undated|Acme in 2025|Acme profile/);

  const lastSources = events.filter((event) => event.type === "sources").at(-1);
  assert.deepEqual(
    lastSources?.type === "sources" ? lastSources.sources.map((source) => source.url) : [],
    ["https://example.com/prices", "https://example.com/acme-new"],
  );
  const saved = (await memory.recent(10)).find((message) => message.role === "assistant");
  assert.equal(
    saved?.content,
    "Prices are unchanged.\n\n## Since 2026-11-09\n\n- **Acme CRM** (launch, 12 Nov): Acme launched Autopilot, its AI sales assistant. [2]\n- Nothing found for Bolt CRM.",
  );
  memory.close();
});

test("a failed news filter says so and keeps the answer", async () => {
  const memory = createSqliteMemory(":memory:");
  await memory.saveNote({
    id: "n", conversationId: "old", createdAt: "2026-11-09T10:00:00Z", topic: "CRM prices",
    claim: "Acme CRM costs $10.", sources: [], query: "Acme CRM prices", volatility: "volatile",
  });
  const model: ModelAdapter = {
    name: "filter-failure-test",
    async complete(req) {
      if (req.system.startsWith("FOLLOW-UP")) return "Acme CRM";
      if (req.system.startsWith("NEWS FILTER")) throw new Error("filter down");
      return "NO";
    },
    async *stream() { yield "Still $10."; },
  };
  const events: AgentEvent[] = [];
  await runAgent({
    fast: model, main: model, memory, now: () => new Date("2026-11-15T10:00:00Z"),
    search: {
      async search(_query, opts) {
        return opts?.sinceDays
          ? [{ title: "Acme news", url: "https://example.com/news", snippet: "x", publishedAt: "Thu, 12 Nov 2026 09:00:00 GMT" }]
          : [{ title: "Acme prices", url: "https://example.com/prices", snippet: "Acme $10" }];
      },
    },
  }, "new", "Has the Acme CRM price changed since Monday?", (event) => events.push(event));
  await waitForMemoryTasks("new");
  assert.deepEqual(events.filter((event) => event.type === "error"), []);
  const saved = (await memory.recent(10)).find((message) => message.role === "assistant");
  assert.equal(saved?.content, "Still $10.\n\n## Since 2026-11-09\n\n- I could not check what has happened since: the news step failed.");
  memory.close();
});

test("a recalled note with no saved query is still re-checked, with news since", async () => {
  const memory = createSqliteMemory(":memory:");
  // An earlier answer written without searching leaves a note, but no query to run again.
  await memory.saveNote({
    id: "no-query", conversationId: "old", createdAt: "2026-11-09T10:00:00Z",
    topic: "CRM shortlist", claim: "Acme CRM and Bolt CRM were shortlisted; Acme costs $10.",
    sources: [], volatility: "volatile",
  });
  const searches: { query: string; sinceDays?: number }[] = [];
  const search: SearchTool = {
    async search(query, opts) {
      searches.push({ query, ...(opts?.sinceDays ? { sinceDays: opts.sinceDays } : {}) });
      return [];
    },
  };
  const model: ModelAdapter = {
    name: "no-query-test",
    async complete(req) {
      if (req.system.startsWith("ROUTER")) return "SEARCH: Acme CRM Bolt CRM pricing";
      if (req.system.startsWith("FOLLOW-UP")) return "Acme CRM";
      return "NO";
    },
    async *stream() { yield "Checked."; },
  };
  await runAgent(
    { fast: model, main: model, search, memory, now: () => new Date("2026-11-15T10:00:00Z") },
    "new",
    "On Monday we shortlisted 5 CRM tools. Has any of them changed pricing or shipped something big since?",
    () => {},
  );
  await waitForMemoryTasks("new");
  assert.deepEqual(searches, [
    { query: "Acme CRM Bolt CRM pricing" },
    { query: "Acme CRM news", sinceDays: 7 },
  ]);
  const saved = (await memory.recent(10)).find((message) => message.role === "assistant");
  assert.match(saved?.content ?? "", /## Since 2026-11-09\n\n- Nothing found for Acme CRM\./);
  memory.close();
});

test("the user's own words from the named day reach the answer model, so they can be quoted", async () => {
  const memory = createSqliteMemory(":memory:");
  await memory.save({
    id: "asked", role: "user", content: "What's the latest iPhone and how much does it cost?",
    createdAt: "2026-11-03T10:00:00.000Z", conversationId: "old",
  });
  await memory.save({
    id: "answered", role: "assistant", content: "Raw assistant text that only the note should carry.",
    createdAt: "2026-11-03T10:00:09.000Z", conversationId: "old",
  });
  await memory.saveNote({
    id: "iphone", conversationId: "old", createdAt: "2026-11-03T10:00:09.000Z", topic: "Latest iPhone and price",
    claim: "The iPhone 17 starts at $799.", sources: [], query: "latest iPhone price", volatility: "volatile",
  });
  const contexts: string[] = [];
  const model: ModelAdapter = {
    name: "own-words-test",
    async complete(req) { return req.system.startsWith("FOLLOW-UP") ? "NONE" : "NO"; },
    async *stream(req) { contexts.push(req.context ?? ""); yield "You asked about the latest iPhone."; },
  };
  await runAgent(
    {
      fast: model, main: model, memory, now: () => new Date("2026-11-15T10:00:00Z"),
      search: { async search() { return [{ title: "Apple", url: "https://example.com", snippet: "iPhone 17 $799" }]; } },
    },
    "new", "What did I ask you on 3 November? Is your answer still correct today?", () => {}, { timeZone: "UTC" },
  );
  await waitForMemoryTasks("new");
  assert.match(contexts[0], /What the user wrote on that day, in their own words/);
  assert.match(contexts[0], /\[2026-11-03 10:00\] What's the latest iPhone and how much does it cost\?/);
  assert.doesNotMatch(contexts[0], /Raw assistant text/);
  memory.close();
});

test("a repaired legacy query is persisted on its original SQLite note", async () => {
  const memory = createSqliteMemory(":memory:");
  await memory.saveNote({
    id: "legacy-note", conversationId: "old", createdAt: "2026-11-09T10:00:00Z",
    topic: "CRM starting prices", claim: "HubSpot, Pipedrive and Zoho prices were compared.",
    sources: [], volatility: "volatile",
    query: "I compared CRM tools on Monday; have any of their prices changed since then? Please cite sources.",
  });
  const model: ModelAdapter = {
    name: "legacy-query-test",
    async complete(req) {
      if (req.system.startsWith("SEARCH QUERY REPAIR")) return "QUERY: HubSpot Pipedrive Zoho CRM starting prices";
      if (req.system.startsWith("FOLLOW-UP")) return "NONE";
      return ""; // the background extractor may safely reject this
    },
    async *stream() { yield "The prices were checked."; },
  };
  await runAgent({
    fast: model, main: model, memory, now: () => new Date("2026-11-15T10:00:00Z"),
    search: { async search() { return [{ title: "CRM pricing", url: "https://example.com", snippet: "Current prices" }]; } },
  }, "new", "I asked about the CRM prices earlier. Are they still correct today?", () => {});
  await waitForMemoryTasks("new");
  const repaired = (await memory.retrieve("CRM starting prices", undefined, 10)).find((item) => item.id === "legacy-note");
  assert.equal(repaired?.query, "HubSpot Pipedrive Zoho CRM starting prices");
  memory.close();
});

test("SQLite conversation deletion removes transcript, notes and ledger", async () => {
  const memory = createSqliteMemory(":memory:");
  await memory.save({ id: "m", role: "user", content: "hello", createdAt: "2026-11-10T00:00:00Z", conversationId: "c" });
  await memory.saveNote({ id: "n", conversationId: "c", createdAt: "2026-11-10T00:00:01Z", topic: "hello", claim: "hello world", sources: [], query: "hello", volatility: "volatile" });
  await memory.saveRecheck({ id: "r", noteId: "n", conversationId: "c", createdAt: "2026-11-10T00:00:02Z", query: "hello", snapshot: { value: 1 } });
  await memory.deleteConversation?.("c");
  assert.equal((await memory.recent(10)).length, 0);
  assert.equal((await memory.retrieve("hello")).length, 0);
  assert.equal(await memory.latestRecheck("n"), null);
  memory.close();
});

test("SQLite stores an inspectable user profile separately from conversations", async () => {
  const memory = createSqliteMemory(":memory:");
  const profile = { ...DEFAULT_PROFILE, answerLength: "concise" as const, updatedAt: "2026-11-11T00:00:00Z" };
  await memory.saveProfile(profile);
  assert.equal((await memory.getProfile())?.answerLength, "concise");
  assert.match(buildProfilePrompt(profile), /Length: concise/);
  await memory.clearProfile();
  assert.equal(await memory.getProfile(), null);
  memory.close();
});

test("a new chat can immediately summarize the previous chat", async () => {
  const memory = createSqliteMemory(":memory:");
  const contexts: string[] = [];
  const model: ModelAdapter = {
    name: "cross-chat-test",
    async complete(req) {
      if (req.system.includes("Extract one compact memory note")) {
        return JSON.stringify({
          topic: "Mars launch plan", claim: "The launch plan uses a reusable rocket in 2028.",
          sources: [], volatility: "stable", snapshot: {},
        });
      }
      return "NO";
    },
    async *stream(req) {
      contexts.push(req.context ?? "");
      yield contexts.length === 1
        ? "The Mars launch plan uses a reusable rocket in 2028."
        : "Your previous chat discussed the Mars launch plan.";
    },
  };
  const search: SearchTool = { async search() { return []; } };
  const now = () => new Date("2026-11-12T10:00:00Z");

  await runAgent({ fast: model, main: model, search, memory, now }, "chat-a", "Plan a Mars launch", () => {});
  const events: AgentEvent[] = [];
  await runAgent(
    { fast: model, main: model, search, memory, now },
    "chat-b",
    "Summarize my previous chat",
    (event) => events.push(event),
  );

  assert.match(contexts[1], /Plan a Mars launch/);
  assert.ok(events.some((event) => event.type === "memory"));
  await waitForMemoryTasks();
  memory.close();
});

test("durable ingestion gates noise, resolves candidates and prevents forgotten memory returning", async () => {
  const memory = createSqliteMemory(":memory:");
  const user = { id: "u", role: "user" as const, content: "I prefer concise answers", createdAt: "2026-11-13T10:00:00Z", conversationId: "c" };
  const assistant = { id: "a", role: "assistant" as const, content: "I will keep future answers concise while preserving important evidence.", createdAt: "2026-11-13T10:00:01Z", conversationId: "c" };
  const source: MemoryIngestionSource = {
    id: "s1", conversationId: "c", user, assistant, sources: [], createdAt: assistant.createdAt,
  };
  const decision = assessRelevance(source);
  assert.equal(decision.outcome, "accept");
  assert.equal(decision.category, "preference");
  assert.equal(assessRelevance({ ...source, user: { ...user, content: "Thanks!" } }).outcome, "reject");

  await memory.enqueueIngestion(source);
  const job = await memory.claimIngestion();
  assert.equal(job?.source.id, "s1");
  await memory.completeIngestion(job!.id);
  assert.equal(await memory.claimIngestion(), null);

  const note: MemoryNote = {
    id: "n1", conversationId: "c", createdAt: assistant.createdAt,
    topic: "Answer style", claim: "Aryan prefers concise answers", sources: [], volatility: "stable",
  };
  const first = candidateFromNote(source, note, decision);
  assert.equal((await memory.resolveCandidate(first)).action, "inserted");
  assert.equal((await memory.resolveCandidate({ ...first, id: "duplicate" })).action, "duplicate");

  const changedNote = { ...note, id: "n2", claim: "Aryan prefers detailed answers", createdAt: "2026-11-13T11:00:00Z" };
  const changed = candidateFromNote({ ...source, id: "s2" }, changedNote, decision);
  assert.equal((await memory.resolveCandidate(changed)).action, "superseded");
  assert.deepEqual((await memory.activeMemories()).map((item) => item.object), ["Aryan prefers detailed answers"]);

  assert.equal(await memory.forgetMemories([changed.id]), 1);
  assert.equal((await memory.activeMemories()).length, 0);
  assert.equal((await memory.resolveCandidate({ ...changed, id: "recreated" })).action, "rejected");
  memory.close();
});

test("an interrupted ingestion job is claimed again after restart", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "memnora-memory-"));
  const file = path.join(directory, "memory.sqlite");
  const user = { id: "u", role: "user" as const, content: "Research durable queues", createdAt: "2026-11-13T10:00:00Z", conversationId: "c" };
  const assistant = { id: "a", role: "assistant" as const, content: "A durable queue persists work before processing starts.", createdAt: "2026-11-13T10:00:01Z", conversationId: "c" };
  const source: MemoryIngestionSource = { id: "restart-source", conversationId: "c", user, assistant, sources: [], createdAt: assistant.createdAt };
  try {
    const first = createSqliteMemory(file);
    await first.enqueueIngestion(source);
    await first.saveNote({
      id: "old-note", conversationId: "c", createdAt: assistant.createdAt,
      topic: "Durable queue", claim: "Jobs survive a process restart", sources: [], volatility: "stable",
    });
    assert.equal((await first.claimIngestion())?.attempts, 1);
    first.close(); // simulate a process stopping while the job is marked processing

    const restarted = createSqliteMemory(file);
    const retried = await restarted.claimIngestion();
    assert.equal(retried?.source.id, source.id);
    assert.equal(retried?.attempts, 2);
    assert.equal((await restarted.activeMemories("durable")).length, 1, "older notes should be backfilled");
    await restarted.completeIngestion(retried!.id);
    restarted.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
