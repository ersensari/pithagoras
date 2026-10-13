/**
 * Whether a spoken request needs tools (a search, a lookup, a file or browser
 * action) or is plain conversation. forgeloop-ai's laya-multilingual answers it
 * in ~50ms with per-label scores, the same service server.ts uses for
 * "serious" delegation (LAYA_URL).
 *
 * Why it exists: a small local model that thinks before a spoken reply is slow
 * for chat, but one that does not think often announces a search ("I'll look
 * that up") and ends the turn without calling the tool, or asks a clarifying
 * question instead. So thinking is spent only on requests that need tools.
 *
 * Fails toward thinking: when the classifier is down or answers oddly, a slower
 * reply is better than a tool call that never happens.
 */
const LAYA_URL = process.env.LAYA_URL || "http://127.0.0.1:10085/classify";
const LAYA_TIMEOUT_MS = 2000;
/**
 * Below this score for "tools" a request counts as chat. Measured on this
 * classifier: real tool requests (search, weather, memory lookup) score 0.73-0.98,
 * greetings, thanks and "peki" 0.00-0.42, so 0.6 sits in the gap.
 */
const TOOLS_THRESHOLD = 0.6;
const CRITERIA = {
  tools: "the user asks to search the web, look something up, find, check, remember, open, run, read, create, edit or change something, which needs tools or research",
  chat: "casual conversation, a greeting, thanks, an opinion, or a simple question that can be answered from general knowledge without looking anything up",
};

export async function needsTools(text: string): Promise<boolean> {
  try {
    const upstream = await fetch(LAYA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, criteria: CRITERIA }),
      signal: AbortSignal.timeout(LAYA_TIMEOUT_MS),
    });
    if (!upstream.ok) return true;
    const body = await upstream.json() as { choice?: unknown; labels?: unknown; scores?: unknown };
    if (Array.isArray(body.labels) && Array.isArray(body.scores)) {
      const score = body.scores[body.labels.indexOf("tools")];
      if (typeof score === "number") return score >= TOOLS_THRESHOLD;
    }
    return body.choice !== "chat";
  } catch {
    return true;
  }
}
