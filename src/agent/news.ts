// "What has happened since?" for a re-check. Three steps, each with one job:
//   1. searchNewsSince: one dated news search per product, in parallel. Code drops anything
//      undated or older than the saved answer, so an old page can never be passed off as new.
//   2. filterNews: the fast model decides which of the surviving results report a real event
//      by that product's maker, and returns it as structured data, not prose.
//   3. renderSince: code writes the section from that data.
//
// Why the answer model does not write this section: when it did, it described reviews and
// marketing reports as launches ("released its ROI report") and explained the results it had
// been told to leave out. Here a rejected result never reaches a writer, a citation can only
// point at a result the filter was shown, and the section costs one small model call instead
// of a second full answer.
import type { ModelAdapter, SearchResult, SearchTool, Usage } from "../types.js";

const DAY_MS = 86_400_000;

export interface NewsSearch {
  /** The product or company this search was for, as named by the planner. */
  name: string;
  /** Results dated on or after the saved answer. */
  results: SearchResult[];
  failed: boolean;
}

export interface NewsItem {
  /** Citation number: continues from the first part's sources, so [n] is unique per answer. */
  n: number;
  name: string;
  result: SearchResult;
}

export type EventKind = "price" | "launch" | "company";

export interface NewsEvent {
  /** Every result that reports this event, at most three. */
  ns: number[];
  kind: EventKind;
  summary: string;
  /** When the event itself happened ("2026-11-12" or "2026-11"), as the filter read it from the
   *  result's text. Absent when the result does not say. */
  happened?: string;
}

/** "<name> news" returned relevant items for every product tried; "<name> pricing change" and
 *  "<name> product launch" each missed some, and "<name> announcement" returned unrelated pages. */
export const newsQuery = (name: string) => `${name} news`;

export async function searchNewsSince(
  search: SearchTool,
  names: string[],
  savedAt: Date,
  now: Date,
): Promise<NewsSearch[]> {
  const sinceDays = Math.max(1, Math.ceil((now.getTime() - savedAt.getTime()) / DAY_MS) + 1);
  const cutoff = savedAt.getTime() - DAY_MS; // one day of slack: publication dates carry no time zone
  return Promise.all(names.map(async (name): Promise<NewsSearch> => {
    try {
      const found = await search.search(newsQuery(name), { maxResults: 3, sinceDays });
      return { name, failed: false, results: found.filter((r) => r.publishedAt && Date.parse(r.publishedAt) >= cutoff) };
    } catch (error) {
      console.error("[search] follow-up failed:", error instanceof Error ? error.message : error);
      return { name, failed: true, results: [] };
    }
  }));
}

/** Flattens the searches into one numbered list. A page already used by the first part, or
 *  returned by two searches, appears once. */
export function numberNews(searches: NewsSearch[], firstNumber: number, usedUrls: Iterable<string>): NewsItem[] {
  const seen = new Set(usedUrls);
  const items: NewsItem[] = [];
  let n = firstNumber;
  for (const { name, results } of searches) {
    for (const result of results) {
      if (seen.has(result.url)) continue;
      seen.add(result.url);
      items.push({ n: n++, name, result });
    }
  }
  return items;
}

export const NEWS_FILTER_SYSTEM = `NEWS FILTER. A user asked what has happened since an earlier answer was saved. You get numbered news results, each found by searching for one product or company, all published on or after the saved answer.
Pick out the results that report a real event, by the company that makes that product, that bears on the user's question. Reply with JSON only:
{"events":[{"ns":[7,8],"kind":"launch","happened":"2026-11-12","summary":"..."}]}
"kind" is one of:
- "price": a price, plan or packaging change
- "launch": a new product, feature, version or release that customers can use
- "company": an acquisition, funding round, leadership change, layoffs, outage or security incident
"happened" is when the event itself happened, read from the result's text, not the date the page was published: "YYYY-MM-DD", or "YYYY-MM" if only the month is known, or "unknown" if the result does not say. The event must be new: it happened on or after the saved date. A page published after that date can still describe something older, such as a roundup, a hub page of all the news about a product, an explainer, or a passing mention of an earlier change. Those are not events.
Not events: reviews, comparisons, buying guides, how-tos, interviews, opinion pieces, case studies, customer stories, webinars, reports and other marketing content; stock-price or earnings coverage that announces none of the three kinds above; third-party integration, plugin or marketplace pages; rumours and leaks about future products; anything about a company other than the one searched for; and events that have nothing to do with the user's question.
If several results report the same event, list it once with every result number in "ns" (at most 3). If the event is about a different product of the same company, say which product in the summary. Write each summary as one plain sentence of at most 30 words, using only what the results state. Keep words such as "reported" or "plans to" when the result does not show the company itself confirming it.
If no result reports an event, reply {"events":[]}.`;

