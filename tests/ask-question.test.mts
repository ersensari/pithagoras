import test from 'node:test';
import assert from 'node:assert/strict';
import { readQuestions, readAnswers, describeAnswers, askQuestionTool, ASK_QUESTION_TOOL, MAX_QUESTIONS } from '../server/src/pi/ask-question.ts';
import { isDialog } from '../server/src/pi/ui-requests.ts';

/** The tool as pi gets it: registered on a fake pi, run with the context a test gives it. */
function tool() {
  let registered: any;
  askQuestionTool()({ registerTool: (t: any) => (registered = t) });
  return registered;
}

const ask = [
  { question: 'Which database?', options: [{ label: 'SQLite', description: 'one file' }, { label: 'Postgres' }], allowOther: true },
  { id: 'features', question: 'Which features?', kind: 'multiple', options: ['Search', 'Export', 'Sync'] },
  { id: 'why', question: 'Anything else?', kind: 'text', optional: true },
  { id: 'order', question: 'Rank them', kind: 'ranking', options: [{ label: 'Speed' }, { label: 'Cost' }, { label: 'Safety' }] },
];

test('the tool is registered under its name, and a dialog request of the questions kind waits for an answer', () => {
  assert.equal(tool().name, ASK_QUESTION_TOOL);
  assert.equal(isDialog('questions'), true);
  assert.equal(isDialog('setStatus'), false);
});

test('questions are completed: default kind and ids, bare-string options, the flags', () => {
  const qs = readQuestions(ask);
  assert.deepEqual(qs.map((q) => [q.id, q.kind, q.other, q.optional]), [
    ['q1', 'single', true, false],
    ['features', 'multiple', false, false],
    ['why', 'text', false, true],
    ['order', 'ranking', false, false],
  ]);
  assert.deepEqual(qs[0].options, [{ label: 'SQLite', description: 'one file' }, { label: 'Postgres' }]);
  assert.deepEqual(qs[1].options.map((o) => o.label), ['Search', 'Export', 'Sync']);
});

test('questions the dialog could not draw are refused with a reason the model can act on', () => {
  const bad = (raw: unknown, re: RegExp) => assert.throws(() => readQuestions(raw), re);
  bad([], /at least one/);
  bad('nope', /at least one/);
  bad(Array.from({ length: MAX_QUESTIONS + 1 }, () => ({ question: 'q', options: ['a'] })), /at most 8/);
  bad([{ question: '  ' }], /no text/);
  bad([{ question: 'q', kind: 'slider' }], /kind must be/);
  bad([{ question: 'q', kind: 'single' }], /needs options/);
  bad([{ question: 'q', kind: 'ranking', options: ['a'] }], /at least two/);
  bad([{ question: 'q', kind: 'text', options: ['a'] }], /no options/);
  bad([{ question: 'q', options: ['a', 'a'] }], /twice/);
  bad([{ id: 'x', question: 'q', options: ['a'] }, { id: 'x', question: 'r', options: ['a'] }], /used twice/);
});

test('answers are held to what was asked: strangers, wrong shapes and half rankings are dropped', () => {
  const qs = readQuestions(ask);
  const got = readAnswers(qs, {
    q1: 'MySQL, typed in', // allowed: this one takes other answers
    features: ['Search', 'Search', 'Teleport'], // doubled and not offered
    why: '  because  ',
    order: ['Cost', 'Safety', 'Speed'],
    extra: 'not a question',
  });
  assert.deepEqual(got, { q1: 'MySQL, typed in', features: ['Search'], why: 'because', order: ['Cost', 'Safety', 'Speed'] });

  assert.deepEqual(readAnswers(qs, { features: 'Search', order: ['Cost', 'Speed'], q1: 7, why: '' }), {}, 'a string for several, a short ranking, a number, an empty text');
  assert.deepEqual(readAnswers(qs, { order: ['Cost', 'Cost', 'Speed'] }), {}, 'a ranking that repeats one and leaves one out');
  assert.deepEqual(readAnswers(readQuestions([{ question: 'q', options: ['a', 'b'] }]), { q1: 'c' }), {}, 'not an option, and others not allowed');
  assert.deepEqual(readAnswers(qs, null), {});
  assert.deepEqual(readAnswers(qs, ['q1']), {});
});

test('the model is told each answer, what was typed in, and what was left', () => {
  const qs = readQuestions(ask);
  const text = describeAnswers(qs, { q1: 'MySQL', features: ['Search', 'Sync'], order: ['Cost', 'Safety', 'Speed'] });
  assert.match(text, /1\. Which database\?\n\s+Chosen: "MySQL" \(typed in, not one of the options\)/);
  assert.match(text, /Chosen: Search; Sync/);
  assert.match(text, /No answer \(it was optional\)/);
  assert.match(text, /1\) Cost {2}2\) Safety {2}3\) Speed/);
});

test('running the tool asks the context, with a wait of its own, and reports what came back', async () => {
  const seen: any[] = [];
  const ctx = { ui: { questions: async (payload: any, opts: any) => (seen.push([payload, opts]), { q1: 'SQLite', features: ['Export'], order: ['Speed', 'Cost', 'Safety'] }) } };
  const signal = new AbortController().signal;
  const out = await tool().execute('id', { title: 'Setup', questions: ask }, signal, undefined, ctx);
  assert.equal(seen[0][0].title, 'Setup');
  assert.equal(seen[0][0].questions.length, 4);
  assert.equal(seen[0][1].signal, signal);
  assert.ok(seen[0][1].timeout > 300_000, 'longer than an extension menu waits');
  assert.match(out.content[0].text, /Chosen: SQLite/);
  assert.match(out.content[0].text, /Chosen: Export/);
});

test('a dialog closed without answers is a result, not an error; a context with no screen is an error', async () => {
  const closed = await tool().execute('id', { questions: ask }, undefined, undefined, { ui: { questions: async () => undefined } });
  assert.match(closed.content[0].text, /closed the dialog without answering/);
  await assert.rejects(tool().execute('id', { questions: ask }, undefined, undefined, { ui: {} }), /no screen/);
  await assert.rejects(tool().execute('id', { questions: [] }, undefined, undefined, { ui: { questions: async () => ({}) } }), /at least one/);
});
