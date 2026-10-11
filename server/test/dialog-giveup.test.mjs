import { test } from "node:test";
import assert from "node:assert/strict";
import { inProcessHome } from "./server-harness.mjs";

/**
 * A run that somebody waits for through ask() (a channel's message, a routine, a heartbeat look) has nobody
 * in front of a page to answer an extension's dialog. When the ask gives up at its own limit, the dialog must
 * not stay open and keep the chat "running" (issue #114, round 5): it closes with the value of no answer.
 */
const home = inProcessHome("pithagoras-dialog-giveup-");

const { createSession } = await import("../dist/db.js");
const { SdkPiClient } = await import("../dist/pi/sdk-client.js");
const { sessions } = await import("../dist/session-manager.js");

/** A client with nothing behind it but the bridge to the page; what sessions.ask needs of pi is stubbed on it. */
function fakePi() {
  const client = new SdkPiClient({}, {}, () => {});
  client.abort = async () => {};
  client.dispose = () => {};
  Object.defineProperty(client, "running", { get: () => true });
  client.ui = client.buildUiContext();
  return client;
}
let pi;
SdkPiClient.create = async () => (pi = fakePi());

test("an ask that gives up closes the dialog its run is waiting on, and the agent gets the value of no answer", async () => {
  createSession({ id: "gave-up", title: "gave up", workspace: home, executor: "host" });
  let confirmed;
  sessions.submit = async () => {
    setImmediate(() => {
      pi.emit("event", { type: "agent_start" });
      confirmed = pi.ui.confirm("Delete it?", "Really").then((v) => { confirmed = v; });
    });
  };
  const uiEvents = [];
  await assert.rejects(
    sessions.ask("gave-up", "go", { timeoutMs: 100, onUi: (r) => uiEvents.push(r) }),
    /did not finish within/,
  );
  // Not awaited bare: on a build that leaves the dialog open this must fail, not hang.
  await Promise.race([confirmed, new Promise((r) => setTimeout(r, 200))]);

  assert.equal(confirmed, false, "the dialog was settled with a confirm's value of no answer");
  assert.equal(pi.dialogsOpen(), 0, "pi is not left waiting, so the chat is not blocked by it");
  assert.deepEqual(pi.openDialogRequests(), [], "nothing for a page that opens later to be shown");
  assert.deepEqual(sessions.liveSnapshot("gave-up").filter((e) => /extension_ui_request/.test(JSON.stringify(e))), []);
  assert.deepEqual(uiEvents.map((r) => [r.method ?? "cancel", r.reason]), [["confirm", undefined], ["cancel", "timeout"]], "the channel is told it timed out");

  // The same run goes on after the ask gave up: its next dialog gets no wait either, and is never shown.
  const events = [];
  pi.on("event", (e) => events.push(e));
  const later = await pi.ui.confirm("And this?", "Really");
  assert.equal(later, false, "a confirm's value of no answer");
  assert.equal(pi.dialogsOpen(), 0);
  assert.deepEqual(events.filter((e) => e.type === "extension_ui_request"), [], "nobody is shown a dialog nobody can answer");
});

test("what closes a dialog on giving up is its own value of no answer, and the next prompt waits for a person again", async () => {
  const client = fakePi();
  client.session = { sessionFile: undefined };
  const ui = client.buildUiContext();
  const events = [];
  client.on("event", (e) => events.push(e));

  const confirm = ui.confirm("Sure?", "Really");
  const select = ui.select("Pick", ["a"]);
  assert.equal(client.giveUpDialogs(), 2);
  assert.equal(await confirm, false);
  assert.equal(await select, undefined);
  assert.deepEqual(events.filter((e) => e.type === "extension_ui_cancel").map((e) => e.reason), ["timeout", "timeout"]);

  // A prompt starts the next run afresh.
  client.session = { prompt: async () => {}, isStreaming: false, sessionFile: undefined };
  await client.prompt("again").catch(() => {});
  const waiting = ui.confirm("Sure?", "Really");
  assert.equal(client.dialogsOpen(), 1, "waits for an answer");
  client.respondUi(events.filter((e) => e.type === "extension_ui_request").at(-1).id, { value: true });
  assert.equal(await waiting, true);
});
