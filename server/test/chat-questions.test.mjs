import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fakeModel } from "./fake-model.mjs";
import { inProcessHome } from "./server-harness.mjs";

/**
 * The agent's ask_question questions kept with the chat (issue #114): a question is stored until it ends, so it
 * is there after a restart of the portal, and how it ended (answered, cancelled, its wait up, its run stopped) is
 * written down beside it as its record in the transcript.
 */
inProcessHome("pithagoras-chat-questions-");
const model = await fakeModel();
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify(model.models()));

const { appendEvent, createSession, getDb, getSettings, setSettings } = await import("../dist/db.js");
const { openChatQuestions } = await import("../dist/questions.js");
const { sessions } = await import("../dist/session-manager.js");
setSettings({ ...getSettings(), provider: "fake", model: "m" });

const questions = [
  { id: "db", question: "Which database?", kind: "single", options: [{ label: "SQLite" }, { label: "Postgres" }], other: false, optional: false },
  { id: "why", question: "Anything else?", kind: "text", options: [], other: false, optional: true },
];

const chat = (id) => createSession({ id, title: id, workspace: process.env.WORKSPACE_ROOT, executor: "host", kind: "task" });
/** The question events of a chat, as stored. */
const stored = (id) =>
  getDb()
    .prepare("SELECT type, payload FROM events WHERE session_id = ? AND type IN ('portal_question', 'portal_question_end') ORDER BY seq")
    .all(id)
    .map((r) => ({ type: r.type, ...JSON.parse(r.payload) }));
const ends = (id) => stored(id).filter((e) => e.type === "portal_question_end").map(({ type: _type, ...end }) => end);

/** The messages the chat would have been sent, instead of starting its pi for them. */
const sent = [];
const prompt = sessions.prompt;
sessions.prompt = async (sessionId, message) => (sent.push({ sessionId, message }), true);

test("a question asked in a chat is kept in the database, and a portal started afresh lists it as open", async () => {
  chat("kept");
  const client = await sessions.ensureClient("kept");
  try {
    // Not awaited: it waits for an answer that this test never gives.
    void client.buildUiContext().questions({ title: "A few questions", questions });
    const [asked] = stored("kept");
    assert.equal(asked.type, "portal_question");
    assert.equal(asked.title, "A few questions");
    assert.deepEqual(asked.questions, questions);
    assert.equal(asked.until, undefined, "no wait: until it is answered");
    // A page that opens the chat is sent it with the stream, for a long chat whose loaded end does not reach it.
    assert.deepEqual(sessions.liveSnapshot("kept").filter((r) => r.type === "portal_question").map((r) => JSON.parse(r.payload).id), [asked.id]);
    assert.deepEqual(sessions.liveSnapshot("kept").filter((r) => r.type === "extension_ui_request"), [], "not also as a dialog");

    // Another process on the same database: what the portal finds when it starts again.
    const script = `const q = await import(${JSON.stringify(new URL("../dist/questions.js", import.meta.url).href)}); console.log(JSON.stringify(q.openChatQuestions("kept")));`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: process.env, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), [{ id: asked.id, title: "A few questions", questions }]);
  } finally {
    client.dispose();
  }
});

test("an answer the run is waiting for goes to it, and is written down as the question's record", async () => {
  chat("live");
  const client = await sessions.ensureClient("live");
  try {
    const answer = client.buildUiContext().questions({ questions });
    const [{ id }] = stored("live");
    assert.equal(sessions.respondUi("live", id, { value: { db: "Postgres", why: "  soon " } }), true);
    assert.deepEqual(await answer, { db: "Postgres", why: "  soon " });
    assert.deepEqual(ends("live"), [{ of: id, outcome: "answered", answers: { db: "Postgres", why: "soon" } }]);
    assert.deepEqual(openChatQuestions("live"), []);
    assert.deepEqual(sent, [], "the run had it: no message as well");
    // Answered once: a second answer is not taken.
    assert.equal(sessions.respondUi("live", id, { value: { db: "SQLite" } }), false);
    assert.equal(ends("live").length, 1);
  } finally {
    client.dispose();
  }
});

