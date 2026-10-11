import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { LuArrowDown, LuArrowUp, LuCheck, LuMessageCircleQuestion, LuX } from "react-icons/lu";
import { api } from "../api";
import { isEscape } from "../shortcuts";
import { t } from "../i18n";
import { useLeaveRef } from "../motion";
import { useDialogFocus } from "../dialog-focus";
import { codeAreaCls, inputCls, primarySmCls } from "./SettingsUi";

/** A question of the agent's ask_question tool, as the server settled it (see server/src/pi/ask-question.ts). */
export interface AgentQuestion {
  id: string;
  question: string;
  kind: "single" | "multiple" | "text" | "ranking";
  options: { label: string; description?: string }[];
  other: boolean;
  optional: boolean;
}

/** What the person has put in for one question. Kept apart from the answer sent, which is made of it. */
interface Draft {
  /** single: the pick; text: the text. */
  one: string;
  /** multiple: the picks. */
  many: string[];
  /** ranking: the options in the order the person has put them. */
  order: string[];
  /** ranking: the person moved something or kept the order, so it is theirs and not the agent's own. */
  ranked: boolean;
  /** The "other" choice is ticked, and what was typed for it. */
  otherOn: boolean;
  other: string;
}

const emptyDraft = (q: AgentQuestion): Draft => ({ one: "", many: [], order: q.options.map((o) => o.label), ranked: false, otherOn: false, other: "" });

/** The answer a draft stands for, or undefined while there is none. A ranking is one once the person has moved or kept the order: the order it starts in is the agent's. */
function answerOf(q: AgentQuestion, d: Draft): string | string[] | undefined {
  const typed = d.otherOn ? d.other.trim() : "";
  if (q.kind === "text") return d.one.trim() || undefined;
  if (q.kind === "ranking") return d.ranked ? d.order : undefined;
  if (q.kind === "single") return (d.otherOn ? typed : d.one) || undefined;
  const picks = [...d.many, ...(typed ? [typed] : [])];
  return picks.length ? picks : undefined;
}

/**
 * The agent asking the person several things at once: choose one, choose several, type, or put options in order.
 * It answers the same request route as an extension's menu (see ExtensionDialog), with the answers by question.
 */
