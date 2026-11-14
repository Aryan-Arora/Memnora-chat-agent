import type { UserProfile } from "../types.js";

export const DEFAULT_PROFILE: UserProfile = {
  id: "default",
  answerLength: "balanced",
  tone: "direct",
  structure: "mixed",
  technicalDepth: "intermediate",
  leadWithRecommendation: true,
  showSources: "when_searched",
  compareInTables: true,
  adaptiveLearning: false,
  signals: [],
  updatedAt: new Date(0).toISOString(),
};

/** Stable, compact profile block for the writer prompt; never includes low-confidence guesses. */
export function buildProfilePrompt(profile: UserProfile): string {
  const learned = profile.signals
    .filter((signal) => signal.source === "explicit" || signal.confidence >= 0.75)
    .slice(0, 8)
    .map((signal) => `- ${signal.key}: ${signal.value}`);
  return [
    "USER RESPONSE PREFERENCES",
    `- Length: ${profile.answerLength}`,
    `- Tone: ${profile.tone}`,
    `- Structure: ${profile.structure}`,
    `- Technical depth: ${profile.technicalDepth}`,
    `- Lead with recommendation: ${profile.leadWithRecommendation ? "yes" : "no"}`,
    `- Sources: ${profile.showSources.replace("_", " ")}`,
    `- Use tables for comparisons: ${profile.compareInTables ? "yes" : "no"}`,
    ...learned,
    "Preferences affect presentation only. Evidence and factual standards do not change.",
  ].join("\n");
}

const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

/**
 * The browser sends preferences with every chat request. Treat them as untrusted: every field
 * is checked against a fixed set of values, so a crafted request cannot put free text
 * (a prompt injection) into the system prompt. Learned `signals` are never accepted from the client.
 */
export function parseProfile(input: unknown): UserProfile {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const d = DEFAULT_PROFILE;
  return {
    ...d,
    answerLength: pick(o.answerLength, ["concise", "balanced", "detailed"] as const, d.answerLength),
    tone: pick(o.tone, ["direct", "warm", "formal"] as const, d.tone),
    structure: pick(o.structure, ["prose", "mixed", "bullets"] as const, d.structure),
    leadWithRecommendation: typeof o.leadWithRecommendation === "boolean" ? o.leadWithRecommendation : d.leadWithRecommendation,
    compareInTables: typeof o.compareInTables === "boolean" ? o.compareInTables : d.compareInTables,
    adaptiveLearning: false,
  };
}