export interface NewsFilterInput {
  /** What the earlier answer was about, from its note. Absent when the user named the day and
   *  the products themselves and no earlier answer was saved. */
  topic?: string;
  savedOn: string;
  question: string;
  items: NewsItem[];
  shortDate: (iso: string) => string;
}

export function buildNewsFilterPrompt(input: NewsFilterInput): string {
  const results = input.items.map(({ n, name, result }) => {
    let host = "";
    try { host = new URL(result.url).hostname.replace(/^www\./, ""); } catch { /* an odd URL only loses its host */ }
    const text = (result.content ?? result.snippet).replace(/\s+/g, " ").slice(0, 600);
    return `[${n}] searched for: ${name} | ${host} | published ${input.shortDate(result.publishedAt ?? "")}\n${result.title}\n${text}`;
  });
  return [
    input.topic
      ? `The earlier answer was about "${input.topic}" and was saved on ${input.savedOn}.`
      : `The saved date is ${input.savedOn}: the user named that day in their question, and no earlier answer was saved.`,
    `The user's question: ${input.question}`,
    `News results:\n\n${results.join("\n\n")}`,
    "Reply now with the JSON only.",
  ].join("\n\n");
}

function parseJsonLoose(raw: string): unknown {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(text); } catch { /* fall through: some models add words around the JSON */ }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  try { return JSON.parse(text.slice(first, last + 1)); } catch { return null; }
}

/** Validates the filter's reply before it crosses into the answer. Returns null when the
 *  reply cannot be read at all, and [] when it is readable and reports no event. A result
 *  number the filter was never shown, an unknown kind, or an empty summary drops that event. */
export function parseNewsFilter(raw: string, valid: ReadonlySet<number>): NewsEvent[] | null {
  const value = parseJsonLoose(raw);
  const list = value && typeof value === "object" ? (value as { events?: unknown }).events : undefined;
  if (!Array.isArray(list)) return null;
  const events: NewsEvent[] = [];
  const cited = new Set<number>();
  for (const entry of list.slice(0, 12)) {
    if (!entry || typeof entry !== "object") continue;
    const { ns: rawNs, kind, summary: rawSummary, happened: rawHappened } =
      entry as { ns?: unknown; kind?: unknown; summary?: unknown; happened?: unknown };
    if (kind !== "price" && kind !== "launch" && kind !== "company") continue;
    const ns = [...new Set((Array.isArray(rawNs) ? rawNs : [rawNs]).filter(
      (n): n is number => typeof n === "number" && Number.isInteger(n) && valid.has(n) && !cited.has(n),
    ))].slice(0, 3);
    // The summary never carries its own citation: the numbers come from `ns`.
    const summary = typeof rawSummary === "string"
      ? rawSummary.replace(/\s*\[\d+\]/g, "").replace(/\s+/g, " ").trim().slice(0, 260)
      : "";
    if (!ns.length || !summary) continue;
    ns.forEach((n) => cited.add(n));
    const happened = typeof rawHappened === "string" && /^\d{4}-\d{2}(-\d{2})?$/.test(rawHappened.trim()) ? rawHappened.trim() : undefined;
    events.push({ ns, kind, summary, ...(happened ? { happened } : {}) });
  }
  return events;
}

/** True when the filter itself says the event happened before the saved day. Written into the
 *  output so that code, not the model's judgement alone, drops an old event that a new page
 *  mentions in passing. "unknown" or an unreadable date keeps the event: a news item published
 *  in the window is trusted unless the filter says otherwise. A month-only date counts as the
 *  whole month, so it is "before" only if that month ended before the saved day's month. */
