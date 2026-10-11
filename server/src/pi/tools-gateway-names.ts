/**
 * The name the gateway to a conversation's lazy tools is known by, in a module of its own:
 * the guard reads it as it loads, and must not wait on everything the gateway needs.
 */

/** The tool that searches, describes and calls the tools a conversation has as lazy. */
export const GATEWAY_TOOL = "tools";

/**
 * What the portal puts on the end of a call through the gateway, which says which tool it called: pi's
 * end event of a call names the tool (`tools`) and carries no arguments, and the pages that draw a
 * picture or open the browser from a tool's name read it there. See calledThrough for the start.
 */
export const CALLED_TOOL_KEY = "portalCalledTool";

/**
 * The call a gateway call makes: the tool it calls, and the arguments it gives it. Nothing for a search or
 * a describe, which call nothing. The arguments are an object or the JSON text of one, as the gateway takes
 * them. The portal's pages and its client read it alike, so a lazy tool looks like itself to both.
 */
export function calledThrough(args: unknown): { name: string; args: Record<string, unknown> } | undefined {
  const plain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!plain(args) || args.action !== "call" || typeof args.name !== "string") return undefined;
  const name = args.name.trim();
  if (!name) return undefined;
  let given: unknown = args.args;
  if (typeof given === "string") {
    try {
      given = JSON.parse(given);
    } catch {
      given = undefined;
    }
  }
  return { name, args: plain(given) ? given : {} };
}
