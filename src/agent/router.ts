// Routing: does this message need a web search, and if so, what should we search for?
//
// Two rules cover the cases code can be sure about. Everything else is one short call to
// the fast model, which sees today's date, the last few turns and any recalled memory notes.
//
// Keyword rules used to decide much more ("starts with What/Is/Can", "mentions a date") and
// they misfired both ways. On 57 labelled messages (bench/routing.ts) they got 38 right:
// "What is 17 * 23?" ran a web search, "Who won the F1 race on Sunday?" did not, and the raw
// sentence was sent to the search engine as the query 30 times. The model call got all 57
// right (2026-11-15) and costs about one second on the messages that reach it.
//
// A rule may only fail in the harmless direction. A needless search wastes a second; a
// skipped search presents a stale answer as checked. So no rule here ever says "do not
// search" on the strength of keywords, apart from a message that is only a greeting.
import type { MemoryNote, Message, ModelAdapter, Usage } from "../types.js";

export const ROUTER_SYSTEM = `ROUTER. Decide whether a chat assistant should run one web search before it answers the latest user message.
Reply with exactly one line: NO, or SEARCH: <query>.

SEARCH when a good answer depends on facts from outside this conversation that can change, or that you cannot be sure of:
- prices, plans, versions, release dates, schedules, scores, weather, news and other recent events
- who holds a role now, or what a company, product, service or law currently offers or requires
- whether a named product, tool or API has a particular feature, setting or limit, including "how do I ..." questions about one. The feature may not exist, so check.
- a request to verify, re-check or update something said earlier

NO when a search cannot improve the answer:
- arithmetic, unit conversion, logic, definitions and explanations of well-established concepts
- facts that do not change: capitals, authors, historical events, physical constants
- general programming questions that do not depend on a specific product or version
- writing, rewriting, translating, summarizing supplied text, brainstorming, opinions and personal advice
- greetings, thanks, questions about the assistant itself, and questions about what was said in this chat or an earlier one

If you are unsure, SEARCH.

Write the query the way you would type it into a search engine: short, specific and self-contained. Replace "it", "they", "the second one" and similar with the names they refer to, taken from the conversation or the memory notes. Do not add the current year or month to the query. Include a date only when the question is about one, such as yesterday's weather.`;

// How a product is named for a news search, shared by both planners below so they cannot drift.
const NAMING_RULES = `Make each name precise enough to be unambiguous: "Render Postgres", not "Render"; "Neon Postgres", not "Neon"; "Close CRM", not "Close" (a bare common word returns unrelated news).
Models, versions or plans of one product line are a single item: write "Node.js" for Node.js 26, 24 and 22; "iPhone" for iPhone 17, 17 Pro and Air; "Windows" for Windows 10 and 11.`;

export const FOLLOW_UP_SYSTEM = `FOLLOW-UP SEARCHES. An earlier answer is being re-checked. The search that produced it will be run again, to compare the saved values with today's. A news search will also run for each product or company involved, to show what has happened since the answer was saved.
Reply with up to 5 lines and nothing else: the name of each product or company in the saved note that the user's message is about, one per line.
${NAMING_RULES}
Reply NONE if the user's message is not about anything in the saved note, or if the note names no specific product or company.`;

export const NAMED_ITEMS_SYSTEM = `FOLLOW-UP SEARCHES. The user's message refers to an earlier day and may ask what has happened since then. A news search will run for each product or company the message names, to show what has happened since that day.
Reply with up to 5 lines and nothing else: the name of each product or company that the message itself names, one per line. Never add one the message does not mention.
${NAMING_RULES}
Reply NONE unless the message asks whether anything has changed, shipped, launched, been announced or become newer since that day. A message that only mentions the day, or asks how something works or what it is, is NONE. Also NONE if it names no specific product or company.`;

const QUERY_REPAIR_SYSTEM = `SEARCH QUERY REPAIR. A saved memory contains a legacy web query written as conversational prose. Rewrite it as one concise, self-contained search-engine query that will find the same facts again today.
Reply with exactly one line: QUERY: <query>.
Keep product names and the fact being checked. Remove first-person wording, chat references, dates that only describe when the conversation happened, and requests such as "cite sources". Do not answer the question.`;

// The user wants today's state of something, not only what was said: "still", "changed", "now".
const WANTS_FRESH = /\b(re-?check|verify|changed?|changes|still|now|current|currently|latest|today|since|updated?|up to date)\b/i;
// A message that is only a greeting or thanks. "Hi, what does X cost?" must not match.
const GREETING = /^\s*(?:hi|hello|hey|thanks|thank you|thx|good (?:morning|afternoon|evening|night))(?:\s+(?:there|again|so much|a lot))?[\s!.,]*$/i;

export interface RouteInput {
  userText: string;
  /** The user's local date, for example "Sunday 2026-11-15", so "yesterday" can become a date. */
  today: string;
  /** Recent turns of this chat, oldest first, so "the second one" can be resolved. */
  recentTurns: Pick<Message, "role" | "content">[];
  /** Notes recalled for this message. A re-check reuses the query saved on one of them. */
  notes: MemoryNote[];
}

