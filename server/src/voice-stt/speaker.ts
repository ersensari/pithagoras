import type { Speaker } from "./session.js";

/**
 * Speaker identification for the voice loop: which enrolled voice (if any) an utterance belongs to.
 *
 * It asks forgeloop-ai-speech (docker/speech in the forgeloop-ai repo, CPU only, ~50 ms per clip) in parallel with the
 * transcription of the same audio. Off unless VOICE_SPEAKER_ID is 1/true/on AND SPEECH_URL is set, so a deployment
 * without the service behaves exactly as before. It is advisory: any failure (service down, timeout, nobody enrolled)
 * yields no verdict and the transcript goes through untouched.
 */
export const speakerIdUrl = (): string | undefined => {
  if (!/^(1|true|on)$/i.test((process.env.VOICE_SPEAKER_ID ?? "").trim())) return undefined;
  const base = process.env.SPEECH_URL?.trim().replace(/\/+$/, "");
  return base ? `${base}/v1/speakers/identify` : undefined;
};

/** Never rejects: resolves undefined when there is no usable verdict. */
export type Identify = (wav: Buffer, signal: AbortSignal) => Promise<Speaker | undefined>;

export function speakerIdentify(url: string, timeoutMs = 4000): Identify {
  return async (wav, signal) => {
    try {
      const form = new FormData();
      form.set("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "utterance.wav");
      const res = await fetch(url, { method: "POST", body: form, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) });
      if (!res.ok) return undefined;
      const body = await res.json() as { name?: unknown; score?: unknown; matched?: unknown; reliable?: unknown; reason?: unknown };
      // Nobody enrolled or a clip too short to embed: there is nothing to report.
      if (typeof body.reason === "string" && (body.reason === "no_enrolled_speakers" || body.reason === "too_short")) return undefined;
      return {
        name: typeof body.name === "string" ? body.name : null,
        score: typeof body.score === "number" ? body.score : null,
        matched: body.matched === true,
        reliable: body.reliable === true,
      };
    } catch { return undefined; }
  };
}
