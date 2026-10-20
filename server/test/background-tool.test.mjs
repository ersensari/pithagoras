import { test } from "node:test";
import assert from "node:assert/strict";
import { inProcessHome } from "./server-harness.mjs";

inProcessHome("pithagoras-background-");

const { backgroundTool, BACKGROUND_TOOL, BACKGROUND_SOURCE } = await import("../dist/pi/background-tool.js");
const { AUDIO_MESSAGE_PREFIX } = await import("../dist/pi/voice-first.js");

/** A promise the test settles by hand. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A fake pi that records the registered tool and the messages sent back. */
function fakePi() {
  const sent = [];
  let tool;
  const pi = {
    registerTool(def) { tool = def; },
    sendUserMessage(text, options) { sent.push({ text, options }); },
  };
  return { pi, sent, get tool() { return tool; } };
}

/** A fake ctx whose executeTool is the given function, with the named tools callable. */
function fakeCtx(executeTool, names = ["web_search", "generate_image", "read"]) {
  return { tools: names.map((name) => ({ name })), executeTool };
}

/** Registers the tool on a fake pi and returns it with the recorders. */
function setup(spoken = () => false) {
  const fake = fakePi();
  backgroundTool({ spoken })(fake.pi);
  return fake;
}

/** Lets pending promise callbacks run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

const textOf = (result) => result.content.map((c) => c.text).join("\n");

test("registers run_in_background with the source name the settings use", () => {
  const { tool } = setup();
  assert.equal(tool.name, BACKGROUND_TOOL);
  assert.equal(BACKGROUND_SOURCE, "background");
});

test("returns at once with the started text while the nested call is still pending", async () => {
  const { tool, sent } = setup();
  const nested = deferred();
  let seen;
  const ctx = fakeCtx((name, args, options) => { seen = { name, args, signal: options.signal }; return nested.promise; });

  const result = await tool.execute("call-1", { tool: "web_search", args: { query: "rain" }, title: "rain news" }, undefined, undefined, ctx);

  assert.equal(result.details.status, "started");
  assert.equal(result.details.job, 1);
  assert.equal(result.details.tool, "web_search");
  assert.match(textOf(result), /Started in the background as job 1: rain news\./);
  assert.deepEqual(seen.args, { query: "rain" });
  assert.equal(seen.name, "web_search");
  assert.equal(sent.length, 0, "nothing is sent while the job runs");
});

test("on resolve the result is sent once as a follow-up, wrapped, with no audio prefix when typed", async () => {
  const { tool, sent } = setup(() => false);
  const nested = deferred();
  await tool.execute("c", { tool: "web_search", args: {}, title: "news" }, undefined, undefined, fakeCtx(() => nested.promise));

  nested.resolve({ isError: false, result: { content: [{ type: "text", text: "Top story: rain." }], details: {} } });
  await flush();

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].options, { deliverAs: "followUp" });
  const m = sent[0].text;
  assert.ok(!m.startsWith(AUDIO_MESSAGE_PREFIX), "typed turn: no audio marker");
  assert.match(m, /^<background-result job="1" tool="web_search" status="done">\nTop story: rain\./);
  assert.match(m, /The person asked for this earlier \("news"\)\. Tell them the outcome now, in one or two sentences\. /);
  assert.ok(!m.includes("as plain speech"));
  assert.match(m, /<\/background-result>$/);
});

test("a spoken turn at start gets the audio prefix and the plain-speech line, even if the turn ends typed", async () => {
  let spokenNow = true;
  const { tool, sent } = setup(() => spokenNow);
  const nested = deferred();
  await tool.execute("c", { tool: "web_search", args: {} }, undefined, undefined, fakeCtx(() => nested.promise));
  spokenNow = false; // read at start only
  nested.resolve({ isError: false, result: { content: [{ type: "text", text: "ok" }], details: {} } });
  await flush();

  assert.ok(sent[0].text.startsWith(AUDIO_MESSAGE_PREFIX));
  assert.match(sent[0].text, /in one or two sentences, as plain speech\./);
});

test("the result text is capped at 6000 characters", async () => {
  const { tool, sent } = setup();
  const nested = deferred();
  await tool.execute("c", { tool: "web_search", args: {} }, undefined, undefined, fakeCtx(() => nested.promise));
  nested.resolve({ isError: false, result: { content: [{ type: "text", text: "x".repeat(9000) }], details: {} } });
  await flush();

  const body = sent[0].text.split("\n")[1];
  assert.equal(body.length, 6000);
});

test("a saved picture is named in the result so the agent can show it", async () => {
  const { tool, sent } = setup();
  const nested = deferred();
  await tool.execute("c", { tool: "generate_image", args: {} }, undefined, undefined, fakeCtx(() => nested.promise, ["generate_image"]));
  nested.resolve({ isError: false, result: { content: [{ type: "text", text: "Made it." }], details: { path: "pictures/a.png", portalImage: true } } });
  await flush();

  assert.match(sent[0].text, /Made it\.\nPicture saved: pictures\/a\.png/);
});

test("a rejecting nested call sends status=failed with its error text", async () => {
  const { tool, sent } = setup();
  const nested = deferred();
  await tool.execute("c", { tool: "web_search", args: {} }, undefined, undefined, fakeCtx(() => nested.promise));
  nested.reject(new Error("search is down"));
  await flush();

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /<background-result job="1" tool="web_search" status="failed">\nsearch is down\n/);
});

test("an outcome flagged isError sends status=failed", async () => {
  const { tool, sent } = setup();
  await tool.execute("c", { tool: "web_search", args: {} }, undefined, undefined, fakeCtx(async () => ({ isError: true, result: { content: [{ type: "text", text: "bad query" }], details: {} } })));
  await flush();

  assert.match(sent[0].text, /status="failed">\nbad query\n/);
});

test("unknown tool, recursion and a fifth concurrent job are refused with an error result, not thrown", async () => {
  const { tool, sent } = setup();
  const never = () => new Promise(() => {});
  const ctx = fakeCtx(never);

  const unknown = await tool.execute("c", { tool: "no_such_tool", args: {} }, undefined, undefined, ctx);
  assert.match(textOf(unknown), /Unknown tool "no_such_tool"/);
  assert.equal(unknown.details.status, "refused");

  const self = await tool.execute("c", { tool: BACKGROUND_TOOL, args: {} }, undefined, undefined, ctx);
  assert.match(textOf(self), /cannot run itself/);

  for (let i = 0; i < 4; i++) {
    const r = await tool.execute("c", { tool: "web_search", args: {} }, undefined, undefined, ctx);
    assert.equal(r.details.status, "started");
  }
  const fifth = await tool.execute("c", { tool: "web_search", args: {} }, undefined, undefined, ctx);
  assert.equal(fifth.details.status, "refused");
  assert.match(textOf(fifth), /4 background jobs are already running/);
  assert.equal(sent.length, 0);
});

test("a Stop (abort of the run's signal) aborts running jobs and sends nothing", async () => {
  const { tool, sent } = setup();
  const parent = new AbortController();
  const nested = deferred();
  let jobSignal;
  const ctx = fakeCtx((name, args, options) => { jobSignal = options.signal; return nested.promise; });
  await tool.execute("c", { tool: "web_search", args: {} }, parent.signal, undefined, ctx);

  parent.abort();
  assert.equal(jobSignal.aborted, true, "the nested call is told to stop");
  nested.reject(new Error("aborted"));
  await flush();

  assert.equal(sent.length, 0, "a job the person stopped is not reported");
});

test("a throwing ctx.executeTool does not escape and starts nothing", async () => {
  const { tool, sent } = setup();
  const ctx = fakeCtx(() => { throw new Error("boom"); });

  const result = await tool.execute("c", { tool: "web_search", args: {} }, undefined, undefined, ctx);
  assert.equal(result.details.status, "refused");
  assert.match(textOf(result), /Could not start web_search in the background \(boom\)/);
  await flush();
  assert.equal(sent.length, 0);
});

test("a missing ctx.executeTool is refused with a direct-call instruction", async () => {
  const { tool } = setup();
  const result = await tool.execute("c", { tool: "web_search", args: {} }, undefined, undefined, { tools: [{ name: "web_search" }] });
  assert.equal(result.details.status, "refused");
  assert.match(textOf(result), /Call web_search directly/);
});

test("a finished job frees its slot for the next one", async () => {
  const { tool } = setup();
  const done = () => Promise.resolve({ isError: false, result: { content: [], details: {} } });
  const ctx = fakeCtx(done);
  for (let i = 0; i < 6; i++) {
    const r = await tool.execute("c", { tool: "web_search", args: {} }, undefined, undefined, ctx);
    assert.equal(r.details.status, "started", `job ${i + 1} starts`);
    await flush();
  }
});
