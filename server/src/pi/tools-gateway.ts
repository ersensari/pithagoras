import { Type } from "typebox";
import { fail, say } from "./tool-result.js";
import { piDependency } from "./package.js";
import { GATEWAY_TOOL } from "./tools-gateway-names.js";

/**
 * One tool for all the tools a conversation has as lazy.
 *
 * A lazy tool is not in what the model is offered, so its schema and description cost nothing in a
 * conversation that never needs it. This is how the model reaches it when it does: it searches by what
 * the tool does, asks for the parameters of the one it found, and calls it. The portal offers the tool
 * only while the conversation has a lazy tool, and the tools are the conversation's own, not a second
 * list: what is switched off stays off here. A lazy tool is a tool that is on in every other respect; it
 * is only not in the list.
 *
 * A call is the same call as a direct one. pi puts every call through the extensions' hooks, the guard's
 * among them, and a call made from inside a tool would skip them, so the hooks are run here for the tool
 * that is called, with its name and its arguments. Everything the guard holds a direct call to holds
 * this one too: the browser's allowlist, the rules after untrusted content, who may run what.
 */

/** What the gateway asks of the conversation it serves, which the client that owns the tool switches provides. */
export interface GatewayHost {
  /** pi's session: the tool definitions, and the extensions' hooks that a call is put through. */
  session: () => any;
  /** The tools that are on and reached only through the gateway. */
  lazy: () => ReadonlySet<string>;
  /** The tools switched off, which no way leads to. */
  off: () => ReadonlySet<string>;
}

/** pi's own check of a call's arguments, which a direct call goes through: loaded from pi's copy of pi-ai. */
let piAi: Promise<any> | undefined;

/** How many tools one search lists: enough to choose from, few enough not to be the prompt it replaced. */
const SEARCH_LIMIT = 20;

/** How much of a description a search shows of each tool. */
const BLURB = 140;

interface Lazy {
  name: string;
  description: string;
  parameters: unknown;
}

/** The first line of a description, shortened: enough to tell tools apart. */
function blurb(description: string): string {
  const line = description.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > BLURB ? `${line.slice(0, BLURB - 1).trimEnd()}…` : line;
}

/** Words for matching: a name's underscores and hyphens are word breaks, as the model would say them. */
const words = (text: string): string[] => text.toLowerCase().replace(/[_\-.]+/g, " ").split(/\s+/).filter(Boolean);

/** The arguments of a call, from an object or from the text of one: models send either. */
function argsOf(raw: unknown): Record<string, unknown> {
  let value = raw;
  if (value === undefined || value === null || value === "") return {};
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return fail("args must be an object of the tool's arguments, or the JSON text of one.");
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("args must be an object of the tool's arguments.");
  }
  return { ...(value as Record<string, unknown>) };
}

const textOf = (content: unknown): string =>
  (Array.isArray(content) ? content : [])
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n");

/**
 * The one line that tells the model which lazy tools exist, by the names of their sets: the tools are not
 * in its list, and a model that does not know of them says it cannot do what they do.
 */
export function lazyHint(sets: readonly string[]): string {
  if (!sets.length) return `Some tools are not in your list one by one. Search them with the ${GATEWAY_TOOL} tool before you say you cannot do something.`;
  const list = sets.length > 1 ? `${sets.slice(0, -1).join(", ")} and ${sets[sets.length - 1]}` : sets[0];
  return `You have ${list} tools; search for them with the ${GATEWAY_TOOL} tool.`;
}

export class ToolsGateway {
  private host?: GatewayHost;
  /** The extension API of the runner that has the tool registered, to register it again when the hint changes. */
  private api?: any;

  constructor(private sets: string[] = []) {}

  /**
   * Say which sets the lazy tools are in. The hint is part of the tool's registration, so a change
   * registers the tool again, which has pi read its description and guidelines afresh.
   */
  hint(sets: string[]): void {
    const same = sets.length === this.sets.length && sets.every((set, i) => set === this.sets[i]);
    this.sets = sets;
    if (same || !this.api) return;
    try {
      this.register(this.api);
    } catch (e) {
      console.error(`[portal] could not update the hint of the ${GATEWAY_TOOL} tool: ${(e as Error).message}`);
    }
  }

  /** Once the session exists: the extension is registered before it does. */
  attach(host: GatewayHost): void {
    this.host = host;
  }

