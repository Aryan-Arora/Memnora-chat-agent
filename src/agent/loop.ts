// The agent loop: remember -> route -> (search) -> answer.
//   1. Memory lookup (local, milliseconds): resolve any date in the message and recall notes.
//   2. Route (router.ts): decide whether to search and with what query. A re-check reuses
//      the query saved with the old answer.
//   3. Search, if the route asked for it. If the search fails, answer anyway and say so.
//   4. The main model writes the answer, streamed. Stable instructions go in `system`
//      (cacheable); everything that changes per question goes in `context`.
//      A re-check that also asks what has happened since gets a second part: news searches,
//      one per item, run while the first part is written, and their findings are appended.
//   5. After the answer, a background job turns the exchange into a dated note.
// Events are emitted as they happen so the UI can show progress.
import { randomUUID } from "node:crypto";
import { resolveDate } from "../memory/dates.js";
import { assessRelevance, candidateFromNote } from "../memory/ingestion.js";
import { buildProfilePrompt } from "../memory/preferences.js";
import {
  buildNoteExtractionPrompt,
  NOTE_EXTRACTION_SYSTEM,
  parseNoteExtraction,
  snapshotFromNoteExtraction,
} from "../memory/notes.js";
import type {
  MemoryIngestionSource, MemoryNote, MemoryStore, Message, ModelAdapter, NoteMemoryStore, RecheckEntry,
  SearchResult, SearchTool, Usage, UserProfile,
} from "../types.js";
import { planFollowUps, route } from "./router.js";

export type AgentEvent =
  | { type: "status"; text: string }
  | { type: "token"; text: string }
  | { type: "sources"; sources: { title: string; url: string; publishedAt?: string }[] }
  | { type: "memory"; text: string; notes?: Pick<MemoryNote, "topic" | "claim" | "createdAt" | "volatility">[] }
  | { type: "error"; text: string }
  | { type: "done" };

export interface AgentDeps {
  fast: ModelAdapter;
  main: ModelAdapter;
  search: SearchTool;
  memory: MemoryStore;
  now?: () => Date; // injectable so tests and benchmarks can pin "today"
  /** Optional: receives token usage for every model call (benchmark cost tracking). */
  onUsage?: (model: string, u: Usage) => void;
  onTiming?: (timing: AgentTiming) => void;
}

export interface AgentOptions {
  profile?: UserProfile;
  /** IANA zone from the browser, for example "Asia/Kolkata". */
  timeZone?: string;
}

export interface AgentTiming {
  memoryMs: number;
  routerMs: number;
  searchMs: number;
  modelStartupMs: number;
  streamMs: number;
  totalMs: number;
}

// Stable on purpose: no dates, no per-question data, so the provider can cache it.
const ANSWER_SYSTEM = `You are a fast, direct chat assistant. Be concise but complete, with no padding.
Lead with the direct answer. For anything beyond a one-paragraph reply, organize the rest with short ## headings and bullets.
Use numbered steps for procedures and bold labels for compact comparisons. Do not add headings to a simple answer.
Keep paragraphs short and put caveats beside the claim they qualify instead of in a generic disclaimer section.
When earlier conversation is provided, use its timestamps to answer questions about what was asked and when.
When asked whether an earlier answer still holds, or what has changed since it, work in this order, even if the preferences below say to lead with the conclusion:
1. One sentence saying what was asked or saved, and on which date.
2. The comparison, one saved value at a time: what it was then, what today's web results say now, and a status of unchanged, changed, or not confirmed. Use a table for three or more values. "Changed" means today's value differs from the saved one; sources that disagree while the value stays the same leave it "unchanged". "Not confirmed" means today's results do not state the value; it is never a change.
3. The verdict, in one or two sentences, after the comparison.
Cite web results as [n]. If sources conflict, say so and give more weight to the most recently dated one. If the question assumes something that does not exist, say that.
If the question is vague, ask one clarifying question instead of guessing.
If a search failed or returned nothing, say you could not check the web instead of guessing.`;

