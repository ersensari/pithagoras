import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { freePort, inProcessHome, serverEnv, startServer } from "./server-harness.mjs";

/**
 * Lazy tool sets (#106): a large set is opt-in, so it is not in the prompt of a conversation that
 * never asked for it; the model reaches its tools through the `tools` tool instead (tools-gateway
 * .test.mjs runs that end to end). Against the whole server: what Settings → Tools reads and writes,
 * what a chat, a project and a later registration make of it, and what a running chat is told.
 */
const home = inProcessHome("pithagoras-tools-lazy-");
mkdirSync(path.join(home, "ws", "research"), { recursive: true });
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({}));

const db = await import("../dist/db.js");
const { sessions } = await import("../dist/session-manager.js");
const heavy = [
  { name: "heavy_open", source: "pi-heavy", package: null },
  { name: "heavy_read", source: "pi-heavy", package: null },
];
const light = [{ name: "web_search", source: "pi-web-access", package: null }];

let base;
before(async () => {
  ({ base } = await startServer(serverEnv(home, await freePort())));
});

const send = (url, method, body) =>
  fetch(base + url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (url, method = "GET", body) => {
  const res = await send(url, method, body);
  assert.ok(res.ok, `${url}: ${res.status} ${await res.clone().text()}`);
  return res.json();
};
const states = (r) => Object.fromEntries(r.tools.map((t) => [t.name, t.enabled]));
/** The tools a page marks as reached through the `tools` tool. */
const lazyOf = (r) => r.tools.filter((t) => t.lazy).map((t) => t.name).sort();

beforeEach(async () => {
  db.getDb().exec("DELETE FROM settings WHERE key IN ('tools_seen', 'tools_off_default', 'tools_lazy'); DELETE FROM project_tools;");
  db.rememberTools([...heavy, ...light]);
});

test("nothing is lazy until somebody says so: every tool is offered as it was", async () => {
  const page = await json("/api/tools");
  assert.deepEqual(page.lazy, []);
  assert.deepEqual(page.off, []);
  const chat = await json("/api/sessions", "POST", {});
  assert.deepEqual(states(await json(`/api/sessions/${chat.id}/tools`)), { heavy_open: true, heavy_read: true, web_search: true });
});

test("a lazy set is off for a new chat, and the other sets are not touched", async () => {
  const done = await json("/api/tools/lazy", "PUT", { lazy: ["pi-heavy"] });
  assert.deepEqual(done.lazy, ["pi-heavy"]);
  assert.deepEqual(done.off, ["heavy_open", "heavy_read"]);

  const page = await json("/api/tools");
  assert.deepEqual(page.lazy, ["pi-heavy"]);
  assert.deepEqual(Object.fromEntries(page.tools.map((t) => [t.name, t.defaultOn])), { heavy_open: false, heavy_read: false, web_search: true });
  // Off by default and reached through the `tools` tool: marked so on the page, for the set alone.
  assert.deepEqual(lazyOf(page), ["heavy_open", "heavy_read"]);
  const chat = await json("/api/sessions", "POST", {});
  const listed = await json(`/api/sessions/${chat.id}/tools`);
  assert.deepEqual(states(listed), { heavy_open: false, heavy_read: false, web_search: true });
  assert.deepEqual(lazyOf(listed), ["heavy_open", "heavy_read"]);
});

test("a chat and a project switch a lazy set on for themselves", async () => {
  await json("/api/tools/lazy", "PUT", { lazy: ["pi-heavy"] });
  const chat = await json("/api/sessions", "POST", {});
  await json(`/api/sessions/${chat.id}/tools`, "PUT", { off: [] });
  assert.deepEqual(states(await json(`/api/sessions/${chat.id}/tools`)), { heavy_open: true, heavy_read: true, web_search: true });
  assert.deepEqual(db.sessionTools(chat.id), { off: [], on: ["heavy_open", "heavy_read"] });
  // On, so offered one by one and not through the gateway.
  assert.deepEqual(lazyOf(await json(`/api/sessions/${chat.id}/tools`)), []);

  // Another chat is still without it.
  const other = await json("/api/sessions", "POST", {});
  assert.equal(states(await json(`/api/sessions/${other.id}/tools`)).heavy_open, false);
  assert.deepEqual(lazyOf(await json(`/api/sessions/${other.id}/tools`)), ["heavy_open", "heavy_read"]);

  await json("/api/projects/research/tools", "PUT", { off: [] });
  const inProject = await json("/api/sessions", "POST", { workspace: "research" });
  assert.equal(states(await json(`/api/sessions/${inProject.id}/tools`)).heavy_open, true);
  assert.deepEqual(lazyOf(await json(`/api/projects/research/tools`)), []);
});

test("a running chat is told what is off and which of that is lazy, and a tool it switched off itself is not", async () => {
  const told = [];
  const chat = await json("/api/sessions", "POST", {});
  sessions.live.set(chat.id, {
    client: {
      getTools: async () => [...heavy, ...light].map((t) => ({ name: t.name, source: t.source, enabled: true })),
      setToolsOff: async (off, lazy) => { told.push({ off, lazy }); },
    },
  });
  try {
    db.setLazyToolSets(["pi-heavy"]);
    await sessions.applyToolDefaults();
    assert.deepEqual(told.at(-1), { off: ["heavy_open", "heavy_read"], lazy: ["heavy_open", "heavy_read"] });

    // web_search is off by the chat's own say-so: off for good, and the gateway is no way round that.
    await sessions.setTools(chat.id, ["web_search", "heavy_open", "heavy_read"]);
    assert.deepEqual(told.at(-1), { off: ["heavy_open", "heavy_read", "web_search"], lazy: ["heavy_open", "heavy_read"] });

    // A tool switched on is not lazy; the other still is.
    await sessions.setTools(chat.id, ["heavy_read"]);
    assert.deepEqual(told.at(-1), { off: ["heavy_read"], lazy: ["heavy_read"] });

    // A set that stops being lazy stays off, and off for good.
    db.setLazyToolSets([]);
    await sessions.applyToolDefaults();
    assert.deepEqual(told.at(-1), { off: ["heavy_read"], lazy: [] });
  } finally {
    sessions.live.delete(chat.id);
  }
});

test("a tool that a conversation switched off itself is off, not lazy", async () => {
  await json("/api/tools/lazy", "PUT", { lazy: ["pi-heavy"] });
  db.rememberTools([{ name: "heavy_write", source: "pi-heavy", package: null }]);
  const chat = await json("/api/sessions", "POST", {});
  // Switched on for this chat, then off again: an exception that says "off", which the default under it does not.
  db.setToolDefaultsOff(["heavy_open", "heavy_read"]);
  db.setSessionTools(chat.id, { off: ["heavy_write"], on: [] });
  const listed = await json(`/api/sessions/${chat.id}/tools`);
  assert.equal(states(listed).heavy_write, false);
  assert.deepEqual(lazyOf(listed), ["heavy_open", "heavy_read"]);
});

test("a tool that turns up later in a lazy set starts off, one seen before does not change", async () => {
  await json("/api/tools/lazy", "PUT", { lazy: ["pi-heavy"] });
  // The owner switched one of them on for everyone.
  await json("/api/tools", "PUT", { off: ["heavy_read"] });
  const arrived = db.rememberTools([...heavy, { name: "heavy_write", source: "pi-heavy", package: null }, { name: "web_fetch", source: "pi-web-access", package: null }]);
  assert.deepEqual(arrived, ["heavy_write"]);
  assert.deepEqual(db.toolDefaultsOff(), ["heavy_read", "heavy_write"]);
  // Reported again: seen, so it keeps whatever was decided about it.
  await json("/api/tools", "PUT", { off: ["heavy_read"] });
  assert.deepEqual(db.rememberTools([...heavy, { name: "heavy_write", source: "pi-heavy", package: null }]), []);
  assert.deepEqual(db.toolDefaultsOff(), ["heavy_read"]);
});

test("without the mark a new tool is on, as before", async () => {
  assert.deepEqual(db.rememberTools([{ name: "heavy_write", source: "pi-heavy", package: null }]), []);
  assert.deepEqual(db.toolDefaultsOff(), []);
});

test("an MCP server's set and the portal's picture tools are sets like any other", async () => {
  writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "mcp.json"), JSON.stringify({ mcpServers: { notes: {} } }));
  db.rememberTools([
    { name: "notes_read", source: "pi-mcp-adapter", package: null },
    { name: "show_image", source: "pictures", package: null, inline: true },
    { name: "generate_image", source: "image-generation", package: null, inline: true },
  ]);
  const done = await json("/api/tools/lazy", "PUT", { lazy: ["notes", "<portal:images>"] });
  assert.deepEqual(done.off, ["generate_image", "notes_read", "show_image"]);
});

test("a set that stops being lazy keeps its switches, and later tools follow the default again", async () => {
  await json("/api/tools/lazy", "PUT", { lazy: ["pi-heavy"] });
  const done = await json("/api/tools/lazy", "PUT", { lazy: [] });
  assert.deepEqual(done.lazy, []);
  assert.deepEqual(done.off, ["heavy_open", "heavy_read"]);
  // Off, and off for good now: nothing reaches them through the gateway.
  assert.deepEqual(lazyOf(await json("/api/tools")), []);
  assert.deepEqual(db.rememberTools([{ name: "heavy_write", source: "pi-heavy", package: null }]), []);
  assert.deepEqual(db.toolDefaultsOff(), ["heavy_open", "heavy_read"]);
});

test("a list that is not strings is refused", async () => {
  const res = await send("/api/tools/lazy", "PUT", { lazy: "pi-heavy" });
  assert.equal(res.status, 400);
});
