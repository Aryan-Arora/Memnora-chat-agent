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
  /** Set when an earlier answer is being re-checked: the note whose saved query is reused. */
  recheckNote?: MemoryNote;
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
  // for like. Volatile notes (prices, versions) come first: they are what goes stale.
  const recheckNote = WANTS_FRESH.test(input.userText)
    ? input.notes.find((note) => note.volatility === "volatile" && note.query) ?? input.notes.find((note) => note.query)
    : undefined;
  if (recheckNote?.query) return { query: recheckNote.query, source: "stored query", recheckNote };

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
  const search = reply.match(/SEARCH:\s*(.+)/i);
  if (search) return { query: search[1].trim().replace(/^["'`]+|["'`]+$/g, ""), source: "model" };
  if (/^NO\b/i.test(reply)) return { query: "", source: "model" };
  // Fail toward searching: an empty, unreadable or failed reply must never mean "skip the web".
  return { query: input.userText.slice(0, 200), source: "model fallback" };
}
