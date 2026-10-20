import { Type } from "typebox";
import { AUDIO_MESSAGE_PREFIX } from "./voice-first.js";

/**
 * Slow tools run in the background: a search, a picture or a subagent run
 * takes long enough that a spoken reply would stop mid-sentence while Pi waits
 * for it. This starts the tool, returns at once, and sends its result back as
 * a follow-up message when it settles, so the agent reads it out then.
 */

/** The source name the tool's switch is filed under in the settings (see db.ts). */
export const BACKGROUND_SOURCE = "background";
/** The tool's name, as the model calls it. */
export const BACKGROUND_TOOL = "run_in_background";

/** Jobs of one session running at the same time; a fifth is refused, not queued. */
const MAX_JOBS = 4;
/** Longest result text sent back: a page of search results fits, a whole file does not. */
const MAX_RESULT_CHARS = 6000;

const refused = (text: string) => ({ content: [{ type: "text" as const, text }], details: { status: "refused" } });

/** An ExtensionFactory: one `run_in_background` tool, with a registry of jobs per session. */
export function backgroundTool(opts: { spoken: () => boolean }) {
  return (pi: any) => {
    let counter = 0;
    // Stop aborts these; a job leaves the registry once it settles.
    const running = new Map<number, AbortController>();

    pi.registerTool({
      name: BACKGROUND_TOOL,
      label: "run in background",
      description:
        "Run a SLOW tool in the background so the conversation does not stop: web_search, fetch_content, get_search_content, " +
        "generate_image, edit_image, and subagent runs. Give the tool name and its exact arguments. It returns at once; tell the " +
        "person in one short sentence what you started, then keep talking. When the tool is done its result arrives as a message " +
        "and you tell the person the outcome, briefly. Do not use it for quick tools (read, write, edit, ls, canvas, show_image).",
      parameters: Type.Object({
        tool: Type.String({ description: "The name of the tool to run, e.g. web_search." }),
        args: Type.Optional(Type.Object({}, { additionalProperties: true, description: "The tool's arguments, exactly as it takes them." })),
        title: Type.Optional(Type.String({ description: "A few words for the person, in their language, shown as the job's name." })),
      }),
      execute: async (_id: string, p: { tool?: unknown; args?: unknown; title?: unknown }, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) => {
        const tool = typeof p?.tool === "string" ? p.tool.trim() : "";
        const args = p?.args && typeof p.args === "object" && !Array.isArray(p.args) ? p.args : {};
        const title = (typeof p?.title === "string" ? p.title.trim() : "").slice(0, 120) || tool;

        if (!tool) return refused("Name the tool to run in the background (tool).");
        if (tool === BACKGROUND_TOOL) return refused(`${BACKGROUND_TOOL} cannot run itself. Call the tool you want directly.`);
        if (running.size >= MAX_JOBS) {
          return refused(`${MAX_JOBS} background jobs are already running. Wait for one to finish, or call the tool directly.`);
        }
        // Without these nothing can be run in the background at all: say so, rather than fail later.
        if (typeof ctx?.executeTool !== "function") {
          return refused(`Background runs are not available here. Call ${tool} directly.`);
        }
        const callable = Array.isArray(ctx.tools) && ctx.tools.some((t: any) => t?.name === tool);
        if (!callable) return refused(`Unknown tool "${tool}". Only tools you have can run in the background; check the name.`);

        const n = ++counter;
        // Spoken or typed is read now: the reply to that turn is spoken, whatever the turn ends like.
        const spoken = opts.spoken();
        const controller = new AbortController();
        const onStop = () => controller.abort();
        if (signal?.aborted) controller.abort();
        else signal?.addEventListener("abort", onStop, { once: true });
        const finish = () => {
          running.delete(n);
          signal?.removeEventListener("abort", onStop);
        };

        let pending: Promise<any>;
        running.set(n, controller);
        try {
          // Not awaited: this is what lets the turn go on while the tool runs.
          pending = Promise.resolve(ctx.executeTool(tool, args, { signal: controller.signal }));
        } catch (err) {
          finish();
          const why = err instanceof Error ? err.message : String(err);
          return refused(`Could not start ${tool} in the background (${why}). Call it directly.`);
        }

        const report = (status: "done" | "failed", body: string) => {
          // Stop pressed: nothing is said about a job the person cancelled.
          if (controller.signal.aborted) return;
          const message =
            (spoken ? AUDIO_MESSAGE_PREFIX : "") +
            `<background-result job="${n}" tool="${tool}" status="${status}">\n${body}\n` +
            `The person asked for this earlier ("${title}"). Tell them the outcome now, in one or two sentences${spoken ? ", as plain speech" : ""}. ` +
            `Do not call ${BACKGROUND_TOOL} again for it.</background-result>`;
          try {
            pi.sendUserMessage(message, { deliverAs: "followUp" });
          } catch {
            // The session is gone or closing; nothing else to do with the result.
          }
        };

        pending
          .then((outcome: any) => {
            const parts = Array.isArray(outcome?.result?.content) ? outcome.result.content : [];
            const text = parts
              .filter((c: any) => c?.type === "text" && typeof c.text === "string")
              .map((c: any) => c.text)
              .join("\n")
              .slice(0, MAX_RESULT_CHARS);
            // A picture the tool saved but did not show: the agent may call show_image for it.
            const d = outcome?.result?.details;
            const picture = d && typeof d.path === "string" && d.portalImage ? `\nPicture saved: ${d.path}` : "";
            finish();
            if (outcome?.isError) report("failed", (text || `${tool} failed.`) + picture);
            else report("done", text + picture);
          })
          .catch((err: unknown) => {
            finish();
            report("failed", err instanceof Error ? err.message : String(err));
          });

        return {
          content: [{
            type: "text" as const,
            text: `Started in the background as job ${n}: ${title}. Keep talking with the person; the result arrives in a later message.`,
          }],
          details: { job: n, tool, title, status: "started" },
        };
      },
    });
  };
}