test("an answer to a question nothing waits for any more is written down, and goes to the agent as a message", async () => {
  // As the portal finds a question that was open when it stopped: in the database, and no pi waiting on it.
  chat("restarted");
  appendEvent("restarted", "portal_question", { id: "q-old", questions });
  assert.equal(sessions.respondUi("restarted", "q-old", { value: { db: "SQLite" } }), true);
  assert.deepEqual(ends("restarted"), [{ of: "q-old", outcome: "answered", answers: { db: "SQLite" } }]);
  assert.deepEqual(openChatQuestions("restarted"), []);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sessionId, "restarted");
  assert.match(sent[0].message, /^<answer-from-primary>/);
  assert.match(sent[0].message, /1\. Which database\?\n\s+Chosen: SQLite/);
  assert.match(sent[0].message, /2\. Anything else\?\n\s+No answer \(it was optional\)/);
  sent.length = 0;
});

test("a cancelled question is written down as cancelled, with no answers, and nothing is sent", async () => {
  chat("cancelled");
  appendEvent("cancelled", "portal_question", { id: "q-c", questions });
  assert.equal(sessions.respondUi("cancelled", "q-c", { cancelled: true, value: { db: "SQLite" } }), true);
  assert.deepEqual(ends("cancelled"), [{ of: "q-c", outcome: "cancelled" }]);
  assert.deepEqual(openChatQuestions("cancelled"), []);
  assert.deepEqual(sent, []);

  // The same while the run waits: the run is told there is no answer.
  chat("cancelled-live");
  const client = await sessions.ensureClient("cancelled-live");
  try {
    const answer = client.buildUiContext().questions({ questions });
    const [{ id }] = stored("cancelled-live");
    assert.equal(sessions.respondUi("cancelled-live", id, { cancelled: true }), true);
    assert.equal(await answer, undefined);
    assert.deepEqual(ends("cancelled-live"), [{ of: id, outcome: "cancelled" }]);
  } finally {
    client.dispose();
  }
});

test("a question whose wait ends is written down as not answered, also when the portal restarted in between", async () => {
  chat("timed");
  const client = await sessions.ensureClient("timed");
  try {
    const answer = client.buildUiContext().questions({ questions }, { timeout: 50 });
    const [asked] = stored("timed");
    assert.equal(typeof asked.until, "number", "when the wait ends goes with it");
    assert.equal(await answer, undefined);
    assert.deepEqual(ends("timed"), [{ of: asked.id, outcome: "expired" }]);
    assert.equal(sessions.respondUi("timed", asked.id, { value: { db: "SQLite" } }), false, "too late");
    assert.equal(ends("timed").length, 1);
  } finally {
    client.dispose();
  }

  // Its timer went with the portal that asked it: one found past its wait ends when the chat is next opened.
  chat("timed-restarted");
  appendEvent("timed-restarted", "portal_question", { id: "q-t", questions, until: Date.now() - 1000 });
  assert.deepEqual(sessions.liveSnapshot("timed-restarted").filter((r) => r.type === "portal_question"), []);
  assert.deepEqual(ends("timed-restarted"), [{ of: "q-t", outcome: "expired" }]);
  // And one answered first, before anything looked: too late as well, and nothing is sent.
  chat("timed-answered");
  appendEvent("timed-answered", "portal_question", { id: "q-a", questions, until: Date.now() - 1000 });
  assert.equal(sessions.respondUi("timed-answered", "q-a", { value: { db: "SQLite" } }), false);
  assert.deepEqual(ends("timed-answered"), [{ of: "q-a", outcome: "expired" }]);
  assert.deepEqual(sent, []);
});

test("Stop ends a waiting question, written down as not answered because the run was stopped", async () => {
  chat("stopped");
  const client = await sessions.ensureClient("stopped");
  try {
    const answer = client.buildUiContext().questions({ questions });
    const [{ id }] = stored("stopped");
    await client.abort();
    assert.equal(await answer, undefined);
    assert.deepEqual(ends("stopped"), [{ of: id, outcome: "stopped" }]);
    assert.deepEqual(openChatQuestions("stopped"), []);
  } finally {
    client.dispose();
    sessions.prompt = prompt;
  }
});
