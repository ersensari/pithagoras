import { useEffect, useRef, useState } from "react";
import { LuDownload, LuLoaderCircle, LuPause, LuPlay, LuShare2, LuMusic2 } from "react-icons/lu";
import { api, json } from "../api";
import { canvasMessage } from "../canvas-feed";
import { t } from "../i18n";

type Job = { id: string; status: "queued" | "waiting_for_gpu" | "loading" | "running" | "done" | "error"; error?: string; abc?: string; request?: { abc?: string } };

export function musicJobId(output?: string): string | undefined {
  return output?.match(/MUSIC_JOB\s+([a-f0-9]{32})/)?.[1];
}

export function MusicPlayer({ sessionId, jobId, compact = false, controlsOnly = false, onPlay }: {
  sessionId: string; jobId: string; compact?: boolean; controlsOnly?: boolean; onPlay?: (playing: boolean) => void;
}) {
  const [job, setJob] = useState<Job>({ id: jobId, status: "queued" });
  const [playing, setPlaying] = useState(false);
  const [openingScore, setOpeningScore] = useState(false);
  const [scoreError, setScoreError] = useState("");
  const audio = useRef<HTMLAudioElement>(null);
  const previousPlaying = useRef(false);
  useEffect(() => {
    let live = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const response = await fetch(api.musicJob(sessionId, jobId));
        if (!response.ok) throw new Error(`Music job status returned HTTP ${response.status}`);
        const next = await response.json() as Job;
        if (!live) return;
        setJob(next);
        if (next.status !== "done" && next.status !== "error") timer = window.setTimeout(poll, 2500);
      } catch {
        if (live) timer = window.setTimeout(poll, 5000);
      }
    };
    void poll();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [sessionId, jobId]);
  useEffect(() => {
    if (!controlsOnly) return;
    const playback = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.sessionId === sessionId && detail?.jobId === jobId) setPlaying(!!detail.playing);
    };
    window.addEventListener("pithagoras:music-playback", playback);
    return () => window.removeEventListener("pithagoras:music-playback", playback);
  }, [controlsOnly, sessionId, jobId]);
  useEffect(() => {
    if (controlsOnly) return;
    const control = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.sessionId !== sessionId || detail?.jobId !== jobId) return;
      if (detail.action === "play" || (detail.action === "toggle" && audio.current?.paused)) void audio.current?.play().catch(() => {});
      else if (detail.action === "pause" || detail.action === "toggle") audio.current?.pause();
    };
    window.addEventListener("pithagoras:music-control", control);
    return () => window.removeEventListener("pithagoras:music-control", control);
  }, [controlsOnly, sessionId, jobId]);
  useEffect(() => {
    onPlay?.(playing);
    if (previousPlaying.current !== playing) {
      previousPlaying.current = playing;
      window.dispatchEvent(new CustomEvent("pithagoras:music-playback", { detail: { sessionId, jobId, playing } }));
    }
    return () => { onPlay?.(false); };
  }, [playing, onPlay, sessionId, jobId]);
  const openScore = async () => {
    setOpeningScore(true); setScoreError("");
    try {
      const canvas = await json<{ id: string; [key: string]: unknown }>(api.musicScoreCanvas(sessionId, jobId), { method: "POST" });
      canvasMessage(sessionId, { type: "focus", canvas });
    } catch (error) { setScoreError((error as Error).message); }
    finally { setOpeningScore(false); }
  };
  const share = async () => {
    const response = await fetch(api.musicAudio(sessionId, jobId));
    if (!response.ok) throw new Error("Music file is not ready to share");
    const file = new File([await response.blob()], `yula-song-${jobId}.ogg`, { type: "audio/ogg" });
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: "Yula song" });
    else window.location.assign(api.musicAudio(sessionId, jobId, true));
  };
  if (job.status === "error") return <div className="my-2 rounded-xl border border-danger/25 bg-danger/5 p-3 text-sm text-danger">{job.error || t("Music generation failed")}</div>;
  if (job.status !== "done") {
    const label = job.status === "loading" ? t("Loading music model")
      : job.status === "running" ? t("Composing music")
      : job.status === "waiting_for_gpu" ? t("Waiting for GPU") : t("Music queued");
    return <div className={`my-2 flex items-center gap-2 rounded-xl border border-line bg-raised/60 p-3 text-sm text-fg-muted${compact ? " max-w-sm" : ""}`}><LuLoaderCircle className="animate-spin" aria-hidden />{label}</div>;
  }
  if (controlsOnly) return <div className="my-2 flex max-w-sm items-center gap-2 rounded-xl border border-line bg-raised/60 p-2 text-xs text-fg-muted">
    <button type="button" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent hover:bg-accent/20" aria-label={t(playing ? "Pause" : "Play")} title={t(playing ? "Pause" : "Play")} onClick={() => window.dispatchEvent(new CustomEvent("pithagoras:music-control", { detail: { sessionId, jobId, action: "toggle" } }))}>{playing ? <LuPause aria-hidden /> : <LuPlay aria-hidden />}</button>
    <span className="min-w-0 flex-1 truncate">{t("Music playing")}</span>
  </div>;
  return <div className={`my-2 rounded-xl border border-line bg-raised/60 p-3${compact ? " max-w-sm" : ""}`}>
    <audio ref={audio} data-music-job={jobId} className="w-full" controls preload="metadata" src={api.musicAudio(sessionId, jobId)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
    {scoreError && <p role="alert" className="mt-2 text-xs text-danger">{scoreError}</p>}
    <div className="mt-2 flex flex-wrap justify-end gap-2">
      <button type="button" className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-fg-muted hover:bg-fg/5 disabled:opacity-50" disabled={openingScore || !(job.abc || job.request?.abc)} title={job.abc || job.request?.abc ? t("View score in canvas") : t("No score available for this song")} onClick={() => void openScore()}>{openingScore ? <LuLoaderCircle className="animate-spin" aria-hidden /> : <LuMusic2 aria-hidden />}{t("View score in canvas")}</button>
      <a className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-fg-muted hover:bg-fg/5" href={api.musicAudio(sessionId, jobId, true)} download><LuDownload aria-hidden />{t("Download")}</a>
      <button type="button" className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-fg-muted hover:bg-fg/5" onClick={() => void share()}><LuShare2 aria-hidden />{t("Share")}</button>
    </div>
  </div>;
}
