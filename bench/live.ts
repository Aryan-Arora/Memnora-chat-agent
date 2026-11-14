// Small paid-API benchmark for the configured fast/main pair. Kept separate from `bench`
// so normal development and CI remain keyless and free.
import { randomUUID } from "node:crypto";
import { runAgent, waitForMemoryTasks, type AgentEvent, type AgentTiming } from "../src/agent/loop.js";
import { createSqliteMemory } from "../src/memory/sqlite.js";
import { createModels } from "../src/models/index.js";
import { costUsd } from "../src/models/pricing.js";
import { createTavilySearch } from "../src/tools/search.js";

try { process.loadEnvFile(".env"); } catch { /* adapters below provide the useful error */ }
const models = createModels();
if (!models.live || !process.env.SEARCH_API_KEY) throw new Error("bench:live requires ANTHROPIC_API_KEY and SEARCH_API_KEY");
const memory = createSqliteMemory(":memory:");
// Seed a dated volatile memory so the paid benchmark exercises the flagship path:
// recall the old answer, reuse its original query, search, and compare saved values with today's.
await memory.saveNote({
  id: "flagship-node", conversationId: "earlier-chat", createdAt: "2026-11-03T09:00:00Z",
  topic: "Node.js LTS version", claim: "Node.js 24 was the active LTS release.",
  sources: ["https://nodejs.org/en/about/previous-releases"],
  query: "current Node.js LTS version", volatility: "volatile",
});
await memory.saveRecheck({
  id: "flagship-node-snapshot", noteId: "flagship-node", conversationId: "earlier-chat",
  createdAt: "2026-11-03T09:00:00Z", query: "current Node.js LTS version",
  snapshot: { active_lts: "Node.js 24" },
});
const flagshipQuestion = "What did I ask on 3 November, and is it still correct today?";
const questions = process.env.FLAGSHIP_ONLY ? [flagshipQuestion] : [
  flagshipQuestion,
  "What is the capital of France?",
  "What is the current Node.js LTS version? Cite the sources.",
  "How do I enable the Quantum Mode feature in Postgres 17?",
];
const rows = [];
let flagshipAnswer = "";
for (const question of questions) {
  const started = performance.now();
  let firstToken = 0, searches = 0, memoryNotes = 0, tokens = 0, cost = 0, error = "", answer = "";
  let timing: AgentTiming | undefined;
  await runAgent({
    fast: models.fast, main: models.main, search: createTavilySearch(), memory,
    now: () => new Date("2026-11-14T12:00:00Z"),
    onUsage(model, usage) {
      tokens += usage.inputTokens + usage.cacheReadTokens + usage.outputTokens;
      cost += costUsd(model, usage);
    },
    onTiming(value) { timing = value; },
  }, randomUUID(), question, (event: AgentEvent) => {
    if (event.type === "token" && !firstToken) firstToken = performance.now() - started;
    if (event.type === "token") answer += event.text;
    if (event.type === "sources") searches += 1;
    if (event.type === "memory") memoryNotes += event.notes?.length ?? 0;
    if (event.type === "error") error = event.text;
  }, { timeZone: "UTC" });
  // Include background memory cost in the report without adding it to user-visible latency.
  const userVisibleTotal = performance.now() - started;
  await waitForMemoryTasks();
  rows.push({
    question: question.slice(0, 48), firstTokenMs: Math.round(firstToken),
    totalMs: Math.round(userVisibleTotal), searches, memoryNotes, tokens,
    routerMs: timing?.routerMs ?? 0, searchMs: timing?.searchMs ?? 0,
    modelStartupMs: timing?.modelStartupMs ?? 0, streamMs: timing?.streamMs ?? 0,
    costUsd: Number(cost.toFixed(5)), error,
  });
  if (question === flagshipQuestion) flagshipAnswer = answer;
}
console.table(rows);
console.log(`\nFlagship answer:\n${flagshipAnswer}`);
memory.close();
