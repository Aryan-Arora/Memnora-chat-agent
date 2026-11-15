import assert from "node:assert/strict";
import { test } from "node:test";
import { needsQueryRepair, parseFollowUps, pickRecheckNote, planFollowUps, planNamedItems, route, routerInput, type RouteInput } from "../src/agent/router.js";
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

test("a conversational legacy query is repaired while a concise query stays on the fast path", async () => {
  assert.equal(needsQueryRepair("CRM starting prices small team"), false);
  assert.equal(needsQueryRepair("I shortlisted five CRM tools on Monday; have any of their prices changed since?"), true);
  const fast = fakeFast("QUERY: HubSpot Pipedrive Zoho Freshsales Salesforce starting prices");
  const saved = note({ query: "I shortlisted five CRM tools on Monday; have any of their prices changed since?" });
  const decision = await route(fast.model, input("Are those prices still correct?", { notes: [saved] }));
  assert.deepEqual(decision, {
    query: "HubSpot Pipedrive Zoho Freshsales Salesforce starting prices",
    source: "stored query",
    recheckNote: saved,
  });
  assert.equal(fast.calls(), 1);
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

test("a note without a saved query is still the re-check note, and the model supplies the query", async () => {
  const withoutQuery = note({ query: undefined });
  const asked = "On Monday we shortlisted 5 CRM tools. Has any of them changed pricing since?";
  assert.deepEqual(
    await route(fakeFast("SEARCH: CRM tools pricing changes").model, input(asked, { notes: [withoutQuery] })),
    { query: "CRM tools pricing changes", source: "model", recheckNote: withoutQuery },
  );
  // An unreadable reply still searches, and still re-checks.
  assert.deepEqual(
    await route(fakeFast("hmm").model, input(asked, { notes: [withoutQuery] })),
    { query: asked, source: "model fallback", recheckNote: withoutQuery },
  );
  // If the model decides no search is needed there is nothing to re-check.
  assert.deepEqual(await route(fakeFast("NO").model, input(asked, { notes: [withoutQuery] })), { query: "", source: "model" });
});

test("a re-check worded without any freshness keyword is still a re-check when the model searches", async () => {
  const saved = note({ query: "CRM starting prices small team" });
  // "gone up" is in no keyword list. The saved query is not reused (the model is asked), but the note is re-checked.
  const decision = await route(fakeFast("SEARCH: HubSpot Pipedrive pricing").model, input("Have any of those prices gone up?", { notes: [saved] }));
  assert.deepEqual(decision, { query: "HubSpot Pipedrive pricing", source: "model", recheckNote: saved });
  // And when the model says no search is needed, nothing is re-checked.
  assert.deepEqual(
    await route(fakeFast("NO").model, input("What was on the shortlist from Monday?", { notes: [saved] })),
    { query: "", source: "model" },
  );
});

test("the re-check note is the best recalled one: with a query, then volatile, then any", () => {
  const stableWithQuery = note({ id: "a", volatility: "stable", query: "history" });
  const volatileNoQuery = note({ id: "b", query: undefined });
  const volatileWithQuery = note({ id: "c", query: "prices" });
  const stableNoQuery = note({ id: "d", volatility: "stable", query: undefined });
  assert.equal(pickRecheckNote([stableNoQuery, volatileNoQuery, stableWithQuery, volatileWithQuery])?.id, "c");
  assert.equal(pickRecheckNote([stableNoQuery, volatileNoQuery, stableWithQuery])?.id, "a");
  assert.equal(pickRecheckNote([stableNoQuery, volatileNoQuery])?.id, "b");
  assert.equal(pickRecheckNote([stableNoQuery])?.id, "d");
  assert.equal(pickRecheckNote([]), undefined);
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

test("a follow-up plan is cleaned to short names, and NONE or junk means no follow-ups", () => {
  for (const none of ["NONE", "No", "none.", ""]) assert.deepEqual(parseFollowUps(none), []);
  assert.deepEqual(
    parseFollowUps('1. HubSpot Sales Hub\n- "Pipedrive"\n* Zoho CRM\nNode.js'),
    ["HubSpot Sales Hub", "Pipedrive", "Zoho CRM", "Node.js"],
  );
  // Prose, JSON and router-style replies are not names.
  for (const junk of ['{"topic":"Acme"}', "SEARCH: Acme plan price", "Let me think about that.", "I think a search for each of these tools would help here."]) {
    assert.deepEqual(parseFollowUps(junk), []);
  }
  // At most five, without duplicates. A product whose name starts with "No" is still a name.
  assert.deepEqual(parseFollowUps("Notion\nb\nNotion\nc\nd\ne\nf"), ["Notion", "b", "c", "d", "e"]);
});

test("a failed follow-up plan means no follow-ups, not an error", async () => {
  const input = { userText: "Has anything shipped since?", note: note(), savedOn: "2026-11-09" };
  assert.deepEqual(await planFollowUps(fakeFast(new Error("network down")).model, input), []);
  assert.deepEqual(await planFollowUps(fakeFast("HubSpot\nPipedrive").model, input), ["HubSpot", "Pipedrive"]);
});

test("the planner for a message that names the products itself only returns names the message contains", async () => {
  const asked = "On Monday we shortlisted Acme CRM and Bolt. Has either shipped something since?";
  const input = { userText: asked, day: "2026-11-09" };
  // The model may only name what the user said: a product it added from its own knowledge is dropped.
  assert.deepEqual(await planNamedItems(fakeFast("Acme CRM\nBolt\nZenith CRM\nHubSpot").model, input), ["Acme CRM", "Bolt"]);
  // Matching is on the first word, case-insensitively, so a more precise name still counts.
  assert.deepEqual(await planNamedItems(fakeFast("ACME CRM Pro\nBolt CRM").model, input), ["ACME CRM Pro", "Bolt CRM"]);
  assert.deepEqual(await planNamedItems(fakeFast("NONE").model, input), []);
  assert.deepEqual(await planNamedItems(fakeFast("I would search for both of them.").model, input), []);
  assert.deepEqual(await planNamedItems(fakeFast(new Error("network down")).model, input), []);
  // The model is given the day and the message.
  let sent = "";
  const spy: ModelAdapter = { name: "spy", async complete(req) { sent = req.system + "\n" + req.messages[0].content; return "NONE"; }, async *stream() {} };
  await planNamedItems(spy, input);
  assert.match(sent, /^FOLLOW-UP SEARCHES\./);
  assert.match(sent, /The message refers to 2026-11-09\./);
  assert.match(sent, /On Monday we shortlisted Acme CRM and Bolt\./);
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
