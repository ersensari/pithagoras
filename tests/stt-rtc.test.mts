import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { RTCPeerConnection, MediaStreamTrack, RtpPacket, RtpHeader, useOPUS } from 'werift';
import OpusScript from 'opusscript';
import { SttSession, cleanTranscript, type Transcribe, type SttMessage } from '../server/src/voice-stt/session.js';
import { Downsampler48to16, wav16 } from '../server/src/voice-stt/pcm.js';
import { answerOffer } from '../server/src/voice-stt/rtc.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const tone = (sec: number, rate = 16000, hz = 440) => Int16Array.from({ length: Math.round(sec * rate) }, (_, i) => Math.round(8000 * Math.sin((2 * Math.PI * hz * i) / rate)));
const wavSeconds = (wav: Buffer) => (wav.length - 44) / 2 / 16000;

test('downsampler keeps a tone at the right length and frequency across chunk borders', () => {
  const d = new Downsampler48to16(), input = tone(1, 48000, 1000), out: number[] = [];
  for (let o = 0; o < input.length; o += 960 + (o % 7)) out.push(...d.push(input.subarray(o, o + 960 + (o % 7))));
  assert.ok(Math.abs(out.length - 16000) <= 3, `got ${out.length}`);
  const rms = Math.sqrt(out.slice(100, 15900).reduce((s, v) => s + v * v, 0) / 15800);
  assert.ok(rms > 4800 && rms < 6600, `rms ${rms}`); // 8000/sqrt2 = 5657, unchanged by the filter
  let crossings = 0; for (let i = 101; i < 15900; i++) if (out[i - 1] < 0 && out[i] >= 0) crossings++;
  assert.ok(Math.abs(crossings - 15800 / 16) < 6, `crossings ${crossings}`); // 1 kHz at 16 kHz = a period every 16 samples
});

test('cleanTranscript drops segments Whisper doubts and phrases it writes for silence', () => {
  assert.equal(cleanTranscript({ text: 'hello there', segments: [{ text: ' hello', avg_logprob: -0.1, no_speech_prob: 0 }, { text: ' there', avg_logprob: -1.4, no_speech_prob: 0.8 }] }), 'hello');
  assert.equal(cleanTranscript({ text: ' Thanks for watching! ' }), '');
  assert.equal(cleanTranscript({ text: ' . . ' }), '');
  assert.equal(cleanTranscript({ text: 'Thanks for watching. Thanks for watching.' }), '');
  assert.equal(cleanTranscript({ text: 'Thank you.' }), 'Thank you.'); // said to an assistant, it is speech
  assert.equal(cleanTranscript({ text: 'Merhaba nasılsın' }), 'Merhaba nasılsın');
});

test('a session sends interim results, locks the language, and ends with one transcript of everything', async () => {
  const calls: { sec: number; language?: string }[] = [], sent: SttMessage[] = [];
  const transcribe: Transcribe = async (wav, { language }) => { calls.push({ sec: wavSeconds(wav), language }); await sleep(5); return { text: `heard ${wavSeconds(wav).toFixed(1)}`, language: 'tr' }; };
  const s = new SttSession(transcribe, m => sent.push(m), { interimMs: 40, minNewMs: 200, flushIdleMs: 10, flushMaxMs: 30 });
  s.push(tone(0.5)); // before the start marker: the pre-roll
  s.start('u1');
  for (let i = 0; i < 20; i++) { s.push(tone(0.1)); await sleep(30); }
  await s.end('u1');
  const interims = sent.filter(m => m.t === 'interim'), final = sent.find(m => m.t === 'final') as any;
  assert.ok(interims.length >= 2, `interims ${interims.length}`);
  assert.equal(calls[0].language, undefined);
  assert.equal(calls[1].language, undefined); // two agreeing results lock it...
  assert.ok(calls.slice(2).every(c => c.language === 'tr'), JSON.stringify(calls)); // ...and the rest name it
  assert.equal(final.language, 'tr');
  const finalCall = calls[calls.length - 1];
  assert.ok(Math.abs(finalCall.sec - 2.5) < 0.15, `final sec ${finalCall.sec}`); // 0.5 pre-roll + 2.0 spoken
  assert.equal(final.text, `heard ${finalCall.sec.toFixed(1)}`);
  s.close();
});

test('the next utterance starts without the language of the last', async () => {
  const langs: (string | undefined)[] = [];
  const s = new SttSession(async (_w, { language }) => { langs.push(language); return { text: 'x', language: 'en' }; }, () => {}, { interimMs: 20, minNewMs: 100, flushIdleMs: 5, flushMaxMs: 10 });
  for (const id of ['a', 'b']) { s.start(id); for (let i = 0; i < 8; i++) { s.push(tone(0.1)); await sleep(25); } await s.end(id); }
  assert.equal(langs.filter(l => l === undefined).length >= 4, true, JSON.stringify(langs)); // both utterances began open
  s.close();
});

test('noise Whisper writes in another language is dropped and never becomes the locked language', async () => {
  assert.equal(cleanTranscript({ text: 'ご視聴ありがとうございました', language: 'ja', segments: [{ text: 'ご視聴ありがとうございました', avg_logprob: -0.28, no_speech_prob: 0 }] }, ['en', 'tr']), '');
  assert.equal(cleanTranscript({ text: 'merhaba', language: 'tr' }, ['en', 'tr']), 'merhaba');
  assert.equal(cleanTranscript({ text: 'anything', language: 'ja' }), 'anything'); // no list: any language counts
  const langs: (string | undefined)[] = [], sent: SttMessage[] = [];
  const s = new SttSession(async (_w, { language }) => { langs.push(language); return { text: '字幕', language: 'ja' }; }, m => sent.push(m), { languages: ['en', 'tr'], interimMs: 20, minNewMs: 100, flushIdleMs: 5, flushMaxMs: 10 });
  s.start('n'); for (let i = 0; i < 10; i++) { s.push(tone(0.1)); await sleep(25); } await s.end('n');
  assert.ok(langs.every(l => l === undefined), JSON.stringify(langs)); // never locked to ja
  assert.deepEqual(sent.filter(m => m.t !== 'final'), []); // no interim for it
  assert.equal((sent.at(-1) as any).text, '');
  s.close();
});

