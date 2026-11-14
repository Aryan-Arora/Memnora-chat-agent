import assert from "node:assert/strict";
import { test } from "node:test";
import { route, routerInput, type RouteInput } from "../src/agent/router.js";
import type { MemoryNote, ModelAdapter } from "../src/types.js";

/** A fast model that always gives the same reply (or always fails), and counts its calls. */
function fakeFast(reply: string | Error) {
  let calls = 0;
  const model: ModelAdapter = {
    name: "router-test",
    async complete() {
      calls += 1;
      if (reply instanceof Error) throw reply;
      return reply;
    },
    async *stream() { /* the router never streams */ },
  };
  return { model, calls: () => calls };
}

const input = (userText: string, extra: Partial<RouteInput> = {}): RouteInput =>
  ({ userText, today: "Sunday 2026-11-15", recentTurns: [], notes: [], ...extra });

const note = (extra: Partial<MemoryNote> = {}): MemoryNote => ({
  id: "n", conversationId: "earlier", createdAt: "2026-11-09T10:00:00Z", topic: "CRM starting prices",
  claim: "HubSpot Starter costs $20 per seat.", sources: [], volatility: "volatile", ...extra,
});

test("a re-check reuses the saved query and does not call the model", async () => {
  const fast = fakeFast("NO");
  const saved = note({ query: "CRM starting prices small team" });
  const decision = await route(fast.model, input("Has any of them changed pricing since Monday?", { notes: [saved] }));
  assert.deepEqual(decision, { query: "CRM starting prices small team", source: "stored query", recheckNote: saved });
  assert.equal(fast.calls(), 0);
});

test("a recalled note is not re-checked unless the user asks about its state today", async () => {
  const fast = fakeFast("NO");
  const decision = await route(fast.model, input("What was on the shortlist from Monday?", { notes: [note({ query: "CRM starting prices" })] }));
  assert.deepEqual(decision, { query: "", source: "model" });
  assert.equal(fast.calls(), 1);
});

test("a volatile note is preferred over a stable one for the re-check", async () => {
  const stable = note({ id: "stable", volatility: "stable", query: "history of CRM software" });
  const volatile = note({ id: "volatile", query: "CRM starting prices" });
  const decision = await route(fakeFast("NO").model, input("Is that still right today?", { notes: [stable, volatile] }));
  assert.equal(decision.query, "CRM starting prices");
});

test("only a bare greeting skips the model", async () => {
  const fast = fakeFast("SEARCH: Pipedrive pricing");
  assert.deepEqual(await route(fast.model, input("Thanks so much!")), { query: "", source: "greeting rule" });
  assert.equal(fast.calls(), 0);
  assert.deepEqual(await route(fast.model, input("Hi, what does Pipedrive cost?")), { query: "Pipedrive pricing", source: "model" });
  assert.equal(fast.calls(), 1);
});

test("the model's query is used with quotes stripped, and NO means no search", async () => {
  assert.deepEqual(await route(fakeFast('SEARCH: "current Node.js LTS version"').model, input("Which Node should I use?")),
    { query: "current Node.js LTS version", source: "model" });
  assert.deepEqual(await route(fakeFast("NO").model, input("What is 17 * 23?")), { query: "", source: "model" });
});

test("an empty, unreadable or failed reply falls back to searching the raw message", async () => {
  const question = "How do I enable the Quantum Mode feature in Postgres 17?";
  for (const reply of ["", "I think a search would help here.", new Error("network down")]) {
    assert.deepEqual(await route(fakeFast(reply).model, input(question)), { query: question, source: "model fallback" });
  }
});

test("the router sees today's date, recalled notes and recent turns", () => {
  const text = routerInput(input("How much is the second one?", {
    notes: [note()],
    recentTurns: [{ role: "user", content: "Shortlist some CRM tools" }, { role: "assistant", content: "1. HubSpot 2. Pipedrive" }],
  }));
  assert.match(text, /^Today is Sunday 2026-11-15\./);
  assert.match(text, /\[2026-11-09\] CRM starting prices: HubSpot Starter costs \$20 per seat\./);
  assert.match(text, /assistant: 1\. HubSpot 2\. Pipedrive/);
  assert.match(text, /Latest user message:\nHow much is the second one\?\n\nReply now/);
});
