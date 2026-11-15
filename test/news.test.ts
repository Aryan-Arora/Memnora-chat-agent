import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildNewsFilterPrompt, filterNews, happenedBefore, newsQuery, numberNews, parseNewsFilter, renderSince, searchNewsSince,
  type NewsItem, type NewsSearch,
} from "../src/agent/news.js";
import type { ModelAdapter, SearchResult, SearchTool } from "../src/types.js";

const result = (url: string, extra: Partial<SearchResult> = {}): SearchResult => ({
  title: `Acme news: ${url}`, url, snippet: "snippet", publishedAt: "Thu, 12 Nov 2026 09:00:00 GMT", ...extra,
});
const shortDate = (iso: string) => (iso ? "12 Nov" : "");

test("news searches use '<name> news', keep only results dated since the saved answer, and flag failures", async () => {
  const calls: { query: string; sinceDays?: number; maxResults?: number }[] = [];
  const search: SearchTool = {
    async search(query, opts) {
      calls.push({ query, ...(opts ?? {}) });
      if (query === "Broken news") throw new Error("search down");
      return [
        result("https://example.com/new"),
        result("https://example.com/old", { publishedAt: "Mon, 03 Mar 2025 09:00:00 GMT" }),
        result("https://example.com/undated", { publishedAt: undefined }),
        result("https://example.com/garbled", { publishedAt: "sometime last week" }),
        result("https://example.com/day-before", { publishedAt: "Sun, 08 Nov 2026 23:00:00 GMT" }), // inside the one-day slack
      ];
    },
  };
  const found = await searchNewsSince(search, ["Acme", "Broken"], new Date("2026-11-09T10:00:00Z"), new Date("2026-11-15T10:00:00Z"));
  assert.deepEqual(calls.map((c) => c.query), ["Acme news", "Broken news"]);
  assert.deepEqual(calls[0], { query: "Acme news", maxResults: 3, sinceDays: 7 });
  assert.deepEqual(found[0].results.map((r) => r.url), ["https://example.com/new", "https://example.com/day-before"]);
  assert.deepEqual(found[1], { name: "Broken", failed: true, results: [] });
  assert.equal(newsQuery("HubSpot Sales Hub"), "HubSpot Sales Hub news");
});

test("news results are numbered after the first part's sources and listed once", () => {
  const searches: NewsSearch[] = [
    { name: "Acme", failed: false, results: [result("https://example.com/a"), result("https://example.com/used")] },
    { name: "Bolt", failed: false, results: [result("https://example.com/a"), result("https://example.com/b")] },
  ];
  const items = numberNews(searches, 6, ["https://example.com/used"]);
  assert.deepEqual(items.map((item) => [item.n, item.name, item.result.url]), [
    [6, "Acme", "https://example.com/a"],
    [7, "Bolt", "https://example.com/b"],
  ]);
});

test("the filter's reply is validated: unknown kinds, unseen numbers and empty summaries are dropped", () => {
  const valid = new Set([2, 3, 4]);
  assert.deepEqual(
    parseNewsFilter('{"events":[{"ns":[2,3],"kind":"launch","summary":"Acme launched Autopilot [2]."}]}', valid),
    [{ ns: [2, 3], kind: "launch", summary: "Acme launched Autopilot." }],
  );
  // A fenced reply, a reply with words around it, and a single number instead of a list.
  assert.equal(parseNewsFilter('```json\n{"events":[]}\n```', valid)?.length, 0);
  assert.deepEqual(
    parseNewsFilter('Here you go: {"events":[{"ns":4,"kind":"price","summary":"Prices rose."}]} Done.', valid),
    [{ ns: [4], kind: "price", summary: "Prices rose." }],
  );
  const mixed = parseNewsFilter(JSON.stringify({ events: [
    { ns: [2], kind: "review", summary: "Not a valid kind." },
    { ns: [9], kind: "launch", summary: "Number the filter was never shown." },
    { ns: [3], kind: "launch", summary: "   " },
    { ns: [3, 9, 2, 4, 2], kind: "company", summary: "Kept, with only the shown numbers." },
    { ns: [4], kind: "launch", summary: "Result 4 is already cited by the previous event." },
  ] }), valid);
  assert.deepEqual(mixed, [{ ns: [3, 2, 4], kind: "company", summary: "Kept, with only the shown numbers." }]);
  // Unreadable is null (the section says so); readable with no events is [].
  for (const bad of ["", "not json", '{"results":[]}', '{"events":"none"}']) assert.equal(parseNewsFilter(bad, valid), null);
});

test("an event the filter dates before the saved day is dropped by code; unknown dates are kept", async () => {
  // Month-only dates count as the whole month. Full dates get one day of slack.
  assert.equal(happenedBefore("2026-04", "2026-11-09"), true);
  assert.equal(happenedBefore("2026-11", "2026-11-09"), false);
  assert.equal(happenedBefore("2026-11-07", "2026-11-09"), true);
  assert.equal(happenedBefore("2026-11-08", "2026-11-09"), false);
  assert.equal(happenedBefore("2026-11-12", "2026-11-09"), false);
  assert.equal(happenedBefore("unknown", "2026-11-09"), false);
  assert.equal(happenedBefore(undefined, "2026-11-09"), false);

  const parsed = parseNewsFilter(JSON.stringify({ events: [
    { ns: [2], kind: "company", happened: "2026-11-12", summary: "New CEO." },
    { ns: [3], kind: "price", happened: "2026-04", summary: "Moved to pay-per-result pricing in April." },
    { ns: [4], kind: "launch", happened: "last spring", summary: "Unreadable date is not kept as a date." },
  ] }), new Set([2, 3, 4]));
  assert.deepEqual(parsed?.map((event) => event.happened), ["2026-11-12", "2026-04", undefined]);

  // filterNews applies it: the April event is gone, the other two stay.
  const model: ModelAdapter = {
    name: "dated-filter-test",
    async complete() { return JSON.stringify({ events: [
      { ns: [2], kind: "company", happened: "2026-11-12", summary: "New CEO." },
      { ns: [3], kind: "price", happened: "2026-04", summary: "Moved to pay-per-result pricing in April." },
      { ns: [4], kind: "launch", happened: "unknown", summary: "Shipped a feature." },
    ] }); },
    async *stream() { /* unused */ },
  };
  const items = [2, 3, 4].map((n) => ({ n, name: "Acme", result: result(`https://example.com/${n}`) }));
  const kept = await filterNews(model, { topic: "t", savedOn: "2026-11-09", question: "q", items, shortDate });
  assert.deepEqual(kept?.map((event) => event.ns[0]), [2, 4]);
});