  /** The lazy tools this conversation has: those pi has registered, less any that is also switched off. */
  private lazyTools(): Lazy[] {
    const host = this.host;
    if (!host) return [];
    const lazy = host.lazy();
    const off = host.off();
    const all: any[] = host.session()?.getAllTools?.() ?? [];
    return all
      .filter((tool) => tool.name !== GATEWAY_TOOL && lazy.has(String(tool.name)) && !off.has(String(tool.name)))
      .map((tool) => ({
        name: String(tool.name),
        description: typeof tool.description === "string" ? tool.description : "",
        parameters: tool.parameters,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The lazy tool of this name, or the reason there is none: what the model is told to do instead. */
  private find(name: string): Lazy {
    if (!name) return fail("Name the tool: search finds the names.");
    if (this.host?.off().has(name)) {
      return fail(`"${name}" is switched off in this conversation, here as everywhere. Say that it is switched off rather than looking for another way to it.`);
    }
    const tool = this.lazyTools().find((t) => t.name === name);
    if (tool) return tool;
    const active: string[] = this.host?.session()?.getActiveToolNames?.() ?? [];
    if (active.includes(name)) return fail(`"${name}" is not a lazy tool: call it directly by its own name.`);
    return fail(`There is no lazy tool called "${name}". Use search to find the names.`);
  }

  private search(query: string): ReturnType<typeof say> {
    const lazy = this.lazyTools();
    if (!lazy.length) return say("There are no lazy tools in this conversation.");
    const terms = words(query);
    const scored = lazy
      .map((tool) => {
        const text = words(`${tool.name} ${tool.description}`).join(" ");
        // A term counts where it is in the name or the description, also as the start of a word: "screen" finds "screenshot".
        return { tool, score: terms.filter((term) => text.includes(term)).length };
      })
      .filter((hit) => !terms.length || hit.score > 0)
      .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
    if (!scored.length) return say(`No lazy tool matches "${query}". Search with other words, or with none to list them all.`);
    const shown = scored.slice(0, SEARCH_LIMIT);
    const lines = shown.map(({ tool }) => `- ${tool.name}: ${blurb(tool.description) || "(no description)"}`);
    const more = scored.length > shown.length ? `\n${scored.length - shown.length} more match: narrow the search.` : "";
    return say(`${scored.length} lazy tool${scored.length === 1 ? "" : "s"}${query.trim() ? ` matching "${query.trim()}"` : ""}:\n${lines.join("\n")}${more}\n\nUse describe for the parameters of one, then call.`);
  }

  private describe(name: string): ReturnType<typeof say> {
    const tool = this.find(name);
    return say(`${tool.name}\n\n${tool.description || "(no description)"}\n\nParameters (JSON schema):\n${JSON.stringify(tool.parameters ?? {}, null, 2)}`);
  }

  private async call(id: string, name: string, rawArgs: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) {
    const tool = this.find(name);
    const session = this.host?.session();
    const definition = session?.getToolDefinition?.(tool.name);
    const runner = session?.extensionRunner;
    // Without the hooks the call would skip the guard, so there is no call.
    if (!definition || typeof runner?.emitToolCall !== "function" || typeof runner.emitToolResult !== "function") return fail(`"${tool.name}" cannot be called from here.`);

    // As pi does for a direct call, in its order: prepare the arguments, then validate (and coerce) them against the
    // schema, so the hooks and the tool see what they would see from a direct call. A failure is the call's error.
    let args = argsOf(rawArgs);
    if (typeof definition.prepareArguments === "function") args = argsOf(definition.prepareArguments(args));
    const { validateToolArguments } = await (piAi ??= piDependency("@earendil-works/pi-ai"));
    args = validateToolArguments(definition, { type: "toolCall", id, name: tool.name, arguments: args });

    // As pi does for a direct call: the hooks before it, which may refuse it or change its arguments in place.
    if (runner.hasHandlers("tool_call")) {
      const verdict = await runner.emitToolCall({ type: "tool_call", toolName: tool.name, toolCallId: id, input: args });
      if (verdict?.block) return fail(verdict.reason || `"${tool.name}" was refused.`);
    }

    let result: any;
    let isError = false;
    try {
      result = await definition.execute(id, args, signal, onUpdate, ctx);
    } catch (e) {
      isError = true;
      result = { content: [{ type: "text", text: (e as Error)?.message ?? String(e) }], details: {} };
    }
    // And the hooks after it: what the guard wraps as untrusted, and the taint it takes from it, are read here.
    if (runner.hasHandlers("tool_result")) {
      const hooked = await runner.emitToolResult({
        type: "tool_result",
        toolName: tool.name,
        toolCallId: id,
        input: args,
        content: result?.content,
        details: result?.details,
        isError,
        usage: result?.usage,
      });
      if (hooked) {
        result = { ...result, content: hooked.content ?? result?.content, details: hooked.details ?? result?.details };
        isError = hooked.isError ?? isError;
      }
    }
    if (isError) return fail(textOf(result?.content) || `"${tool.name}" failed.`);
    return { content: result?.content ?? [], details: result?.details ?? {} };
  }

  /** An ExtensionFactory — see pi's InlineExtension. */
  extension = (pi: any): void => {
    this.api = pi;
    this.register(pi);
  };

  private register(pi: any): void {
    pi.registerTool({
      name: GATEWAY_TOOL,
      label: "Tools",
      description:
        "Reach the tools that are not in the list you were given. They are kept out of it so that it stays short, " +
        "and they are all here. action \"search\" finds them (query: words from a name or from what it does; " +
        "no query lists them all), \"describe\" gives the description and parameters of one (name), and " +
        "\"call\" runs one (name, and args: an object of its arguments). Describe a tool before the first call of it.",
      promptSnippet: `${GATEWAY_TOOL} — search, describe and call the tools that are kept out of this list`,
      promptGuidelines: [
        `${lazyHint(this.sets)} A tool it finds is described for its parameters and then called through it.`,
      ],
      parameters: Type.Object({
        action: Type.Union([Type.Literal("search"), Type.Literal("describe"), Type.Literal("call")], {
          description: "search, describe or call",
        }),
        query: Type.Optional(Type.String({ description: "search: words from a tool's name or from what it does" })),
        name: Type.Optional(Type.String({ description: "describe and call: the tool's name, as search lists it" })),
        args: Type.Optional(
          Type.Union([Type.Object({}, { additionalProperties: true }), Type.String()], {
            description: "call: the tool's arguments as an object, or as the JSON text of one, as describe lists them",
          })
        ),
      }),
      execute: async (id: string, p: any, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => {
        const name = typeof p?.name === "string" ? p.name.trim() : "";
        switch (p?.action) {
          case "search":
            return this.search(typeof p.query === "string" ? p.query : "");
          case "describe":
            return this.describe(name);
          case "call":
            return this.call(id, name, p.args, signal, onUpdate, ctx);
          default:
            return fail('action is search, describe or call.');
        }
      },
    });
  }
}