export interface Route {
  /** Empty means "answer without searching". */
  query: string;
  /** Which rule decided. Shown in the server log and checked by the tests. */
  source: "stored query" | "greeting rule" | "model" | "model fallback";
  /** Set when an earlier answer is being re-checked: notes were recalled and a search will run.
   *  The note's saved query is reused when the message asks about its state today; otherwise
   *  the model wrote the query. Either way the re-check gets the "since" news. */
  recheckNote?: MemoryNote;
}

/** The recalled note to re-check. One with a saved query comes first (the same search can be
 *  run again), volatile before stable (prices and versions are what goes stale). A note
 *  without a query still counts: the earlier answer may have been written without searching. */
export function pickRecheckNote(notes: MemoryNote[]): MemoryNote | undefined {
  return notes.find((note) => note.volatility === "volatile" && note.query)
    ?? notes.find((note) => note.query)
    ?? notes.find((note) => note.volatility === "volatile")
    ?? notes[0];
}

/** New notes contain short router-written queries. Older notes may contain the user's whole
 * sentence. Repair only unmistakable legacy prose so a good hand-written query is untouched. */
export function needsQueryRepair(query: string): boolean {
  const words = query.trim().split(/\s+/).filter(Boolean);
  return query.length > 120 || words.length > 12 || /[?\n]/.test(query) ||
    /\b(i|we|you)\s+(?:asked|discussed|shortlisted|compared|said|told)\b/i.test(query) ||
    /^\s*(?:what|which|who|when|where|why|how|is|are|was|were|has|have|did|do|does|can|could|would|should)\b/i.test(query);
}

