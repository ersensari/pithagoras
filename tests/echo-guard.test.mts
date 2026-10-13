import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EchoProbe, settleFor, type EchoVerdict } from '../web/src/echo-guard.js';

// A frame every 32 ms, as the VAD delivers them; returns the first verdict that is not "wait", and when.
const run = (probe: EchoProbe, speech: (ms: number) => number, upTo = 1000) => {
  probe.start(0);
  for (let ms = 0; ms <= upTo; ms += 32) {
    const verdict = probe.frame(ms, speech(ms));
    if (verdict !== 'wait') return { verdict, at: ms };
  }
  return { verdict: 'wait' as EchoVerdict, at: upTo };
};

test('speech that stops when the reply is turned down was its echo, and is let go at once', () => {
  const probe = new EchoProbe();
  const result = run(probe, ms => ms < 100 ? 0.9 : 0.05);
  assert.equal(result.verdict, 'echo');
  assert.ok(result.at <= 450, `decided at ${result.at} ms`);
  assert.equal(probe.active, false);
});

test('speech that goes on in the quiet is a person talking over the reply', () => {
  const probe = new EchoProbe();
  const result = run(probe, () => 0.85);
  assert.equal(result.verdict, 'person');
  assert.ok(result.at >= 600 && result.at <= 660, `decided at ${result.at} ms`);
});

test('an echo that fades slowly, the room ringing on for a moment, is still an echo', () => {
  const probe = new EchoProbe();
  const result = run(probe, ms => Math.max(0, 0.9 - ms / 500));
  assert.equal(result.verdict, 'echo');
});

test('a short word that has ended by the time it is decided counts if the quiet heard it', () => {
  const probe = new EchoProbe();
  probe.start(0);
  for (let ms = 0; ms < 560; ms += 32) probe.frame(ms, 0.8);
  assert.equal(probe.end(), 'person');
});

test('speech that ends before the quiet could say anything is taken as an echo', () => {
  const probe = new EchoProbe();
  probe.start(0);
  for (let ms = 0; ms < 330; ms += 32) probe.frame(ms, 0.8);
  assert.equal(probe.end(), 'echo');
});

test('with no probe running speech is a person, so nothing is ever held back without a reply playing', () => {
  const probe = new EchoProbe();
  assert.equal(probe.end(), 'person');
  assert.equal(probe.frame(0, 0.9), 'wait');
});

test('the wait follows the output latency: sound already on its way keeps playing after the gain is zero', () => {
  assert.equal(settleFor(undefined), 300);
  assert.equal(settleFor(0.02), 300);
  assert.equal(settleFor(0.25), 450);
  assert.equal(settleFor(5), 900, 'a Bluetooth headset is not waited for forever');
  const probe = new EchoProbe();
  probe.start(0, settleFor(0.25));
  for (let ms = 0; ms < 450; ms += 32) assert.equal(probe.frame(ms, 0.9), 'wait', 'the echo still arriving inside the latency is not looked at');
});
