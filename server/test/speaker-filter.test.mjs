import { test } from "node:test";
import assert from "node:assert/strict";

// The web module is plain erasable TypeScript, so Node loads it as it is.
const { ignoredVoice } = await import("../../web/src/speaker-filter.ts");

const who = (extra = {}) => ({ name: "ersen", score: 0.7, matched: true, reliable: true, ...extra });

test("an enrolled voice is never ignored", () => {
  assert.equal(ignoredVoice(true, who()), false);
});

test("a stranger the portal is sure about is ignored, but only while filtering is on", () => {
  const stranger = who({ name: "ersen", score: 0.08, matched: false });
  assert.equal(ignoredVoice(true, stranger), true);
  assert.equal(ignoredVoice(false, stranger), false);
});

test("no verdict, or one that is not reliable, always lets the speech through", () => {
  assert.equal(ignoredVoice(true, undefined), false, "identification off / nobody enrolled / service down");
  assert.equal(ignoredVoice(true, who({ matched: false, reliable: false, score: 0.1 })), false, "clip too short to judge");
});