export function happenedBefore(happened: string | undefined, savedOn: string): boolean {
  const m = happened?.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
  if (!m) return false;
  if (!m[3]) return `${m[1]}-${m[2]}` < savedOn.slice(0, 7);
  const oneDay = 86_400_000; // slack: the saved day itself and the day before are kept
  return Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`) < Date.parse(`${savedOn}T00:00:00Z`) - oneDay;
}

/** True when the page itself mentions the company or product that was searched for. The
 *  planner writes names company-first ("Neon Postgres", "HubSpot Sales Hub", "Close CRM"), so
 *  the first word is the company. This is what stops a page that matched on a generic word
 *  ("Postgres") from being reported as news about someone else's product: an acquisition of
 *  another company was once listed under "Neon Postgres". */
function mentionsSearchedName(item: NewsItem): boolean {
  const word = item.name.trim().split(/\s+/)[0]?.toLowerCase();
  if (!word) return true;
  return `${item.result.title} ${item.result.content ?? item.result.snippet}`.toLowerCase().includes(word);
}

/** One small fast-model call. Null means it failed or answered unreadably: the section then
 *  says so instead of guessing. */
export async function filterNews(
  fast: ModelAdapter,
  input: NewsFilterInput,
  onUsage?: (usage: Usage) => void,
): Promise<NewsEvent[] | null> {
  if (!input.items.length) return [];
  try {
    const events = parseNewsFilter(
      await fast.complete({
        system: NEWS_FILTER_SYSTEM,
        messages: [{ role: "user", content: buildNewsFilterPrompt(input) }],
        // Part of this budget goes to hidden reasoning before the JSON starts.
        maxTokens: 1500,
        // Reasoning stays on. Measured on four real prompts, ten runs each: with it the filter
        // returned the right events every time (the same three real CRM events in 10 of 10
        // runs, and none for the three prompts that have no real news). With reasoning off it
        // was 1.2 s faster but unreliable: it missed events in 6 of 10 CRM runs, listed an
        // iPhone roundup page as a launch in 6 of 10, and a study about apps built on Supabase
        // as Supabase news in 10 of 10. The call runs while the answer is being written, so the
        // extra second mostly hides behind it.
        effort: "low",
        ...(onUsage ? { onUsage } : {}),
      }),
      new Set(input.items.map((item) => item.n)),
    );
    // Two cheap checks in code as safety nets, each using something the filter wrote down or
    // the page itself, never the filter's say-so alone: an event it dates before the saved
    // day, and an event whose cited pages never mention the searched-for company (an
    // acquisition of another company was once listed under "Neon Postgres").
    const byNumber = new Map(input.items.map((item) => [item.n, item]));
    return events && events.filter((event) =>
      !happenedBefore(event.happened, input.savedOn) &&
      event.ns.some((n) => { const item = byNumber.get(n); return item !== undefined && mentionsSearchedName(item); }));
  } catch (error) {
    console.warn("[news] filter failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

const KIND_LABEL: Record<EventKind, string> = { price: "pricing", launch: "launch", company: "company news" };
const joinNames = (names: string[]) =>
  names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/** The section, written by code from the filter's events. Products with no event are listed
 *  together on one line; a failed search is said to have failed, never "nothing found". */
export function renderSince(input: {
  savedOn: string;
  searches: NewsSearch[];
  items: NewsItem[];
  /** Null when the filter failed. */
  events: NewsEvent[] | null;
  shortDate: (iso: string) => string;
}): string {
  const lines = [`## Since ${input.savedOn}`, ""];
  if (input.events === null) {
    lines.push("- I could not check what has happened since: the news step failed.");
    return lines.join("\n");
  }
  const byNumber = new Map(input.items.map((item) => [item.n, item]));
  const covered = new Set<string>();
  for (const event of input.events) {
    const first = byNumber.get(event.ns[0]);
    if (!first) continue;
    covered.add(first.name);
    const date = input.shortDate(first.result.publishedAt ?? "");
    lines.push(
      `- **${first.name}** (${KIND_LABEL[event.kind]}${date ? `, ${date}` : ""}): ${event.summary} ${event.ns.map((n) => `[${n}]`).join("")}`,
    );
  }
  const failed = input.searches.filter((search) => search.failed).map((search) => search.name);
  const nothing = input.searches.map((search) => search.name).filter((name) => !covered.has(name) && !failed.includes(name));
  if (nothing.length) lines.push(`- Nothing found for ${joinNames(nothing)}.`);
  if (failed.length) lines.push(`- Could not check ${joinNames(failed)}: the search failed.`);
  return lines.join("\n");
}
