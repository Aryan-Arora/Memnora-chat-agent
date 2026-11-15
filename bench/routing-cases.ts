// Labelled messages for the routing check (bench/routing.ts). Each one says whether a web
// search should run. "either" marks judgement calls that are reported but not scored.
// `mustMention` checks that the query the router wrote is self-contained: it has to name the
// thing a pronoun or an earlier note refers to.
// "Today" in the check is Sunday 15 November 2026, so "Monday" is 9 November.
import type { MemoryNote, Message } from "../src/types.js";

export interface RoutingCase {
  text: string;
  want: "search" | "no" | "either";
  why: string;
  turns?: Pick<Message, "role" | "content">[];
  /** Notes already in memory. One with a `query` came from an answer that searched. */
  notes?: Pick<MemoryNote, "createdAt" | "topic" | "claim" | "query">[];
  mustMention?: RegExp;
  /** For a re-check: names that the news follow-up searches must cover, one search naming each. */
  newsFor?: string[];
  /** For a re-check: the most news searches that make sense. */
  maxNews?: number;
}

const crmTurns: RoutingCase["turns"] = [
  { role: "user", content: "Give me a shortlist of CRM tools for a small team." },
  { role: "assistant", content: "1. HubSpot Sales Hub Starter\n2. Pipedrive Lite\n3. Zoho CRM Standard" },
];
const nodeTurns: RoutingCase["turns"] = [
  { role: "user", content: "Which Node.js version should I use in production?" },
  { role: "assistant", content: "Use the current LTS line, Node.js 26." },
];
const nodeNote: RoutingCase["notes"] = [{
  createdAt: "2026-11-03T10:00:30.000Z", topic: "Node.js current LTS version",
  claim: "Node.js 26 is the current LTS, with end of life on 30 April 2029.",
}];
const crmNote: RoutingCase["notes"] = [{
  createdAt: "2026-11-09T10:00:30.000Z", topic: "CRM shortlist and starting prices",
  claim: "Freshsales Growth $9, Zoho CRM Standard $14, Pipedrive Lite $14, HubSpot Starter $20, Salesforce Starter Suite $25.",
}];

