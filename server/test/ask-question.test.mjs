import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fakeModel, resultsIn } from "./fake-model.mjs";
import { inProcessHome } from "./server-harness.mjs";

/**
 * The ask_question tool as pi runs it (issue #114): where it is registered, that it is in the lists before a
 * chat has reported it, what a model's call comes to once pi has checked it, and what a page that opens
 * while the question waits is shown.
 */
const home = inProcessHome("pithagoras-ask-question-");

/** What the model does at its next request: a call of ask_question with `call`, then an answer. */
let call;
const model = await fakeModel((request) => (resultsIn(request) > 0 ? "Done." : { name: "ask_question", args: call }));
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify(model.models()));

const { SdkPiClient } = await import("../dist/pi/sdk-client.js");
const { createSession, shownTools } = await import("../dist/db.js");
const { sessions } = await import("../dist/session-manager.js");

let n = 0;
/** A client for a chat of the kind `opts` say, its events kept. */
async function open(opts = {}) {
  const sessionId = `ask-${++n}`;
  const client = await SdkPiClient.create({
    cwd: mkdtempSync(path.join(process.env.WORKSPACE_ROOT, "chat-")), sessionDir: mkdtempSync(path.join(home, "chat-")),
    provider: "fake", modelId: "m", sessionId, ...opts,
  });
  const events = [];
  client.on("event", (e) => events.push(e));
  return { client, events };
}
const named = async (client) => (await client.getTools()).map((t) => t.name);
const until = async (check) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 25)); assert.ok(check(), "it came"); };

test("the tool is registered where a person is looking at the chat, and not in a routine, heartbeat, channel or guest chat", async () => {
  for (const [what, opts, has] of [
    ["a chat", {}, true],
    ["a chat of the owner", { role: "primary" }, true],
    ["a channel's", { routineTools: true }, false],
    ["a routine run", { routineSlug: "nightly" }, false],
    ["a heartbeat", { heartbeatAgent: "helper" }, false],
    ["a guest's", { role: "guest" }, false],
  ]) {
    const { client } = await open(opts);
    try {
      assert.equal((await named(client)).includes("ask_question"), has, what);
    } finally {
      client.dispose();
    }
  }
});

test("the tool lists know it before any chat has reported it, and an idle chat of another kind does not show it", async () => {
  // Nothing remembered yet, as on an install that has just been updated to this build.
  const tool = shownTools().find((t) => t.name === "ask_question");
  assert.deepEqual(tool && { source: tool.source, inline: tool.inline }, { source: "ask-question", inline: true });

  const make = (id, kind, extra = {}) => createSession({ id, title: id, workspace: process.env.WORKSPACE_ROOT, executor: "host", kind, ...extra });
  make("idle-task", "task");
  make("idle-routine", "routine", { routine_slug: "nightly" });
  make("idle-heartbeat", "heartbeat");
  make("idle-agent", "agent");
  const listed = async (id) => (await sessions.getTools(id)).tools.map((t) => t.name).includes("ask_question");
  assert.equal(await listed("idle-task"), true);
  assert.equal(await listed("idle-routine"), false);
  assert.equal(await listed("idle-heartbeat"), false);
  assert.equal(await listed("idle-agent"), false);
});

test("a question waits for a page that opens later, and is answered through the dialog route", async () => {
  // Bare-string options and ids that are inherited object keys: pi must pass the call, and the answer must be the person's.
  call = { questions: [{ id: "constructor", question: "Pick", options: ["A", "B"] }, { id: "__proto__", question: "Several", kind: "multiple", options: ["x", "y"], optional: true }] };
  const { client, events } = await open();
  try {
    await client.prompt("Ask me");
    await until(() => events.some((e) => e.type === "extension_ui_request"));
    const request = events.find((e) => e.type === "extension_ui_request");
    assert.equal(request.method, "questions");
    assert.deepEqual(request.questions[0].options, [{ label: "A" }, { label: "B" }]);
    // What a page attaching now is shown: the same request, under the same id.
    assert.deepEqual(client.openQuestionRequests(), [request]);

    assert.equal(client.respondUi(request.id, { value: JSON.parse('{"constructor":"B","__proto__":["y"]}') }), true);
    assert.deepEqual(client.openQuestionRequests(), [], "answered: nothing left to show");
    await until(() => events.some((e) => e.type === "agent_settled"));
    const result = events.find((e) => e.type === "tool_execution_end");
    assert.equal(result.isError, false);
    const text = result.result.content[0].text;
    assert.match(text, /1\. Pick\n\s+Chosen: B/);
    assert.match(text, /2\. Several\n\s+Chosen: y/);
  } finally {
    client.dispose();
  }
});

test("a question nobody answers has no answer, rather than one the object it is kept in has", async () => {
  call = { questions: [{ id: "constructor", question: "Pick", options: ["A", "B"], optional: true }] };
  const { client, events } = await open();
  try {
    await client.prompt("Ask me");
    await until(() => events.some((e) => e.type === "extension_ui_request"));
    client.respondUi(events.find((e) => e.type === "extension_ui_request").id, { value: {} });
    await until(() => events.some((e) => e.type === "agent_settled"));
    const text = events.find((e) => e.type === "tool_execution_end").result.content[0].text;
    assert.match(text, /No answer \(it was optional\)/);
    assert.doesNotMatch(text, /native code/);
  } finally {
    client.dispose();
  }
});

test("Stop closes the dialog on every page that has it", async () => {
  call = { questions: [{ question: "Pick", options: ["A", "B"] }] };
  const { client, events } = await open();
  try {
    await client.prompt("Ask me");
    await until(() => events.some((e) => e.type === "extension_ui_request"));
    const { id } = events.find((e) => e.type === "extension_ui_request");
    await client.abort();
    await until(() => events.some((e) => e.type === "extension_ui_cancel" && e.id === id));
    assert.deepEqual(client.openQuestionRequests(), []);
  } finally {
    client.dispose();
  }
});

test("a page that opens a chat with a question waiting is sent it before the stream is caught up", async () => {
  const { default: express } = await import("express");
  const { eventsRouter } = await import("../dist/api/events.js");
  createSession({ id: "waiting", title: "waiting", workspace: process.env.WORKSPACE_ROOT, executor: "host" });
  const request = { type: "extension_ui_request", id: "q-1", method: "questions", questions: [{ id: "q1", question: "Pick", kind: "single", options: [{ label: "A" }], other: false, optional: false }] };
  sessions.live.set("waiting", { client: { openQuestionRequests: () => [request] } });
  const app = express().use("/api", eventsRouter());
  const server = app.listen(0);
  const abort = new AbortController();
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/waiting/events`, { signal: abort.signal });
    let text = "";
    const reader = res.body.getReader();
    while (!text.includes("event: caught-up")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    const frames = text.split("\n\n").filter((f) => f.startsWith("data: ")).map((f) => JSON.parse(f.slice(6)));
    const sent = frames.find((f) => f.type === "extension_ui_request");
    assert.ok(sent, "the question came");
    assert.ok(sent.seq < 0, "live only: it never moves the page's cursor");
    assert.deepEqual(sent.payload, request);
    assert.ok(text.indexOf("extension_ui_request") < text.indexOf("event: caught-up"));
  } finally {
    abort.abort();
    sessions.live.delete("waiting");
    server.close();
  }
});