test('a language the person set is named in every request, the first one included', async () => {
  const langs: (string | undefined)[] = [];
  const s = new SttSession(async (_w, { language }) => { langs.push(language); return { text: 'x', language: 'tr' }; }, () => {}, { language: 'tr', interimMs: 20, minNewMs: 100, flushIdleMs: 5, flushMaxMs: 10 });
  s.start('a'); for (let i = 0; i < 8; i++) { s.push(tone(0.1)); await sleep(25); } await s.end('a');
  assert.ok(langs.length >= 2 && langs.every(l => l === 'tr'), JSON.stringify(langs));
  s.close();
});

test('a click too short for words and a cancelled utterance send no transcript request', async () => {
  let n = 0, sent: SttMessage[] = [];
  const s = new SttSession(async () => { n++; return { text: 'x' }; }, m => sent.push(m), { flushIdleMs: 5, flushMaxMs: 10 });
  s.start('c'); s.push(tone(0.1)); await s.end('c');
  assert.deepEqual(sent, [{ t: 'final', id: 'c', text: '' }]);
  s.start('d'); s.push(tone(2)); s.cancel(); await s.end('d');
  assert.equal(n, 0); s.close();
});

test('a browser-shaped peer: Opus over RTP, markers and results over the data channel', async () => {
  const calls: { sec: number; language?: string }[] = [];
  const client = new RTCPeerConnection({ codecs: { audio: [useOPUS()] }, iceUseIpv6: false });
  const track = new MediaStreamTrack({ kind: 'audio' });
  client.addTransceiver(track, { direction: 'sendonly' });
  const channel = client.createDataChannel('stt');
  await client.setLocalDescription(await client.createOffer());
  if (client.iceGatheringState !== 'complete') await new Promise<void>(r => client.iceGatheringStateChange.subscribe(st => st === 'complete' && r()));

  let closed = false;
  const server = await answerOffer(client.localDescription!.sdp, {
    transcribe: async (wav, { language }) => { calls.push({ sec: wavSeconds(wav), language }); return { text: `heard ${wavSeconds(wav).toFixed(1)}`, language: 'en' }; },
    interimMs: 150, minNewMs: 300, flushIdleMs: 50, flushMaxMs: 150, onClose: () => { closed = true; },
  });
  assert.match(server.answer, /a=candidate/); // no trickle: the answer carries its candidates
  const received: any[] = [];
  channel.onMessage.subscribe(m => received.push(JSON.parse(String(m))));
  await client.setRemoteDescription({ type: 'answer', sdp: server.answer });
  await new Promise<void>(r => channel.stateChanged.subscribe(st => st === 'open' && r()));
  for (let i = 0; i < 100 && !received.some(m => m.t === 'ready'); i++) await sleep(20);
  assert.ok(received.some(m => m.t === 'ready'));

  const enc = new OpusScript(48000, 1, OpusScript.Application.VOIP);
  const speech = tone(3, 48000, 300);
  let seq = 0, ts = 0, o = 0;
  const frame = () => {
    const pcm = o + 960 <= speech.length ? speech.subarray(o, o + 960) : new Int16Array(960);
    o += 960;
    track.writeRtp(new RtpPacket(new RtpHeader({ sequenceNumber: seq++ & 0xffff, timestamp: ts, payloadType: 111, ssrc: 4321 }), Buffer.from(enc.encode(Buffer.from(pcm.buffer, pcm.byteOffset, 1920), 960))));
    ts += 960;
  };
  // A second of silence first, as a mic that is open before anyone speaks, then 3 s of speech paced like real time.
  for (let i = 0; i < 50; i++) { frame(); await sleep(20); }
  o = 0;
  channel.send(JSON.stringify({ t: 'start', id: 'u1' }));
  for (let i = 0; i < 150; i++) { frame(); await sleep(20); }
  channel.send(JSON.stringify({ t: 'end', id: 'u1' }));
  for (let i = 0; i < 100 && !received.some(m => m.t === 'final'); i++) await sleep(20);

  const final = received.find(m => m.t === 'final');
  assert.ok(final, JSON.stringify(received));
  assert.equal(final.id, 'u1');
  assert.ok(received.filter(m => m.t === 'interim').length >= 2, `interims: ${received.filter(m => m.t === 'interim').length}`);
  // 3 s spoken plus up to the 0.5 s pre-roll of the silence before it, within what the pacing allows.
  const finalCall = calls[calls.length - 1];
  assert.ok(finalCall.sec > 2.8 && finalCall.sec < 3.8, `final audio ${finalCall.sec}s`);
  assert.equal(finalCall.language, 'en'); // locked by the interims, named in the final request
  server.close(); await client.close();
  assert.ok(closed);
});

// A werift peer that has connected leaves its UDP sockets open after close(), which keeps this process alive (the
// server side was measured to free its own: only the test's client leaks). The runner has the results by now.
after(() => { setTimeout(() => process.exit(0), 300).unref(); });
