import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveTranscription } from '../web/src/live-transcription.js';
import { StreamedTranscription } from '../web/src/live-rtc.js';

/** An RtcStt that records its markers and answers `final` as told. */
function fakeRtc(ready: boolean, final: (id: string) => Promise<{ text: string }>) {
  const marks: string[] = [];
  return { marks, ready, start: (id: string) => marks.push(`start ${id.length > 0}`), end: (_id: string) => marks.push('end'), cancel: (_id: string) => marks.push('cancel'), final: (id: string) => final(id) } as any;
}
const samples = () => new Float32Array(16000);

test('with streaming up, an utterance is marked to the portal and its text is the portal\'s', async () => {
  const uploads: number[] = [], previews: string[] = [];
  const inner = new LiveTranscription(async s => { uploads.push(s.length); return 'uploaded'; }, () => {}, true);
  const rtc = fakeRtc(true, async () => ({ text: 'streamed' }));
  const live = new StreamedTranscription(inner, () => rtc, t => previews.push(t));
  live.begin(); live.confirm(); const rec = samples(); live.end(rec);
  assert.equal(await live.finish(rec, new AbortController().signal), 'streamed');
  assert.deepEqual(rtc.marks, ['start true', 'end']);
  assert.deepEqual(uploads, []); // nothing was uploaded
});

test('interim text shows only for the utterance in progress', () => {
  const previews: string[] = [];
  const rtc = fakeRtc(true, async () => ({ text: '' }));
  const live = new StreamedTranscription(new LiveTranscription(async () => '', () => {}, true), () => rtc, t => previews.push(t));
  live.begin();
  const id = (live as any).previewId as string;
  live.interim('someone-elses', 'stale'); live.interim(id, 'hello');
  assert.deepEqual(previews, ['', 'hello']);
});

test('with streaming down, the recording is uploaded as before', async () => {
  const uploads: number[] = [];
  const inner = new LiveTranscription(async s => { uploads.push(s.length); return 'uploaded'; }, () => {}, true);
  const rtc = fakeRtc(false, async () => { throw new Error('unused'); });
  const live = new StreamedTranscription(inner, () => rtc, () => {});
  live.begin(); live.confirm(); const rec = samples(); live.end(rec);
  assert.equal(await live.finish(rec, new AbortController().signal), 'uploaded');
  assert.deepEqual(rtc.marks, []);
  const none = new StreamedTranscription(inner, () => undefined, () => {});
  none.begin(); const r2 = samples(); none.end(r2);
  assert.equal(await none.finish(r2, new AbortController().signal), 'uploaded');
});

test('a streamed transcript that fails falls back to the upload; an abort does not', async () => {
  const uploads: number[] = [];
  const inner = new LiveTranscription(async s => { uploads.push(s.length); return 'uploaded'; }, () => {}, true);
  const rtc = fakeRtc(true, async () => { throw new Error('Live recognition timed out'); });
  const live = new StreamedTranscription(inner, () => rtc, () => {});
  live.begin(); const rec = samples(); live.end(rec);
  assert.equal(await live.finish(rec, new AbortController().signal), 'uploaded');
  assert.deepEqual(uploads, [16000]);
  const ctl = new AbortController(); ctl.abort(new Error('stop'));
  const aborting = fakeRtc(true, async () => { throw new Error('aborted'); });
  const live2 = new StreamedTranscription(inner, () => aborting, () => {});
  live2.begin(); const r2 = samples(); live2.end(r2);
  await assert.rejects(live2.finish(r2, ctl.signal));
  assert.deepEqual(uploads, [16000]); // no second upload
});

test('a misfire cancels the streamed utterance', () => {
  const rtc = fakeRtc(true, async () => ({ text: '' }));
  const live = new StreamedTranscription(new LiveTranscription(async () => '', () => {}, true), () => rtc, () => {});
  live.begin(); live.discard();
  assert.deepEqual(rtc.marks, ['start true', 'cancel']);
});