// The second part of a re-check answer, written only when the user also asked what has
// happened since. It is a separate call so the comparison does not wait for the news searches.
const NEWS_SYSTEM = `You are adding one section to an answer that is already on the user's screen. The user asked what has happened since an earlier answer. The first part compared the saved values with today's. News searches then ran, one per item, limited to the period since the saved date.
Write only the new section. Start with a "## Since <saved date>" heading, then:
- A result counts only if it reports something the item's maker announced, released or changed on or after the saved date. Reviews, comparisons, interviews, share-price coverage and anything about another company do not count. Never describe a result that does not count, and do not explain why it was left out.
- For each item with a result that counts: one bullet naming the item, what happened, its date and a citation [n].
- Name the items with nothing that counts together, in one last bullet: "Nothing found for X, Y and Z." If a search failed, say that item could not be checked.
- End with one sentence that answers the user's question about what has happened since, consistent with the first part.
Do not guess, do not repeat the comparison, and do not add other headings.`;

// Dates shown to the model are the user's local calendar dates, so "on 3 November" in the
// question and the date printed on a note mean the same day wherever the user is.
function localClock(timeZone?: string) {
  let zone = "UTC";
  try {
    if (timeZone) { new Intl.DateTimeFormat("en", { timeZone }); zone = timeZone; }
  } catch { /* unknown zone: keep UTC */ }
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone, weekday: "long", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const parts = (date: Date) => Object.fromEntries(format.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    /** "Sunday 2026-11-15" */
    today(date: Date): string {
      const p = parts(date);
      return `${p.weekday} ${p.year}-${p.month}-${p.day}`;
    },
    /** "2026-11-09 15:30" */
    stamp(iso: string): string {
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return iso;
      const p = parts(date);
      return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
    },
  };
}

// The date a snapshot was taken is printed above it. Some snapshots also store that date as
// a value ("as_of", "observed_on", "exchange_date": the name varies). Shown to the answer
// model it reads as a saved fact, and it was reported to the user as something that changed.
// So a value is dropped when its key looks like a date stamp and it is the snapshot's own day.
const DATE_STAMP_KEY = /date|as_of|_on$|_at$|observed|checked|snapshot/;

function buildContext(input: {
  today: string;
  stamp: (iso: string) => string;
  notes: MemoryNote[];
  /** The note being re-checked and the values saved with it, when this is a re-check. */
  recheck: { note: MemoryNote; saved: RecheckEntry } | null;
  pastChat: Message[];
  pastChatLabel: string;
  results: SearchResult[];
  searchFailed: boolean;
  /** True when news searches are running and a second part will follow this answer. */
  newsFollows: boolean;
}): string {
  const { today, stamp, notes, recheck, pastChat, pastChatLabel, results, searchFailed, newsFollows } = input;
  const parts = [`Today is ${today} (the user's local date).`];
  if (notes.length) {
    parts.push(
      `Relevant memory notes (compact records, not fresh evidence):\n` +
        notes.map((note) => `[${stamp(note.createdAt)}] ${note.topic}: ${note.claim}`).join("\n"),
    );
  }
  const savedDays = recheck ? [recheck.saved.createdAt.slice(0, 10), stamp(recheck.saved.createdAt).slice(0, 10)] : [];
  const savedValues = Object.fromEntries(
    Object.entries(recheck?.saved.snapshot ?? {})
      .filter(([key, value]) => !(DATE_STAMP_KEY.test(key) && typeof value === "string" && savedDays.includes(value.slice(0, 10)))),
  );
  if (recheck && Object.keys(savedValues).length) {
    parts.push(
      `Values saved on ${stamp(recheck.saved.createdAt).slice(0, 10)} with the answer about "${recheck.note.topic}" ` +
        `(the baseline for what changed):\n${JSON.stringify(savedValues)}`,
    );
  }
  if (pastChat.length) {
    parts.push(`${pastChatLabel}:\n` + pastChat.map((m) => `[${stamp(m.createdAt)}] ${m.role}: ${m.content}`).join("\n"));
  }
  if (results.length) {
    parts.push(
      `Fresh web results:\n` +
        results
          .map((r, i) => `[${i + 1}] ${r.title} (${r.url})${r.publishedAt ? ` published ${r.publishedAt}` : ""}\n${r.content ?? r.snippet}`)
          .join("\n\n"),
    );
  }
  if (searchFailed) parts.push("The web search failed. Tell the user you could not check the web.");
  if (newsFollows) {
    parts.push(
      "News searches for each item are running separately, and a section on what has happened since will be added " +
        "after your answer. Leave news, launches and releases to that section: do not discuss them and do not say you could not check them.",
    );
  }
  return parts.join("\n\n");
}

interface FollowUp { query: string; results: SearchResult[]; failed: boolean }

/** News searches for a re-check, run in parallel. Only results dated on or after the saved
 *  answer are kept. That filter is code, not a prompt: an undated or older page can then
 *  never be presented as something new. */
