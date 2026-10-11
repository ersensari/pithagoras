import { test } from "node:test";
import assert from "node:assert/strict";
import { inProcessHome } from "./server-harness.mjs";

/**
 * The dialogs an extension opens with pi's ui calls (confirm, select, input, editor): they wait for a person
 * until they are answered, cancelled or stopped, with no time limit of their own (issue #114). Only a caller
 * that passes a `timeout` has one.
 */
inProcessHome("pithagoras-extension-dialogs-");
const { SdkPiClient } = await import("../dist/pi/sdk-client.js");

/** A client with nothing behind it but the bridge to the page, and the events it sends. */
function bridge() {
  const client = new SdkPiClient({}, {}, () => {});
  const events = [];
  client.on("event", (e) => events.push(e));
  return { client, ui: client.buildUiContext(), events };
}
const closed = (events) => events.filter((e) => e.type === "extension_ui_cancel");
const FIVE_MINUTES = 5 * 60_000;

test("a dialog is still open long after the five minutes it used to be closed at, and answers when it is answered", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const [method, open, answer] of [
    ["confirm", (ui) => ui.confirm("Sure?", "Really"), true],
    ["select", (ui) => ui.select("Pick", ["a", "b"]), "b"],
    ["input", (ui) => ui.input("Name", "type here"), "Ada"],
    ["editor", (ui) => ui.editor("Edit", "text"), "edited"],
  ]) {
    const { client, ui, events } = bridge();
    let result;
    const asked = open(ui).then((v) => { result = { v }; });
    const request = events.find((e) => e.type === "extension_ui_request");
    assert.equal(request.method, method);

    t.mock.timers.tick(FIVE_MINUTES + 1);
    t.mock.timers.tick(24 * 60 * 60_000);
    await Promise.resolve();
    assert.equal(result, undefined, `${method} is not settled by the passing of time`);
    assert.equal(client.dialogsOpen(), 1, `${method} is still waiting`);
    assert.deepEqual(closed(events), [], `${method} was not closed on the pages`);

    assert.equal(client.respondUi(request.id, { value: answer }), true);
    await asked;
    assert.deepEqual(result, { v: answer }, method);
    assert.deepEqual(closed(events).map((e) => [e.id, e.reason]), [[request.id, "answered"]], method);
    assert.equal(client.dialogsOpen(), 0);
  }
});

test("a dialog that waits still ends when it is cancelled or the run is stopped, with the value of no answer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { client, ui, events } = bridge();

  const refused = ui.confirm("Sure?", "Really");
  client.respondUi(events[0].id, { cancelled: true });
  assert.equal(await refused, false);

  const stop = new AbortController();
  const stopped = ui.select("Pick", ["a"], { signal: stop.signal });
  t.mock.timers.tick(FIVE_MINUTES * 2);
  assert.equal(client.dialogsOpen(), 1);
  stop.abort();
  assert.equal(await stopped, undefined);

  assert.deepEqual(closed(events).map((e) => e.reason), ["cancelled", "stopped"]);
  assert.equal(client.dialogsOpen(), 0);
});

test("a caller that names a wait gets it: the dialog closes as a timeout when it is up, and 0 is no wait", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { client, ui, events } = bridge();

  const timed = ui.input("Name", "", { timeout: 1000 });
  const forever = ui.confirm("Sure?", "Really", { timeout: 0 });
  t.mock.timers.tick(999);
  assert.equal(client.dialogsOpen(), 2, "not before its time");
  t.mock.timers.tick(1);
  assert.equal(await timed, undefined);
  assert.deepEqual(closed(events).map((e) => e.reason), ["timeout"]);

  t.mock.timers.tick(FIVE_MINUTES);
  assert.equal(client.dialogsOpen(), 1, "0 waits as the default does");
  client.respondUi(events[1].id, { value: true });
  assert.equal(await forever, true);
});
