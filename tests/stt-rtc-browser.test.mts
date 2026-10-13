import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { answerOffer, type RtcStt as ServerPeer } from '../server/src/voice-stt/rtc.js';
import { whisperTranscribe } from '../server/src/voice-stt/whisper.js';
import type { Transcribe } from '../server/src/voice-stt/session.js';

/**
 * A real Chromium sends a real file as its microphone over WebRTC to the
 * portal's own answerOffer, through the browser client (web/src/rtc-stt.ts).
 * Whisper is a real one when WHISPER_URL answers (checked with the 11 s JFK
 * sample); otherwise a stand-in that reports how much audio it was given.
 */
const WHISPER_URL = process.env.WHISPER_URL || 'http://127.0.0.1:8300/v1/audio/transcriptions';
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'whisper-1';
const dir = mkdtempSync(join(tmpdir(), 'stt-rtc-'));
let haveFfmpeg = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { haveFfmpeg = false; }
const realWhisper = await fetch(WHISPER_URL.replace(/\/v1\/.*/, '/health'), { signal: AbortSignal.timeout(1500) }).then(r => r.ok).catch(() => false);

// Chromium plays the file in a loop, from the moment the microphone opens: 3 s of silence, the speech, 3 s of silence.
const mic = join(dir, 'mic.wav');
if (haveFfmpeg) execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-i', 'tests/fixtures/jfk.wav', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono',
  '-filter_complex', '[0]atrim=0:3[a];[1]aresample=48000,aformat=channel_layouts=mono[b];[2]atrim=0:3[c];[a][b][c]concat=n=3:v=0:a=1', '-ar', '48000', '-ac', '1', mic]);

const bundle = (await build({
  stdin: { contents: 'export { RtcStt } from "./web/src/rtc-stt.ts"; export { suppressNoise } from "./web/src/noise.ts";', resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, format: 'iife', globalName: 'Stt', write: false, platform: 'browser', logLevel: 'silent',
})).outputFiles[0].text;

const requests: { sec: number; language?: string }[] = [];
const stub: Transcribe = async (wav, { language }) => { requests.push({ sec: (wav.length - 44) / 32000, language }); return { text: `audio ${((wav.length - 44) / 32000).toFixed(1)}`, language: 'en' }; };
const real = whisperTranscribe(WHISPER_URL, WHISPER_MODEL);
const transcribe: Transcribe = async (wav, o) => { const r = await (realWhisper ? real : stub)(wav, o); if (realWhisper) requests.push({ sec: (wav.length - 44) / 32000, language: o.language }); return r; };

let peer: ServerPeer | undefined;
const server = createServer(async (req, res) => {
  if ((req.url || '').startsWith('/voice-assets/')) { const name = (req.url || '').slice(14); try { res.setHeader('content-type', name.endsWith('wasm') ? 'application/wasm' : 'text/javascript'); return res.end(readFileSync(join('web/public/voice-assets', name))); } catch { res.statusCode = 404; return res.end(); } }
  if (req.method === 'GET') { res.setHeader('content-type', 'text/html'); return res.end(`<!doctype html><script>${bundle}</script><body>stt`); }
  const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
  const offer = JSON.parse(Buffer.concat(chunks).toString());
  peer = await answerOffer(offer.sdp, { transcribe, languages: ['en', 'tr'] });
  res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ type: 'answer', sdp: peer.answer }));
}).listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const port = (server.address() as any).port;
after(() => { server.close(); setTimeout(() => process.exit(0), 300).unref(); });