async function searchNewsSince(search: SearchTool, queries: string[], savedAt: Date, now: Date): Promise<FollowUp[]> {
  const day = 86_400_000;
  const sinceDays = Math.max(1, Math.ceil((now.getTime() - savedAt.getTime()) / day) + 1);
  const cutoff = savedAt.getTime() - day; // one day of slack: publication dates carry no time zone
  return Promise.all(queries.map(async (query) => {
    try {
      const found = await search.search(query, { maxResults: 3, sinceDays });
      return { query, failed: false, results: found.filter((r) => r.publishedAt && Date.parse(r.publishedAt) >= cutoff) };
    } catch (error) {
      console.error("[search] follow-up failed:", error instanceof Error ? error.message : error);
      return { query, failed: true, results: [] };
    }
  }));
}

function buildNewsContext(input: {
  today: string;
  stamp: (iso: string) => string;
  note: MemoryNote;
  savedOn: string;
  firstPart: string;
  followUps: FollowUp[];
  /** Citation number of the first news result: numbering continues from the first part. */
  firstNumber: number;
}): string {
  let number = input.firstNumber;
  const searches = input.followUps.map((followUp) => {
    if (followUp.failed) return `Search "${followUp.query}": the search failed, so this item could not be checked.`;
    if (!followUp.results.length) return `Search "${followUp.query}": nothing dated since ${input.savedOn}.`;
    return `Search "${followUp.query}":\n` + followUp.results
      .map((r) => `[${number++}] ${r.title} (${r.url}) published ${input.stamp(r.publishedAt ?? "").slice(0, 10)}\n${r.content ?? r.snippet}`)
      .join("\n\n");
  });
  return [
    `Today is ${input.today} (the user's local date).`,
    `The earlier answer was saved on ${input.savedOn}. ${input.note.topic}: ${input.note.claim}`,
    `First part of the answer, already shown to the user:\n${input.firstPart}`,
    `News searches limited to the period since ${input.savedOn}:\n${searches.join("\n\n")}`,
  ].join("\n\n");
}

const toSources = (results: SearchResult[]) =>
  results.map((r) => ({ title: r.title, url: r.url, ...(r.publishedAt ? { publishedAt: r.publishedAt } : {}) }));

function noteStore(memory: MemoryStore): NoteMemoryStore | null {
  const candidate = memory as Partial<NoteMemoryStore>;
  return typeof candidate.retrieve === "function" && typeof candidate.saveNote === "function"
    ? candidate as NoteMemoryStore
    : null;
}

// Recall cues. They only decide whether to look in memory, which is local and takes
// milliseconds. Whether to search the web is decided in router.ts.
// "I asked", "did we decide", "you told me", "last time": the user means our own history.
// Bare "earlier", "previous", "before" and "still" are deliberately absent: they describe
// ordinary questions too ("the previous iPhone") and used to switch the web search off.
const SAID_BEFORE = /\b(?:i|we|you)\s+(?:asked|said|told|talked|discussed|decided|mentioned|recommended|suggested|shortlisted)\b|\bdid\s+(?:i|we|you)\s+(?:ask|say|tell|talk|discuss|decide|mention|recommend|suggest)\b|\b(?:remember|recall|last time|re-?check|changed since)\b/i;
// In “is the earlier answer still correct today?”, today describes the fresh comparison,
// not the day to retrieve. “What did I ask today?” has no freshness wording and keeps its range.
const TODAY_IS_FRESHNESS = /(?:\b(?:still|correct|right|changed?|current|verify|re-?check|up to date)\b[^.?!]*\btoday\b|\btoday\b[^.?!]*\b(?:still|correct|right|changed?|current|verify|re-?check|up to date)\b)/i;
// "my previous chat", "the other conversation": a different chat from this one. A bare
// "conversation" or "summarize" is not enough ("how do I start a conversation?").
const OTHER_CHAT = /\b(?:previous|last|other|earlier|past|another|prior)\s+(?:chat|conversation|session|discussion|thread)s?\b/i;
const pendingMemory = new Map<string, Promise<void>>();

/** Tests and graceful shutdown use this; normal requests only await their own conversation. */
export async function waitForMemoryTasks(conversationId?: string): Promise<void> {
  if (conversationId) await pendingMemory.get(conversationId);
  else await Promise.allSettled([...pendingMemory.values()]);
}

