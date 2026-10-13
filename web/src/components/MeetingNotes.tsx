import { useCallback, useEffect, useRef, useState } from "react";
import { LuNotebookPen, LuLoaderCircle } from "react-icons/lu";
import type { MicVAD } from "@ricky0123/vad-web";
import { api } from "../api";
import { t } from "../i18n";
import { joinSamples } from "../samples";

/** How often a recording buffer is flushed to the server for transcription.
 * Not VAD-driven, deliberately: nothing here ever prompts the agent per
 * utterance or per chunk, so there is no turn boundary to detect and no
 * reply that could arrive late or out of order - a meeting doesn't pause
 * for anyone's speech boundaries either way. VAD below is used only to
 * decide whether a given window is worth sending at all, not to decide
 * when to send it. */
const CHUNK_MS = 15000;

/** `probabilities.isSpeech` at or above this, for any single frame in a
 * window, counts that whole window as having speech in it. */
const SPEECH_THRESHOLD = 0.5;

/**
 * A relative of VoiceControl, deliberately not built on it: that component's
 * mic pipeline exists to feed a conversational turn-based loop (VAD ->
 * transcribe -> prompt the agent -> it replies and speaks). This one only
 * ever transcribes and appends to a file; the agent is prompted exactly
 * once, when the recording stops (see server/src/api/meeting-notes.ts).
 *
 * No audio is ever written to browser storage either - `buffer.current`
 * (raw samples) and the MicVAD instance's own internal state live only in
 * memory for the current 15s window, cleared on every flush; only the
 * transcribed TEXT that flush returns ever leaves this component's memory
 * (server-side, appended to a file - see meeting-notes.ts).
 */
export function MeetingNotes({ sessionId }: { sessionId: string }) {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const context = useRef<AudioContext | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const processor = useRef<ScriptProcessorNode | null>(null);
  const vad = useRef<MicVAD | null>(null);
  const buffer = useRef<Float32Array[]>([]);
  // Set by VAD while recording, read and reset on every flush - true if any
  // frame in the window just ending looked like speech.
  const hadSpeech = useRef(false);
  const flushTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const flushing = useRef(false);
  const stopped = useRef(true);

  const flush = useCallback(async (final = false) => {
    // Awaited by both the timer and stop(), so two flushes never race and
    // land on disk out of order.
    if (flushing.current) return;
    const pieces = buffer.current;
    buffer.current = [];
    const speech = hadSpeech.current;
    hadSpeech.current = false;
    if (!pieces.length) return;
    // VAD said nobody spoke in this whole window - a real gap in the
    // meeting, not a dropped chunk. Skip the upload and the Whisper call
    // entirely rather than transcribing silence for nothing.
    if (!speech && !final) return;
    flushing.current = true;
    try {
      await api.sendMeetingChunk(sessionId, joinSamples(pieces));
    } catch (e) {
      // A dropped chunk mid-meeting loses ~15s of transcript, not the whole
      // recording - worth surfacing, not worth stopping over, except for
      // the final flush where the meeting is already ending anyway.
      if (!final) setError((e as Error).message);
    } finally {
      flushing.current = false;
    }
  }, [sessionId]);

  const stop = useCallback(async () => {
    if (stopped.current) return;
    stopped.current = true;
    if (flushTimer.current) { clearInterval(flushTimer.current); flushTimer.current = null; }
    vad.current?.destroy();
    vad.current = null;
    processor.current?.disconnect();
    processor.current = null;
    stream.current?.getTracks().forEach(track => track.stop());
    stream.current = null;
    const closing = context.current?.close().catch(() => {});
    context.current = null;
    setRecording(false);
    setBusy(true);
    try {
      await closing;
      await flush(true);
      await api.stopMeeting(sessionId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [sessionId, flush]);

  const start = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      await api.startMeeting(sessionId);
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
        throw new Error(t("A microphone needs a secure connection (HTTPS or localhost)."));
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      stream.current = mic;
      // Requested at 16 kHz to match samplesWav()'s fixed WAV header - most
      // browsers honor a requested AudioContext sample rate directly.
      const audio = new AudioContext({ sampleRate: 16000 });
      context.current = audio;
      const source = audio.createMediaStreamSource(mic);
      // ScriptProcessorNode is deprecated but still universally supported,
      // and the simplest way to pull raw samples without shipping a
      // separate AudioWorklet module file for a feature this small.
      const node = audio.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (event) => {
        buffer.current.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      // A ScriptProcessorNode only fires onaudioprocess once connected
      // through to the destination - routed through a zero-gain node so
      // the room never hears its own mic fed back through the speakers.
      const silence = audio.createGain();
      silence.gain.value = 0;
      source.connect(node);
      node.connect(silence);
      silence.connect(audio.destination);
      processor.current = node;

      // Same library and asset path VoiceControl already loads - shares the
      // one mic stream and AudioContext via getStream/pauseStream/
      // resumeStream (no second getUserMedia prompt, no second audio
      // graph for the hardware). Used only to tell a silent window from a
      // spoken one; it never segments an utterance or triggers a prompt.
      const detectorModule = await import("@ricky0123/vad-web");
      const detector = await detectorModule.MicVAD.new({
        model: "v5", audioContext: audio, startOnLoad: false,
        baseAssetPath: "/voice-assets/", onnxWASMBasePath: "/voice-assets/",
        ortConfig: ort => { ort.env.wasm.numThreads = 1; },
        getStream: async () => mic,
        pauseStream: async () => {},
        resumeStream: async () => mic,
        onFrameProcessed: probabilities => {
          if (probabilities.isSpeech >= SPEECH_THRESHOLD) hadSpeech.current = true;
        },
      });
      vad.current = detector;
      detector.start();

      stopped.current = false;
      setRecording(true);
      flushTimer.current = setInterval(() => { void flush(); }, CHUNK_MS);
    } catch (e) {
      setError((e as Error).message);
      vad.current?.destroy();
      vad.current = null;
      stream.current?.getTracks().forEach(track => track.stop());
      stream.current = null;
    } finally {
      setBusy(false);
    }
  }, [sessionId, flush]);

  // A chat switch/unmount mid-meeting stops the recording rather than
  // leaving the mic open against a session no longer on screen.
  useEffect(() => () => { void stop(); }, [stop]);

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        className="prompt-action"
        aria-pressed={recording}
        aria-label={recording ? t("Stop meeting notes") : t("Start meeting notes")}
        title={recording
          ? t("Stop meeting notes (summarizes the transcript)")
          : t("Start meeting notes (listens in the room, takes no spoken turns, summarizes when stopped)")}
        disabled={busy}
        onClick={() => { void (recording ? stop() : start()); }}
      >
        {busy ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuNotebookPen aria-hidden color={recording ? "var(--danger, #e5484d)" : undefined} />}
      </button>
      {error && (
        <p role="alert" className="absolute bottom-full right-0 mb-3 w-64 rounded-xl border border-line bg-surface p-3 text-xs text-danger shadow-pop">
          {error}
        </p>
      )}
    </span>
  );
}