// The browser side, run in Chromium with `file` as its microphone. As a string: the transform that runs this file adds helpers a page does not have.
async function stream(file: string, model: string, seconds: number) {
  // The browser Playwright was installed with, or, where its revision is not the one installed here, any headless shell in its cache.
  const cache = join(process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache', 'ms-playwright'));
  const shell = existsSync(cache) ? readdirSync(cache).filter(d => d.startsWith('chromium_headless_shell-')).map(d => join(cache, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell')).find(existsSync) : undefined;
  const launch = (executablePath?: string) => chromium.launch({ executablePath, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${file}`, '--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required'] });
  const browser = await launch().catch(e => { if (!shell) throw e; return launch(shell); });
  try {
    const page = await (await browser.newContext({ permissions: ['microphone'] })).newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    return await page.evaluate(`(async () => {
      const { RtcStt, suppressNoise } = window.Stt;
      const interims = [];
      const mic = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const cleaned = await suppressNoise(mic, ${JSON.stringify(model)});
      const rtc = new RtcStt(async (offer) => (await fetch('/rtc', { method: 'POST', body: JSON.stringify(offer) })).json(), { interim: (id, text) => interims.push({ id, text }) });
      const t0 = performance.now();
      await rtc.connect(cleaned.stream);
      const connectMs = performance.now() - t0;
      rtc.start('u1');
      await new Promise(r => setTimeout(r, ${seconds * 1000}));
      rtc.end('u1');
      const t1 = performance.now();
      const final = await rtc.final('u1', undefined, 30000);
      const finalMs = performance.now() - t1;
      const processed = cleaned.stream !== mic;
      rtc.close(); cleaned.close();
      return { interims, final, connectMs, finalMs, processed };
    })()`) as { interims: { id: string; text: string }[]; final: { text: string; language?: string }; connectMs: number; finalMs: number; processed: boolean };
  } finally { await browser.close(); peer?.close(); }
}

test('Chromium streams a recording over WebRTC and gets interim and final transcripts back', { skip: !haveFfmpeg && 'ffmpeg is needed to build the microphone file', timeout: 90000 }, async () => {
  // The file is 3 s of silence, 11 s of speech, 3 s of silence; this marks the whole of it as one utterance.
  const out = await stream(mic, 'off', 14);
  console.log(JSON.stringify({ realWhisper, connectMs: Math.round(out.connectMs), finalMs: Math.round(out.finalMs), interims: out.interims.length, last: out.interims.at(-1)?.text, final: out.final, requests: requests.length }));
  assert.ok(out.interims.length >= 2, 'interim transcripts arrived while it was still being said');
  assert.ok(out.interims.every(i => i.id === 'u1'));
  const text = out.final.text.toLowerCase();
  if (realWhisper) assert.match(text, /ask not what your country can do for you/);
  else assert.match(out.final.text, /^audio 1[0-9]\.\d$/); // the stand-in names the seconds it was given: the whole 14 s, not a part
  assert.equal(out.final.language, 'en');
  assert.ok(requests.slice(2, -1).some(r => r.language === 'en'), 'later interim requests named the language the first ones found');
  assert.equal(requests.at(-1)!.language, 'en', 'the final request named it too');
});

/** The level (RMS) of the microphone and of the same microphone through `model`, over `seconds`, in the browser. */
async function levels(file: string, model: string, seconds: number) {
  const cache = join(process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache', 'ms-playwright'));
  const shell = existsSync(cache) ? readdirSync(cache).filter(d => d.startsWith('chromium_headless_shell-')).map(d => join(cache, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell')).find(existsSync) : undefined;
  const launch = (executablePath?: string) => chromium.launch({ executablePath, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${file}`, '--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const browser = await launch().catch(e => { if (!shell) throw e; return launch(shell); });
  try {
    const page = await (await browser.newContext({ permissions: ['microphone'] })).newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    return await page.evaluate(`(async () => {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const cleaned = await window.Stt.suppressNoise(mic, ${JSON.stringify(model)});
      const ctx = new AudioContext({ sampleRate: 48000 });
      const probe = stream => { const a = ctx.createAnalyser(); a.fftSize = 2048; ctx.createMediaStreamSource(stream).connect(a); return a; };
      const raw = probe(mic), out = probe(cleaned.stream), buf = new Float32Array(2048);
      const sum = { raw: 0, out: 0 }; let n = 0;
      const energy = a => { a.getFloatTimeDomainData(buf); let e = 0; for (const v of buf) e += v * v; return e / buf.length; };
      await new Promise(r => setTimeout(r, 1500)); // the model needs a moment to settle
      const end = performance.now() + ${seconds * 1000};
      while (performance.now() < end) { sum.raw += energy(raw); sum.out += energy(out); n++; await new Promise(r => setTimeout(r, 40)); }
      cleaned.close();
      return { processed: cleaned.stream !== mic, raw: Math.sqrt(sum.raw / n), out: Math.sqrt(sum.out / n) };
    })()`) as { processed: boolean; raw: number; out: number };
  } finally { await browser.close(); }
}

test('the noise model takes the noise out of a recording and leaves the speech', { skip: !haveFfmpeg && 'ffmpeg is needed to build the microphone file', timeout: 120000 }, async () => {
  const noise = join(dir, 'noise.wav');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.25:r=48000', '-f', 'lavfi', '-i', 'anoisesrc=color=brown:amplitude=0.3:r=48000',
    '-filter_complex', '[0][1]amix=inputs=2:normalize=0', '-ar', '48000', '-ac', '1', '-t', '17', noise]);
  const quiet = await levels(noise, 'rnnoise', 6);
  console.log(JSON.stringify({ noiseOnly: quiet }));
  assert.equal(quiet.processed, true, 'the microphone went through the model');
  assert.ok(quiet.out < quiet.raw * 0.25, `noise went from ${quiet.raw.toFixed(4)} to ${quiet.out.toFixed(4)} RMS`);
  // The 11 s of speech sit in 3-14 s of the file: the 1.5 s settling and 6 s of measuring below fall inside it.
  const speech = await levels(mic, 'rnnoise', 6);
  assert.ok(speech.out > speech.raw * 0.25, `speech stayed: ${speech.raw.toFixed(4)} to ${speech.out.toFixed(4)} RMS`);
  if (realWhisper) {
    const heard = await stream(mic, 'rnnoise', 14);
    assert.equal(heard.processed, true);
    assert.match(heard.final.text.toLowerCase(), /ask not what your country can do for you/);
  }
});