async function drainIngestionJobs(deps: AgentDeps, store: NoteMemoryStore): Promise<void> {
  while (true) {
    const job = await store.claimIngestion();
    if (!job) return;
    try {
      const relevance = assessRelevance(job.source);
      if (relevance.outcome === "reject") { await store.completeIngestion(job.id); continue; }
      const rawNote = await deps.fast.complete({
        system: NOTE_EXTRACTION_SYSTEM,
        messages: [{
          role: "user",
          content: buildNoteExtractionPrompt(job.source.user, job.source.assistant, {
            ...(job.source.query ? { query: job.source.query } : {}), sources: job.source.sources,
          }),
        }],
        maxTokens: 1400,
        effort: "low",
        onUsage: (usage) => deps.onUsage?.(deps.fast.name, usage),
      });
      const parsed = parseNoteExtraction(rawNote, {
        // Stable across retries so a crash cannot create two notes for one source.
        id: `note:${job.source.id}`, conversationId: job.source.conversationId, createdAt: job.source.assistant.createdAt,
      });
      if (parsed) {
        const savedNote: MemoryNote = {
          ...parsed,
          ...(job.source.query ? { query: job.source.query } : {}),
          sources: job.source.sources.length ? job.source.sources : parsed.sources,
        };
        await store.saveNote(savedNote);
        await store.resolveCandidate(candidateFromNote(job.source, savedNote, relevance));
        const snapshot = snapshotFromNoteExtraction(rawNote);
        if (savedNote.volatility === "volatile" && savedNote.query && Object.keys(snapshot).length) {
          await store.saveRecheck({
            id: randomUUID(), noteId: savedNote.id, conversationId: job.source.conversationId,
            createdAt: savedNote.createdAt, query: savedNote.query, snapshot,
          });
        }
      }
      await store.completeIngestion(job.id);
    } catch (error) {
      await store.failIngestion(job.id, error instanceof Error ? error.message : String(error));
      console.warn("[memory] durable ingestion failed:", error instanceof Error ? error.message : error);
      return; // retry on the next request instead of spinning on a failing dependency
    }
  }
}