export function QuestionDialog({
  sessionId,
  requestId,
  title,
  questions,
  onDone,
}: {
  sessionId: string;
  requestId: string;
  title?: string;
  questions: AgentQuestion[];
  onDone: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => Object.fromEntries(questions.map((q) => [q.id, emptyDraft(q)])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const leaving = useLeaveRef<HTMLDivElement>("dialog");
  const dialog = useDialogFocus<HTMLDivElement>();
  const heading = title || t("Questions from the agent");

  const change = (id: string, patch: Partial<Draft>) => setDrafts((all) => ({ ...all, [id]: { ...all[id], ...patch } }));
  const answers = Object.fromEntries(questions.flatMap((q) => { const a = answerOf(q, drafts[q.id]); return a === undefined ? [] : [[q.id, a]]; }));
  const complete = questions.every((q) => q.optional || Object.hasOwn(answers, q.id));

  const respond = async (payload: { value?: unknown; cancelled?: boolean }) => {
    if (busy) return;
    if (payload.cancelled && error) { onDone(); return; }
    setBusy(true);
    setError("");
    try {
      const result = await api.respondUi(sessionId, requestId, payload);
      if (!result.ok) { setError(result.note || t("This question has expired. Your answer was not delivered.")); return; }
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => isEscape(e) && respond({ cancelled: true });
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [requestId, busy, error]);

  // A button that is moved in the page loses the focus, and one that has just become disabled cannot have it:
  // so the row that was moved gets it back on the arrow still there to press, once the new order is drawn.
  const arrows = useRef(new Map<string, HTMLButtonElement>());
  const refocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    const key = refocus.current;
    refocus.current = null;
    const arrow = key ? arrows.current.get(key) : undefined;
    if (arrow && !arrow.disabled) arrow.focus();
    else if (key) dialog.current?.focus();
  });

  const move = (q: AgentQuestion, from: number, by: number) => {
    const order = [...drafts[q.id].order];
    const to = from + by;
    const label = order[from];
    [order[from], order[to]] = [order[to], order[from]];
    const next = by < 0 ? (to === 0 ? "down" : "up") : to === order.length - 1 ? "up" : "down";
    refocus.current = `${q.id}\n${label}\n${next}`;
    change(q.id, { order, ranked: true });
  };
  // "Keep this order" goes away once pressed, and the focus with it: it goes to the first row's arrow, or to the dialog when that row cannot move.
  const keep = (q: AgentQuestion) => {
    refocus.current = `${q.id}\n${drafts[q.id].order[0]}\ndown`;
    change(q.id, { ranked: true });
  };
  const arrow = (q: AgentQuestion, label: string, dir: "up" | "down") => (el: HTMLButtonElement | null) => {
    const key = `${q.id}\n${label}\n${dir}`;
    if (el) arrows.current.set(key, el);
    else arrows.current.delete(key);
  };

  return (
    <div
      ref={leaving}
      className="ui-backdrop fixed inset-0 z-[60] flex items-center justify-center bg-canvas/80 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        void respond({ cancelled: true });
      }}
    >
      <div
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={heading}
        className="ui-dialog flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-pop outline-none"
      >
        <header className="flex items-start gap-3 border-b border-line px-4 py-3">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent/12 text-accent">
            <LuMessageCircleQuestion className="h-4 w-4" />
          </div>
          <h2 className="min-w-0 flex-1 self-center text-sm font-medium text-fg">{heading}</h2>
          <button
            onClick={() => respond({ cancelled: true })}
            className="rounded-lg p-1 text-fg-subtle transition hover:bg-fg/10 hover:text-fg"
            aria-label={t("Close")}
          >
            <LuX className="h-4 w-4" />
          </button>
        </header>

        {error && <p role="alert" className="border-b border-line px-4 py-3 text-sm text-danger">{error}</p>}
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
          {questions.map((q) => {
            const d = drafts[q.id];
            const legend = `${q.question}${q.optional ? ` (${t("optional")})` : ""}`;
            return (
              <fieldset key={q.id} className="min-w-0" disabled={busy}>
                <legend className="mb-2 text-sm font-medium text-fg">{legend}</legend>

                {(q.kind === "single" || q.kind === "multiple") && (
                  <div className="space-y-1">
                    {q.options.map((o) => (
                      <label key={o.label} className="flex cursor-pointer items-start gap-2.5 rounded-lg p-1.5 hover:bg-fg/5">
                        <input
                          type={q.kind === "single" ? "radio" : "checkbox"}
                          name={`${requestId}-${q.id}`}
                          checked={q.kind === "single" ? !d.otherOn && d.one === o.label : d.many.includes(o.label)}
                          onChange={(e) =>
                            q.kind === "single"
                              ? change(q.id, { one: o.label, otherOn: false })
                              : change(q.id, { many: e.target.checked ? [...d.many, o.label] : d.many.filter((m) => m !== o.label) })
                          }
                          className="mt-0.5 accent-current"
                        />
                        <span className="min-w-0 text-sm text-fg">
                          {o.label}
                          {o.description && <span className="mt-0.5 block text-xs text-fg-faint">{o.description}</span>}
                        </span>
                      </label>
                    ))}
                    {q.other && (
                      <div className="flex items-center gap-2.5 rounded-lg p-1.5">
                        <input
                          type={q.kind === "single" ? "radio" : "checkbox"}
                          name={`${requestId}-${q.id}`}
                          aria-label={t("Another answer")}
                          checked={d.otherOn}
                          onChange={(e) => change(q.id, { otherOn: q.kind === "single" ? true : e.target.checked })}
                          className="accent-current"
                        />
                        <input
                          value={d.other}
                          onChange={(e) => change(q.id, { other: e.target.value, otherOn: true })}
                          aria-label={t("Type your own answer")}
                          placeholder={t("Another answer")}
                          className={`${inputCls} py-1.5 text-fg`}
                        />
                      </div>
                    )}
                  </div>
                )}

                {q.kind === "text" && (
                  <textarea
                    rows={3}
                    aria-label={q.question}
                    value={d.one}
                    onChange={(e) => change(q.id, { one: e.target.value })}
                    className={`${codeAreaCls} resize-y font-sans text-sm text-fg`}
                  />
                )}

                {q.kind === "ranking" && (
                  <>
                    <p className="mb-1 text-xs text-fg-faint">{t("Best first. Move an option with the arrows.")}</p>
                    <ol className="space-y-1">
                      {d.order.map((label, i) => (
                        <li key={label} className="flex items-center gap-2 rounded-lg border border-line bg-raised/40 px-2 py-1.5">
                          <span className="w-5 text-center text-xs text-fg-subtle">{i + 1}</span>
                          <span className="min-w-0 flex-1 text-sm text-fg">
                            {label}
                            {q.options.find((o) => o.label === label)?.description && (
                              <span className="mt-0.5 block text-xs text-fg-faint">{q.options.find((o) => o.label === label)?.description}</span>
                            )}
                          </span>
                          <button
                            ref={arrow(q, label, "up")}
                            disabled={i === 0}
                            onClick={() => move(q, i, -1)}
                            aria-label={t("Move {option} up", { option: label })}
                            className="rounded-md p-1 text-fg-muted transition hover:bg-fg/10 disabled:opacity-30"
                          >
                            <LuArrowUp className="h-3.5 w-3.5" />
                          </button>
                          <button
                            ref={arrow(q, label, "down")}
                            disabled={i === d.order.length - 1}
                            onClick={() => move(q, i, 1)}
                            aria-label={t("Move {option} down", { option: label })}
                            className="rounded-md p-1 text-fg-muted transition hover:bg-fg/10 disabled:opacity-30"
                          >
                            <LuArrowDown className="h-3.5 w-3.5" />
                          </button>
                        </li>
                      ))}
                    </ol>
                    {!d.ranked && (
                      <button type="button" onClick={() => keep(q)} className="mt-1.5 rounded-lg px-2 py-1 text-xs text-fg-muted hover:bg-fg/10">
                        {t("Keep this order")}
                      </button>
                    )}
                  </>
                )}
              </fieldset>
            );
          })}
        </div>

        <footer className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <button onClick={() => respond({ cancelled: true })} className="rounded-lg px-3 py-1.5 text-sm text-fg-muted hover:bg-fg/10">
            {t("Cancel")}
          </button>
          <button disabled={busy || !complete} onClick={() => respond({ value: answers })} className={primarySmCls}>
            <LuCheck className="h-3.5 w-3.5" /> {t("Submit")}
          </button>
        </footer>
      </div>
    </div>
  );
}