export const ROUTING_CASES: RoutingCase[] = [
  // ---- should search ----
  { text: "What is the latest stable version of Node.js?", want: "search", why: "version" },
  { text: "How much does HubSpot Starter cost per seat?", want: "search", why: "price" },
  { text: "Who is the CEO of OpenAI right now?", want: "search", why: "role holder" },
  { text: "How do I enable the Quantum Mode feature in Postgres 17?", want: "search", why: "feature that may not exist" },
  { text: "Does Supabase support branching on the free plan?", want: "search", why: "product feature" },
  { text: "What was the weather in Delhi yesterday?", want: "search", why: "dated world fact", mustMention: /delhi/i },
  { text: "Who won the F1 race on Sunday?", want: "search", why: "recent event" },
  { text: "Compare pricing of Notion, Coda and Airtable.", want: "search", why: "prices" },
  { text: "Is the Tavily search API free?", want: "search", why: "plan" },
  { text: "What's new in TypeScript 5.9?", want: "search", why: "release notes" },
  { text: "When does Node 22 reach end of life?", want: "search", why: "schedule" },
  { text: "Any news on the Databricks acquisition of Neon?", want: "search", why: "news" },
  { text: "How do I turn on dark mode in Slack?", want: "search", why: "product how-to" },
  { text: "What's the current price of Bitcoin?", want: "search", why: "price" },
  { text: "Which is cheaper for a small Postgres database, Render or Fly.io?", want: "search", why: "prices" },
  { text: "What are the visa requirements for Indian citizens visiting Japan?", want: "search", why: "rules change" },
  { text: "Is Claude Sonnet 5.5 available on Amazon Bedrock?", want: "search", why: "availability" },
  { text: "What time does the India vs Australia match start tomorrow?", want: "search", why: "schedule" },
  { text: "What is the population of India?", want: "search", why: "changes every year" },
  { text: "Hi, what does Pipedrive cost?", want: "search", why: "greeting plus a price question" },
  { text: "How much is the second one?", want: "search", why: "follow-up", turns: crmTurns, mustMention: /pipedrive/i },
  { text: "When was it released?", want: "search", why: "follow-up", turns: nodeTurns, mustMention: /node/i },
  { text: "Is that still the right version today?", want: "search", why: "follow-up re-check", turns: nodeTurns, mustMention: /node/i },
  { text: "I asked about Node.js LTS on 3 November. Is that still correct today?", want: "search", why: "re-check of a note that has no saved query", notes: nodeNote, mustMention: /node/i, newsFor: ["node"], maxNews: 2 },
  { text: "You shortlisted some CRM tools on Monday. Have any of those prices gone up?", want: "search", why: "re-check of a note that has no saved query", notes: crmNote, mustMention: /crm|hubspot|pipedrive|zoho|freshsales|salesforce/i, newsFor: ["hubspot", "pipedrive"] },
  { text: "I asked about Node.js LTS on 3 November. Is there a newer LTS line yet?", want: "search", why: "re-check of a note that has no saved query", notes: nodeNote, mustMention: /node/i, newsFor: ["node"], maxNews: 2 },
  {
    text: "What did I ask you on 3 November? Is your answer still correct today?",
    want: "search", why: "re-check of one product line: one news search, not one per model",
    notes: [{
      createdAt: "2026-11-03T10:00:30.000Z", topic: "Latest iPhone model and starting prices",
      claim: "iPhone 17e $599, iPhone 17 $799, iPhone Air $999, iPhone 17 Pro $1,099, iPhone 17 Pro Max $1,199.",
      query: "latest iPhone model price",
    }],
    newsFor: ["iphone"], maxNews: 2,
  },
  {
    text: "A shortlist of 5 CRM tools was made on Monday: has any changed pricing or shipped something big since?",
    want: "search", why: "re-check that reuses the saved query, plus news for each tool",
    notes: [{ ...crmNote[0], query: "CRM tools starting prices small team" }], mustMention: /^CRM tools starting prices small team$/,
    newsFor: ["freshsales", "zoho", "pipedrive", "hubspot", "salesforce"],
  },
  {
    text: "A shortlist of 5 CRM tools was made on Monday: are those prices still right?",
    want: "search", why: "legacy conversational query is repaired before it reaches search",
    notes: [{
      ...crmNote[0],
      query: "I shortlisted five CRM tools on Monday; have any of their prices changed since then? Please cite sources.",
    }],
    mustMention: /crm|hubspot|pipedrive|zoho|freshsales|salesforce/i,
    newsFor: ["hubspot", "pipedrive"],
  },
  {
    text: "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
    want: "search", why: "re-check where one tool is a common word: 'Close CRM', not 'Close'",
    notes: [{
      createdAt: "2026-11-09T10:00:30.000Z", topic: "CRM shortlist and pricing for 20-person sales team",
      claim: "Shortlist: Pipedrive, HubSpot Sales Hub, Zoho CRM, Close, Salesforce. Pipedrive is the pick for most 20-rep B2B teams.",
      query: "best CRM tools for 20-person sales team pricing 2026",
    }],
    newsFor: ["pipedrive", "hubspot", "zoho", "close crm", "salesforce"],
  },
  {
    text: "You shortlisted CRM tools on Monday. Has HubSpot shipped anything new since then?",
    want: "search", why: "re-check about one tool: news for that tool only",
    notes: [{ ...crmNote[0], query: "CRM tools starting prices small team" }], newsFor: ["hubspot"], maxNews: 2,
  },
  {
    text: "What did I ask you on 3 November, and is your answer still correct today?",
    want: "search", why: "re-check of one product: one news search, not one per version",
    notes: [{ ...nodeNote[0], claim: "Node.js 26 is the current LTS (end of life 30 April 2029). Node.js 24 and 22 are in Maintenance.", query: "current Node.js LTS version end of support date" }],
    mustMention: /^current Node\.js LTS version end of support date$/, newsFor: ["node"], maxNews: 2,
  },
  {
    text: "I asked about Postgres hosting last Tuesday: has any pricing changed since then?",
    want: "search", why: "re-check of prices: news for each provider",
    notes: [{
      createdAt: "2026-11-10T10:00:30.000Z", topic: "Managed Postgres pricing: Neon vs Supabase vs Render",
      claim: "Neon $0.106 per CU-hour, Supabase Pro $25 a month, Render Postgres from $6 a month.",
      query: "Neon vs Supabase vs Render managed Postgres pricing",
    }],
    newsFor: ["neon", "supabase", "render"],
  },
  // ---- should not search ----
  { text: "What is 17 * 23?", want: "no", why: "arithmetic" },
  { text: "Is 7 a prime number?", want: "no", why: "arithmetic" },
  { text: "Can you write a haiku about autumn?", want: "no", why: "writing" },
  { text: "What is recursion?", want: "no", why: "concept" },
  { text: "Are you an AI?", want: "no", why: "about the assistant" },
  { text: "Explain how a database index works.", want: "no", why: "concept" },
  { text: "How do I start a conversation with a stranger?", want: "no", why: "advice" },
  { text: "Summarize the plot of Hamlet in three sentences.", want: "no", why: "stable knowledge" },
  { text: "Translate 'good morning' into Spanish.", want: "no", why: "translation" },
  { text: "Rewrite this to sound more formal: hey, can u send me the file?", want: "no", why: "rewriting" },
  { text: "What is the capital of France?", want: "no", why: "stable fact" },
  { text: "Who wrote Pride and Prejudice?", want: "no", why: "stable fact" },
  { text: "What's the difference between TCP and UDP?", want: "no", why: "concept" },
  { text: "How do I reverse a list in Python?", want: "no", why: "general programming" },
  { text: "Give me three name ideas for a coffee shop.", want: "no", why: "brainstorming" },
  { text: "Should I learn guitar or piano first?", want: "no", why: "advice" },
  { text: "Why is the sky blue?", want: "no", why: "concept" },
  { text: "Write a press release for my bakery opening.", want: "no", why: "writing (the word 'release' used to trigger a search)" },
  { text: "What is the current in a 5 ohm resistor across 10 volts?", want: "no", why: "arithmetic (the word 'current' used to trigger a search)" },
  { text: "Explain price elasticity.", want: "no", why: "concept (the word 'price' used to trigger a search)" },
  { text: "Convert 5 miles to kilometres.", want: "no", why: "unit conversion" },
  { text: "What does HTTP status 404 mean?", want: "no", why: "stable fact" },
  { text: "What have we covered so far in this chat?", want: "no", why: "about this chat", turns: crmTurns },
  { text: "What was on the CRM shortlist from Monday?", want: "no", why: "answered by the recalled note", notes: crmNote },
  { text: "What did I ask you on 1 October?", want: "no", why: "about an earlier chat, nothing recalled" },
  { text: "What did I ask you on 3 November?", want: "no", why: "about an earlier chat", notes: nodeNote },
  { text: "Remind me what you said about Node.js on 3 November.", want: "no", why: "about an earlier chat", notes: nodeNote },
  { text: "Summarize my previous chat.", want: "no", why: "about an earlier chat" },
  { text: "Thanks, that helps!", want: "no", why: "thanks" },
  { text: "Hello!", want: "no", why: "greeting" },
  // ---- judgement calls, reported but not scored ----
  { text: "What did Apple announce before the iPhone 15?", want: "either", why: "history of a product" },
  { text: "Is Python still the best first language?", want: "either", why: "opinion with a factual side" },
  { text: "What are the side effects of ibuprofen?", want: "either", why: "stable, but worth sourcing" },
];