export async function runAgent(
  deps: AgentDeps,
  conversationId: string,
  userText: string,
  emit: (e: AgentEvent) => void,
  opts: AgentOptions = {},
): Promise<void> {
  const started = performance.now();
  let memoryDone = started, routeStarted = started, routeDone = started;
  let searchStarted = 0, searchDone = 0;
  let modelStarted = 0, firstTokenAt = 0, modelDone = 0;
  const now = (deps.now ?? (() => new Date()))();
  const clock = localClock(opts.timeZone);
  const track = (m: ModelAdapter) => (u: Usage) => deps.onUsage?.(m.name, u);
  try {
    const compact = noteStore(deps.memory);
    const saidBefore = SAID_BEFORE.test(userText);
    const resolvedRange = resolveDate(userText, now, opts.timeZone);
    const range = saidBefore && resolvedRange?.label === "today" && TODAY_IS_FRESHNESS.test(userText)
      ? null
      : resolvedRange;
    const otherChat = OTHER_CHAT.test(userText);
    const shouldRecall = Boolean(range || saidBefore || otherChat);
    // Recall must see notes whose extraction has only just finished: this chat's, or every
    // chat's when the user asks about another chat.
    await waitForMemoryTasks(otherChat ? undefined : conversationId);
    if (compact && shouldRecall) await drainIngestionJobs(deps, compact); // recover jobs left by an earlier process
    const userMsg: Message = {
      id: randomUUID(), role: "user", content: userText, createdAt: now.toISOString(), conversationId,
    };
    emit({ type: "status", text: "Thinking" });

    // Memory lookup happens BEFORE saving this message, so "today" doesn't echo it back.
    // Note retrieval and recent-chat loading are independent and run together.
    const [retrievedNotes, recent] = await Promise.all([
      compact && shouldRecall ? compact.retrieve(userText, range ?? undefined, 5) : Promise.resolve([]),
      deps.memory.recent(200),
    ]);
    // Generic "previous chat" requests have no topic for FTS. Fall back to the newest
    // conversation other than this one; topic-specific requests still prefer compact notes.
    const otherMessages = otherChat
      ? recent.filter((message) => message.conversationId !== conversationId)
      : [];
    const previousConversationId = otherMessages.at(-1)?.conversationId;
    const previousChat = previousConversationId
      ? otherMessages.filter((message) => message.conversationId === previousConversationId)
      : [];
    // Old history may predate note extraction, so raw messages remain a reliable fallback.
    const pastChat = !retrievedNotes.length && range
      ? await deps.memory.between(range.from, range.to)
      : !retrievedNotes.length && otherChat ? previousChat : [];
    const thisChat = recent.filter((m) => m.conversationId === conversationId).slice(-10);
    memoryDone = performance.now();
    if (retrievedNotes.length) {
      emit({
        type: "memory",
        text: `${retrievedNotes.length} relevant note${retrievedNotes.length === 1 ? "" : "s"}`,
        notes: retrievedNotes.map(({ topic, claim, createdAt, volatility }) => ({ topic, claim, createdAt, volatility })),
      });
    } else if (pastChat.length) {
      emit({
        type: "memory",
        text: range
          ? `${pastChat.length} messages from ${range.label}`
          : `${pastChat.length} messages from your previous conversation`,
      });
    }
    await deps.memory.save(userMsg);

    routeStarted = performance.now();
    const decision = await route(deps.fast, {
      userText,
      today: clock.today(now),
      recentTurns: thisChat.slice(-4),
      notes: retrievedNotes,
    }, track(deps.fast));
    // Legacy notes sometimes saved the user's whole sentence as their query. The router
    // repairs those lazily; persist the result so that cost is paid only on the first re-check.
    if (compact && decision.recheckNote?.query && decision.query !== decision.recheckNote.query) {
      decision.recheckNote.query = decision.query;
      await compact.saveNote(decision.recheckNote);
    }
    routeDone = performance.now();
    const { query } = decision;
    console.log(`[router] ${JSON.stringify(userText.slice(0, 60))} -> ${query ? `SEARCH ${JSON.stringify(query)}` : "NO"} (${decision.source})`);

    // Re-check: the values saved with the old answer are the baseline for "what changed".
    // The main model compares them with today's results itself and shows the comparison.
    // A separate fast-model call used to extract today's values and code diffed the two, but
    // it added 2.3 to 4.4 seconds before the first word and reported values missing from
    // today's results as changes.
    const saved = compact && decision.recheckNote ? await compact.latestRecheck(decision.recheckNote.id) : null;

    let results: SearchResult[] = [];
    let searchFailed = false;
    let followUpQueries: string[] = [];
    let news: Promise<FollowUp[]> = Promise.resolve([]);
    const savedOn = decision.recheckNote ? clock.stamp(decision.recheckNote.createdAt).slice(0, 10) : "";
    if (query) {
      searchStarted = performance.now();
      emit({ type: "status", text: `Searching: ${query}` });
      const primary = deps.search.search(query, { maxResults: 5 });
      primary.catch(() => {}); // the failure is handled at the await below; this only keeps it from being reported as unhandled first
      if (decision.recheckNote) {
        // The saved query cannot show what has happened since ("...or shipped something big
        // since?"). While it runs again, the fast model names the products the question is
        // about, and a dated news search starts for each. Those searches keep running while
        // the first part of the answer is written. "<name> news" was the wording that
        // returned relevant items for every product tried; narrower ones ("pricing change",
        // "product launch") missed some.
        const note = decision.recheckNote;
        const plan = planFollowUps(deps.fast, { userText, note, savedOn }, track(deps.fast))
          .then((names) => names.map((name) => `${name} news`));
        news = plan.then((queries) => searchNewsSince(deps.search, queries, new Date(note.createdAt), now));
        followUpQueries = await plan;
      }
      try {
        results = await primary;
        emit({ type: "sources", sources: toSources(results) });
      } catch (err) {
        searchFailed = true; // degrade gracefully: the answer prompt tells the model to say so
        console.error("[search] failed:", err instanceof Error ? err.message : err);
      }
      searchDone = performance.now();
    }
    // Say what happens next, so a pause before the first word is not a blank screen.
    if (results.length) {
      emit({
        type: "status",
        text: saved
          ? `Comparing with what was saved on ${clock.stamp(saved.createdAt).slice(0, 10)}`
          : `Reading ${results.length} source${results.length === 1 ? "" : "s"}`,
      });
    }

    let answer = "";
    modelStarted = performance.now();
    // Preferences change rarely, so they sit in the cached system block, not the per-question
    // context: a changed setting costs one cache miss, then it is cached again.
    const withProfile = (system: string) => opts.profile ? `${system}\n\n${buildProfilePrompt(opts.profile)}` : system;
    const messages = [...thisChat, userMsg].map((m) => ({ role: m.role, content: m.content }));
    const stream = deps.main.stream({
      system: withProfile(ANSWER_SYSTEM),
      context: buildContext({
        today: clock.today(now),
        stamp: clock.stamp,
        notes: retrievedNotes,
        recheck: decision.recheckNote && saved ? { note: decision.recheckNote, saved } : null,
        pastChat,
        pastChatLabel: range ? "Earlier conversation from the date the user mentioned" : "The user's previous chat",
        results,
        searchFailed,
        newsFollows: followUpQueries.length > 0,
      }),
      messages,
      // A ceiling, not a target: it also has to cover any hidden reasoning. At 1024 answers
      // were cut off mid-sentence. A typical answer is about 500 tokens.
      maxTokens: 3000,
      // Measured on the brief's three questions (2026-11-15): with no effort set, the model
      // reasoned privately for 6 to 8 seconds before its first word. At "low" the first word
      // usually comes in about one second; the model still reasons first when it judges a
      // question needs it, which took 3 to 6 seconds in 6 of 17 re-check runs. Switching
      // reasoning off entirely was steadier (1 to 2.5 seconds) but mislabelled one comparison
      // row in four on the hardest question, so correctness won.
      effort: "low",
      onUsage: track(deps.main),
    });
    for await (const chunk of stream) {
      if (!firstTokenAt) firstTokenAt = performance.now();
      answer += chunk;
      emit({ type: "token", text: chunk });
    }

    // Second part of a re-check: what has happened since. The news searches have usually
    // finished by now, because they ran while the first part was being written.
    if (decision.recheckNote && followUpQueries.length) {
      const seen = new Set(results.map((r) => r.url));
      const followUps = (await news).map((followUp) => ({
        ...followUp,
        results: followUp.results.filter((r) => {
          if (seen.has(r.url)) return false;
          seen.add(r.url);
          return true;
        }),
      }));
      const newsResults = followUps.flatMap((followUp) => followUp.results);
      emit({ type: "status", text: `Adding what has happened since ${savedOn}` });
      // One numbered list across both parts, so a citation [n] means the same source everywhere.
      emit({ type: "sources", sources: toSources([...results, ...newsResults]) });
      const firstPart = answer;
      answer += "\n\n";
      emit({ type: "token", text: "\n\n" });
      const secondPart = deps.main.stream({
        system: withProfile(NEWS_SYSTEM),
        context: buildNewsContext({
          today: clock.today(now), stamp: clock.stamp, note: decision.recheckNote, savedOn,
          firstPart, followUps, firstNumber: results.length + 1,
        }),
        messages,
        maxTokens: 1500,
        effort: "low",
        onUsage: track(deps.main),
      });
      for await (const chunk of secondPart) {
        answer += chunk;
        emit({ type: "token", text: chunk });
      }
      results = [...results, ...newsResults]; // the saved note records every source used
    }
    modelDone = performance.now();

    const assistantMsg: Message = {
      id: randomUUID(), role: "assistant", content: answer,
      // The injected clock plus elapsed time, never the machine clock: a test or benchmark
      // that pins "today" to a past day then gets messages and notes dated on that day.
      createdAt: new Date(now.getTime() + Math.round(performance.now() - started)).toISOString(),
      conversationId,
    };
    await deps.memory.save(assistantMsg);

    deps.onTiming?.({
      memoryMs: Math.round(memoryDone - started),
      routerMs: Math.round(routeDone - routeStarted),
      searchMs: Math.round(searchDone && searchStarted ? searchDone - searchStarted : 0),
      modelStartupMs: Math.round((firstTokenAt || modelDone) - modelStarted),
      streamMs: Math.round(modelDone - (firstTokenAt || modelStarted)),
      totalMs: Math.round(performance.now() - started),
    });
    emit({ type: "done" });
    if (compact) {
      const source: MemoryIngestionSource = {
        id: randomUUID(), conversationId, user: userMsg, assistant: assistantMsg,
        ...(query ? { query } : {}), sources: results.map((result) => result.url),
        createdAt: assistantMsg.createdAt,
      };
      await compact.enqueueIngestion(source); // persisted before background processing starts
      const task = drainIngestionJobs(deps, compact);
      pendingMemory.set(conversationId, task);
      void task.finally(() => {
        if (pendingMemory.get(conversationId) === task) pendingMemory.delete(conversationId);
      });
    }
  } catch (err) {
    emit({ type: "error", text: err instanceof Error ? err.message : String(err) });
  }
}
