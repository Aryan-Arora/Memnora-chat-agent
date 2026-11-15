// Offline stand-ins so the whole pipeline runs with no API keys. Real adapters
// (one per provider) will implement the same interfaces.
import type { ModelAdapter, SearchTool } from "../types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createStubModel(name = "stub"): ModelAdapter {
  async function complete(req: Parameters<ModelAdapter["complete"]>[0]) {
    await sleep(40);
    const last = req.messages[req.messages.length - 1]?.content ?? "";
    // Rough fake usage (4 chars ~ 1 token) so the bench's cost columns can be exercised.
    req.onUsage?.({
      inputTokens: Math.ceil((req.system.length + (req.context?.length ?? 0) + last.length) / 4),
      outputTokens: 40,
      cacheReadTokens: 0,
    });
    // Keyless mode plans no follow-up searches for a re-check.
    if (req.system.startsWith("FOLLOW-UP")) return "NONE";
    // A useful deterministic repair in keyless mode: the note topic is already a compact,
    // attributable description and is safer than preserving the user's whole sentence.
    if (req.system.startsWith("SEARCH QUERY REPAIR")) {
      const topic = last.match(/^Memory topic:\s*(.+)$/m)?.[1]?.trim();
      return topic ? `QUERY: ${topic}` : "";
    }
    // Router prompt asks for "SEARCH: <query>" or "NO". Cheap keyword heuristic here.
    if (req.system.includes("ROUTER")) {
      // The router input wraps the user's text; pull out just the latest message.
      const latest = last.match(/Latest user message:\n([\s\S]*?)\n\nReply now/)?.[1] ?? last;
      return /price|pricing|latest|news|changed|since|today|current|version|release|feature|enable|available|support/i.test(latest)
        ? `SEARCH: ${latest.slice(0, 120)}`
        : "NO";
    }
    return `(stub answer) You said: "${last.slice(0, 200)}". Add a real model key to get a real answer.`;
  }
  return {
    name,
    complete,
    async *stream(req) {
      const text = await complete(req);
      for (const word of text.split(/(\s+)/)) {
        await sleep(15);
        yield word;
      }
    },
  };
}

export function createStubSearch(): SearchTool {
  return {
    async search(query) {
      await sleep(60);
      return [
        { title: "Example source A", url: "https://example.com/a", snippet: `Stub result for: ${query}` },
        { title: "Example source B", url: "https://example.com/b", snippet: "Another stub result." },
      ];
    },
  };
}
