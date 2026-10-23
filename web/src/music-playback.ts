import { api } from "./api";

type Track = { audio: HTMLAudioElement; listeners: Set<() => void>; release: () => void };
const tracks = new Map<string, Track>();
const keyOf = (sessionId: string, jobId: string) => `${sessionId}:${jobId}`;

/** Chat, orb and its conversation window all control one audio source per song. */
export const musicAudioElement = (sessionId: string, jobId: string) => tracks.get(keyOf(sessionId, jobId))?.audio;

export function subscribeMusic(sessionId: string, jobId: string, changed: () => void): () => void {
  const key = keyOf(sessionId, jobId);
  let track = tracks.get(key);
  if (!track) {
    const audio = new Audio(api.musicAudio(sessionId, jobId));
    audio.controls = true;
    audio.preload = "metadata";
    audio.className = "w-full";
    audio.dataset.musicJob = jobId;
    audio.dataset.musicSession = sessionId;
    const listeners = new Set<() => void>();
    let wasPlaying = false;
    const update = () => {
      const playing = !audio.paused && !audio.ended;
      if (playing !== wasPlaying) {
        wasPlaying = playing;
        if (playing) for (const other of tracks.values()) if (other.audio !== audio) other.audio.pause();
        window.dispatchEvent(new CustomEvent("pithagoras:music-playback", { detail: { sessionId, jobId, playing } }));
      }
      for (const listener of listeners) listener();
    };
    const events = ["play", "pause", "ended", "timeupdate", "durationchange", "loadedmetadata"];
    events.forEach(type => audio.addEventListener(type, update));
    const control = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.sessionId !== sessionId || detail?.jobId !== jobId) return;
      if (detail.action === "play" || (detail.action === "toggle" && audio.paused)) void audio.play().catch(() => {});
      else if (detail.action === "pause" || detail.action === "toggle") audio.pause();
    };
    window.addEventListener("pithagoras:music-control", control);
    track = { audio, listeners, release: () => {
      audio.pause(); update();
      events.forEach(type => audio.removeEventListener(type, update));
      window.removeEventListener("pithagoras:music-control", control);
      audio.removeAttribute("src"); audio.load();
    } };
    tracks.set(key, track);
  }
  const subscribed = track;
  subscribed.listeners.add(changed);
  changed();
  return () => {
    subscribed.listeners.delete(changed);
    if (!subscribed.listeners.size) { subscribed.release(); tracks.delete(key); }
  };
}
