// Routing check: for the labelled messages in routing-cases.ts, does the agent search when
// it should and stay off the web when it should not, and is the query it writes self-contained?
// Runs the real loop with the configured fast model. The search and the answer model are
// stand-ins, so the run costs a fraction of a cent and needs no search key.
//   npm run bench:routing
import { runAgent, waitForMemoryTasks, type AgentTiming } from "../src/agent/loop.js";
import { createSqliteMemory } from "../src/memory/sqlite.js";
import { createModels } from "../src/models/index.js";
import { costUsd } from "../src/models/pricing.js";
import type { ModelAdapter, SearchTool } from "../src/types.js";
import { ROUTING_CASES } from "./routing-cases.js";

try { process.loadEnvFile(".env"); } catch { /* createModels reports the missing key */ }
const models = createModels();
if (!models.live) throw new Error("bench:routing needs a model API key in .env");

const NOW = new Date("2026-11-15T10:00:00Z"); // Sunday afternoon in India
let cost = 0;

// Only routing and follow-up planning reach the real fast model. Note extraction is skipped: it is not under test.
const fast: ModelAdapter = {
  name: models.fast.name,
  stream: (req) => models.fast.stream(req),
  async complete(req) {
    if (!req.system.startsWith("ROUTER") && !req.system.startsWith("FOLLOW-UP") && !req.system.startsWith("SEARCH QUERY REPAIR")) return "";
    return models.fast.complete({ ...req, onUsage: (usage) => { cost += costUsd(models.fast.name, usage); } });
  },
};
const main: ModelAdapter = {
  name: "stand-in",
  async complete() { return "ok"; },
  async *stream() { yield "ok"; },
};

const rows = [];
for (const item of ROUTING_CASES) {
  const memory = createSqliteMemory(":memory:");
  for (const [index, note] of (item.notes ?? []).entries()) {
    await memory.saveNote({ id: `seed-${index}`, conversationId: "earlier", sources: [], volatility: "volatile", ...note });
  }
  for (const [index, turn] of (item.turns ?? []).entries()) {
    await memory.save({
      id: `turn-${index}`, conversationId: "case", role: turn.role, content: turn.content,
      createdAt: new Date(NOW.getTime() - 60_000 + index * 1000).toISOString(),
    });
  }
  const queries: string[] = []; // the main search
  const news: string[] = []; // news searches added to a re-check, recognisable by their day limit
  const search: SearchTool = {
    async search(query, opts) {
      (opts?.sinceDays ? news : queries).push(query);
      return [{ title: "stand-in", url: "https://example.com", snippet: "stand-in" }];
    },
  };
  let timing: AgentTiming | undefined;
  await runAgent(
    { fast, main, search, memory, now: () => NOW, onTiming: (value) => { timing = value; } },
    "case", item.text, () => {}, { timeZone: "Asia/Kolkata" },
  );
  await waitForMemoryTasks();
  memory.close();

  const searched = queries.length > 0;
  const decisionOk = item.want === "either" || searched === (item.want === "search");
  const queryOk = !item.mustMention || !searched || item.mustMention.test(queries[0]);
  // A re-check should run one news search naming each item it is about, and not many more.
  const newsOk = !item.newsFor || (
    item.newsFor.every((name) => news.some((query) => query.toLowerCase().includes(name))) &&
    news.length <= (item.maxNews ?? 5)
  );
  rows.push({
    message: item.text.slice(0, 52),
    want: item.want,
    got: searched ? "search" : "no",
    ok: item.want === "either" ? "-" : decisionOk && queryOk && newsOk ? "yes" : "NO",
    routerMs: timing?.routerMs ?? 0,
    query: (queries[0] ?? "").slice(0, 60),
    news: item.newsFor ? `${newsOk ? "ok" : "WRONG"}: ${news.join(" | ").slice(0, 90)}` : news.length ? `${news.length} unexpected` : "",
  });
}

const scored = rows.filter((row) => row.ok !== "-");
const passed = scored.filter((row) => row.ok === "yes").length;
const modelTimes = rows.map((row) => row.routerMs).filter((ms) => ms > 20).sort((a, b) => a - b);
const newsRows = rows.filter((row) => row.news.startsWith("ok") || row.news.startsWith("WRONG"));
console.table(rows);
console.log(`\nCorrect: ${passed} of ${scored.length} scored messages (${rows.length - scored.length} judgement calls not scored).`);
console.log(`Re-checks with the right news searches: ${newsRows.filter((row) => row.news.startsWith("ok")).length} of ${newsRows.length}.`);
console.log(`Reached the fast model: ${modelTimes.length} of ${rows.length}. Median routing time for those: ${modelTimes[Math.floor((modelTimes.length - 1) / 2)] ?? 0} ms.`);
console.log(`Cost of this run: $${cost.toFixed(4)} on ${models.fast.name}.`);