async function repairStoredQuery(
  fast: ModelAdapter,
  note: MemoryNote,
  userText: string,
  onUsage?: (usage: Usage) => void,
): Promise<string> {
  if (!note.query || !needsQueryRepair(note.query)) return note.query ?? "";
  try {
    const reply = (await fast.complete({
      system: QUERY_REPAIR_SYSTEM,
      messages: [{
        role: "user",
        content: `Memory topic: ${note.topic}\nSaved claim: ${note.claim.slice(0, 600)}\nLegacy query: ${note.query}\nCurrent re-check request: ${userText}`,
      }],
      maxTokens: 300,
      effort: "low",
      ...(onUsage ? { onUsage } : {}),
    })).trim();
    const repaired = reply.match(/^QUERY:\s*(.+)$/i)?.[1]
      ?.trim().replace(/^["'`]+|["'`]+$/g, "");
    return repaired && repaired.length <= 200 && !/[?\n]/.test(repaired) ? repaired : note.query;
  } catch (error) {
    console.warn("[router] saved query repair failed:", error instanceof Error ? error.message : error);
    return note.query;
  }
}

/** Everything the fast model sees, as one message. Kept as one message, not real chat turns:
 *  given real turns a chatty model answers the user instead of classifying. */
export function routerInput(input: RouteInput): string {
  const notes = input.notes.slice(0, 3)
    .map((note) => `[${note.createdAt.slice(0, 10)}] ${note.topic}: ${note.claim.slice(0, 300)}`)
    .join("\n");
  const turns = input.recentTurns.slice(-4)
    .map((turn) => `${turn.role}: ${turn.content.slice(0, 300)}`)
    .join("\n");
  return [
    `Today is ${input.today}.`,
    notes && `Memory notes recalled for this message:\n${notes}`,
    turns && `Recent conversation:\n${turns}`,
    `Latest user message:\n${input.userText}`,
    "Reply now with exactly NO or SEARCH: <query>.",
  ].filter(Boolean).join("\n\n");
}

export async function route(
  fast: ModelAdapter,
  input: RouteInput,
  onUsage?: (usage: Usage) => void,
): Promise<Route> {
  // Rule 1: re-check. A recalled note has the query that produced the old answer, and the
  // user asks about its state today. Run that same query again, so the comparison is like
  // for like.
  const recheckNote = WANTS_FRESH.test(input.userText) ? pickRecheckNote(input.notes) : undefined;
  if (recheckNote?.query) {
    const query = await repairStoredQuery(fast, recheckNote, input.userText, onUsage);
    return { query, source: "stored query", recheckNote };
  }

  // Rule 2: a message that is only a greeting has nothing to look up.
  if (GREETING.test(input.userText)) return { query: "", source: "greeting rule" };

  // Everything else: ask the fast model. "low" effort because the reply is one line; measured
  // at about 1.1 seconds, the same as with reasoning switched off. The token ceiling is
  // generous because part of it can go to hidden reasoning: at 80 the reply came back empty.
  let reply = "";
  try {
    reply = (await fast.complete({
      system: ROUTER_SYSTEM,
      messages: [{ role: "user", content: routerInput(input) }],
      maxTokens: 400,
      effort: "low",
      ...(onUsage ? { onUsage } : {}),
    })).trim();
  } catch (error) {
    console.warn("[router] model call failed:", error instanceof Error ? error.message : error);
  }
  // Notes were recalled and the model chose to search: the user wants today's state of that
  // earlier answer, however they worded it ("have any of those gone up?"). So this is a
  // re-check too, with the model's query, and it gets the same "since" news as one that reuses
  // a saved query. A keyword list cannot catch every wording; the follow-up planner answers
  // NONE if the message turns out to be about something else.
  const earlier = pickRecheckNote(input.notes);
  const recheck = earlier ? { recheckNote: earlier } : {};
  const search = reply.match(/SEARCH:\s*(.+)/i);
  if (search) return { query: search[1].trim().replace(/^["'`]+|["'`]+$/g, ""), source: "model", ...recheck };
  if (/^NO\b/i.test(reply)) return { query: "", source: "model" };
  // Fail toward searching: an empty, unreadable or failed reply must never mean "skip the web".
  return { query: input.userText.slice(0, 200), source: "model fallback", ...recheck };
}

export interface FollowUpInput {
  userText: string;
  /** The note being re-checked. */
  note: Pick<MemoryNote, "topic" | "claim">;
  /** The day that note was saved, as the user would write it: "2026-11-09". */
  savedOn: string;
}

/** Turns the fast model's reply into at most five item names. Anything that is not a short
 *  name (prose, JSON, a "SEARCH:" line) is a reply we did not ask for and is dropped. */
export function parseFollowUps(reply: string): string[] {
  const lines = reply.split("\n")
    .map((line) => line.trim().replace(/^(?:[-*•]|\d+[.)])\s*/, "").replace(/^["'`]+|["'`]+$/g, "").trim())
    .filter(Boolean);
  if (!lines.length || /^(none|no|n\/a)[.!]?$/i.test(lines[0])) return [];
  const names = lines.filter((line) => {
    const words = line.split(/\s+/).length;
    // "Salesforce Inc." is a name; a longer line that ends like a sentence is not.
    return line.length <= 60 && words <= 6 && !/[{}[\]:]/.test(line) && !/[?!]$/.test(line) && !(line.endsWith(".") && words > 3);
  });
  return [...new Set(names)].slice(0, 5);
}

/** A re-check can ask about more than the saved values: "...or shipped something big since?".
 *  Re-running the saved query cannot answer that. So the fast model names the products or
 *  companies the question is about, and the loop runs one dated news search for each. The
 *  model only names things; the search wording is fixed in code. Returns [] when there is
 *  nothing to name, or when the call fails: the answer then covers the saved values only. */
export async function planFollowUps(
  fast: ModelAdapter,
  input: FollowUpInput,
  onUsage?: (usage: Usage) => void,
): Promise<string[]> {
  try {
    const base = `Saved on ${input.savedOn}: ${input.note.topic}: ${input.note.claim.slice(0, 600)}\n\nLatest user message:\n${input.userText}`;
    const ask = (content: string) => fast.complete({
      system: FOLLOW_UP_SYSTEM, messages: [{ role: "user", content }], maxTokens: 400,
      effort: "low", ...(onUsage ? { onUsage } : {}),
    });
    const names = parseFollowUps(await ask(`${base}\n\nReply now with NONE or the names, one per line.`));
    if (names.length) return names;
    // A short classifier occasionally replies NONE even when the note visibly names products.
    // Retry once with the contradiction made explicit; the normal path still costs one call.
    return parseFollowUps(await ask(
      `${base}\n\nYour first reply named nothing. Re-read the saved topic and claim, and the user's message. ` +
      `If the message asks about any product, company or product line that the note names, list those names now, one per line. ` +
      `Reply NONE if it does not.`,
    ));
  } catch (error) {
    console.warn("[router] follow-up planning failed:", error instanceof Error ? error.message : error);
    return [];
  }
}

export interface NamedItemsInput {
  userText: string;
  /** The day the message refers to, as the user would write it: "2026-11-09". */
  day: string;
}

/** A question can give the day and the products itself, with no earlier answer to recall:
 *  "On Monday we shortlisted HubSpot, Pipedrive and Zoho. Has any of them shipped something
 *  since?" The fast model names what the message names (NONE if it is not asking what has
 *  happened since), and the loop runs the same dated news searches as for a re-check. Code
 *  drops a name whose first word is not in the message, so the model can only name what the
 *  user said, never guess what they meant. Returns [] on failure. */
export async function planNamedItems(
  fast: ModelAdapter,
  input: NamedItemsInput,
  onUsage?: (usage: Usage) => void,
): Promise<string[]> {
  try {
    const names = parseFollowUps(await fast.complete({
      system: NAMED_ITEMS_SYSTEM,
      messages: [{
        role: "user",
        content: `The message refers to ${input.day}.\n\nUser's message:\n${input.userText}\n\nReply now with NONE or the names, one per line.`,
      }],
      maxTokens: 400,
      effort: "low",
      ...(onUsage ? { onUsage } : {}),
    }));
    const message = input.userText.toLowerCase();
    return names.filter((name) => message.includes(name.split(/\s+/)[0].toLowerCase()));
  } catch (error) {
    console.warn("[router] named-item planning failed:", error instanceof Error ? error.message : error);
    return [];
  }
}