test("an event whose cited pages never mention the searched company is dropped", async () => {
  const items = [
    { n: 2, name: "Neon Postgres", result: result("https://example.com/xata", { title: "ClickHouse buys Xata", content: "The Berlin agent-native Postgres company joins ClickHouse." }) },
    { n: 3, name: "Neon Postgres", result: result("https://example.com/neon", { title: "Neon adds branching", content: "neon launched a new feature." }) },
    { n: 4, name: "HubSpot Sales Hub", result: result("https://example.com/hub", { title: "HubSpot names CEO", content: "x" }) },
  ];
  const model: ModelAdapter = {
    name: "wrong-company-test",
    async complete() { return JSON.stringify({ events: [
      { ns: [2], kind: "company", happened: "2026-11-10", summary: "ClickHouse acquired Xata." },
      { ns: [3], kind: "launch", happened: "2026-11-12", summary: "Neon added branching." },
      { ns: [2, 4], kind: "company", happened: "2026-11-12", summary: "Kept: one cited page does name HubSpot." },
    ] }); },
    async *stream() { /* unused */ },
  };
  const kept = await filterNews(model, { topic: "t", savedOn: "2026-11-09", question: "q", items, shortDate });
  assert.deepEqual(kept?.map((event) => event.summary), ["Neon added branching.", "Kept: one cited page does name HubSpot."]);
});

test("the section is written by code: events, then products with nothing, then failures", () => {
  const items: NewsItem[] = [
    { n: 6, name: "HubSpot", result: result("https://example.com/h") },
    { n: 7, name: "Zoho CRM", result: result("https://example.com/z") },
  ];
  const searches: NewsSearch[] = [
    { name: "HubSpot", failed: false, results: [items[0].result] },
    { name: "Zoho CRM", failed: false, results: [items[1].result] },
    { name: "Close", failed: false, results: [] },
    { name: "Salesforce", failed: false, results: [] },
    { name: "Pipedrive", failed: true, results: [] },
  ];
  const text = renderSince({
    savedOn: "2026-11-09", searches, items, shortDate,
    events: [
      { ns: [6], kind: "company", summary: "Co-founder Brian Halligan returns as CEO." },
      { ns: [7, 99], kind: "launch", summary: "Zoho released a rebuilt Campaigns platform, a separate product from Zoho CRM." },
    ],
  });
  assert.equal(text, [
    "## Since 2026-11-09",
    "",
    "- **HubSpot** (company news, 12 Nov): Co-founder Brian Halligan returns as CEO. [6]",
    "- **Zoho CRM** (launch, 12 Nov): Zoho released a rebuilt Campaigns platform, a separate product from Zoho CRM. [7][99]",
    "- Nothing found for Close and Salesforce.",
    "- Could not check Pipedrive: the search failed.",
  ].join("\n"));
  assert.equal(
    renderSince({ savedOn: "2026-11-09", searches: [], items: [], events: null, shortDate }),
    "## Since 2026-11-09\n\n- I could not check what has happened since: the news step failed.",
  );
  assert.equal(
    renderSince({ savedOn: "2026-11-09", searches: [{ name: "Acme", failed: false, results: [] }], items: [], events: [], shortDate }),
    "## Since 2026-11-09\n\n- Nothing found for Acme.",
  );
});

test("the filter is not called without results, and a failing model gives null instead of an error", async () => {
  let calls = 0;
  const prompts: string[] = [];
  const model = (reply: string | Error): ModelAdapter => ({
    name: "filter-test",
    async complete(req) { calls += 1; prompts.push(req.messages[0].content); if (reply instanceof Error) throw reply; return reply; },
    async *stream() { /* unused */ },
  });
  const input = {
    topic: "CRM shortlist", savedOn: "2026-11-09", question: "Has anything shipped?", shortDate,
    items: [{ n: 2, name: "Acme", result: result("https://www.example.com/a", { content: "x".repeat(2000) }) }],
  };
  assert.deepEqual(await filterNews(model("{}"), { ...input, items: [] }), []);
  assert.equal(calls, 0);
  assert.equal(await filterNews(model(new Error("down")), input), null);
  assert.deepEqual(await filterNews(model('{"events":[{"ns":[2],"kind":"launch","summary":"Acme shipped it."}]}'), input), [
    { ns: [2], kind: "launch", summary: "Acme shipped it." },
  ]);
  // The prompt carries the topic, the question, the search name, the host and a bounded amount of text.
  const prompt = buildNewsFilterPrompt(input);
  assert.match(prompt, /about "CRM shortlist" and was saved on 2026-11-09/);
  assert.match(prompt, /The user's question: Has anything shipped\?/);
  assert.match(prompt, /\[2\] searched for: Acme \| example\.com \| published 12 Nov/);
  assert.ok(prompt.length < 1200, "long page text is cut");
});
