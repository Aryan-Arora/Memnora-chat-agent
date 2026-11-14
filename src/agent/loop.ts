// The agent loop: remember -> route -> (search) -> answer.
//   1. Memory lookup (local, milliseconds): resolve any date in the message and recall notes.
//   2. Route (router.ts): decide whether to search and with what query. A re-check reuses
//      the query saved with the old answer.
//   3. Search, if the route asked for it. If the search fails, answer anyway and say so.
//   4. The main model writes the answer, streamed. Stable instructions go in `system`
//      (cacheable); everything that changes per question goes in `context`.
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
import { route } from "./router.js";

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
2. The comparison, one saved value at a time: what it was then, what today's web results say now, and a status of unchanged, changed, or not confirmed. Use a table for three or more values. "Not confirmed" means today's results do not state the value; it is never a change.
3. The verdict, in one or two sentences, after the comparison.
Cite web results as [n]. If sources conflict, say so and give more weight to the most recently dated one. If the question assumes something that does not exist, say that.
If the question is vague, ask one clarifying question instead of guessing.
If a search failed or returned nothing, say you could not check the web instead of guessing.`;

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
// a value ("as_of", "observed_on"). Shown to the answer model it reads as a saved fact, and
// it was reported to the user as something that changed.
const BOOKKEEPING_KEY = /^(as_of|observed_on|checked_on|recorded_on|retrieved_on|snapshot_date|date)$/;

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
}): string {
  const { today, stamp, notes, recheck, pastChat, pastChatLabel, results, searchFailed } = input;
  const parts = [`Today is ${today} (the user's local date).`];
  if (notes.length) {
    parts.push(
      `Relevant memory notes (compact records, not fresh evidence):\n` +
        notes.map((note) => `[${stamp(note.createdAt)}] ${note.topic}: ${note.claim}`).join("\n"),
    );
  }
  const savedValues = Object.fromEntries(
    Object.entries(recheck?.saved.snapshot ?? {}).filter(([key]) => !BOOKKEEPING_KEY.test(key)),
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
  return parts.join("\n\n");
}

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
    const range = resolveDate(userText, now, opts.timeZone);
    const saidBefore = SAID_BEFORE.test(userText);
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
    if (query) {
      searchStarted = performance.now();
      emit({ type: "status", text: `Searching: ${query}` });
      try {
        results = await deps.search.search(query, { maxResults: 5 });
        emit({
          type: "sources",
          sources: results.map((r) => ({
            title: r.title, url: r.url, ...(r.publishedAt ? { publishedAt: r.publishedAt } : {}),
          })),
        });
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
    const stream = deps.main.stream({
      // Preferences change rarely, so they sit in the cached system block, not the per-question
      // context: a changed setting costs one cache miss, then it is cached again.
      system: opts.profile ? `${ANSWER_SYSTEM}\n\n${buildProfilePrompt(opts.profile)}` : ANSWER_SYSTEM,
      context: buildContext({
        today: clock.today(now),
        stamp: clock.stamp,
        notes: retrievedNotes,
        recheck: decision.recheckNote && saved ? { note: decision.recheckNote, saved } : null,
        pastChat,
        pastChatLabel: range ? "Earlier conversation from the date the user mentioned" : "The user's previous chat",
        results,
        searchFailed,
      }),
      messages: [...thisChat, userMsg].map((m) => ({ role: m.role, content: m.content })),
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
