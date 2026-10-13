/**
 * Meeting Notes: a separate, deliberately simple feature next to the voice
 * add-on, not built on top of it. Voice mode is turn-based - every VAD-
 * detected utterance is sent to the agent as a prompt, which replies and
 * speaks (hands-free.ts's speechEnd -> process() -> io.send(text)). That is
 * exactly wrong for a meeting: the agent should not reply to everything a
 * room full of people say, and should not try to speak over them.
 *
 * So this never prompts the agent per utterance at all. The client records
 * fixed-length chunks (no VAD, no turn-taking) and POSTs each one here to be
 * transcribed and appended to a plain text file in the chat's own workspace
 * - the same folder the Files panel already browses, so the raw transcript
 * is visible there like any other file, including mid-meeting. Only once,
 * on /stop, is the agent prompted at all - with a normal chat message
 * pointing at the transcript file, the same way a person would ask Pi to
 * "read this and summarize it". The agent's own `read` tool pulls the file
 * in, and its own canvas tool (already instructed - see pi/voice-first.ts -
 * to prefer a canvas for long structured output) is free to write the
 * summary there if it chooses to.
 *
 * Deliberately not handled: a browser tab closing without clicking Stop
 * leaves a dangling `active` entry and an un-summarized transcript file -
 * acceptable for a first version. The raw file is still on disk and the
 * user can ask the agent to read and summarize it manually, or restart
 * meeting notes from the Files panel.
 */
import express, { type Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { getSession } from "../db.js";
import { sessions } from "../session-manager.js";
import { config } from "./voice.js";

interface MeetingState {
  filePath: string;
  startedAt: number;
}

/** One recording per chat at a time - keyed by session id, lost on restart (acceptable: a restart mid-meeting is rare and the file on disk already has everything said up to that point). */
const active = new Map<string, MeetingState>();

function meetingsDir(workspace: string): string {
  const dir = path.join(workspace, ".meeting-notes");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function elapsedLabel(startedAt: number): string {
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

export function meetingNotesRouter(): Router {
  const router = express.Router();

  router.post("/sessions/:id/meeting/start", (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (active.has(session.id)) return res.status(409).json({ error: "A meeting is already being recorded in this chat" });
    const dir = meetingsDir(session.workspace);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = path.join(dir, `meeting-${stamp}.txt`);
    fs.writeFileSync(filePath, `# Meeting started ${new Date().toLocaleString()}\n\n`);
    active.set(session.id, { filePath, startedAt: Date.now() });
    res.json({ ok: true });
  });

  // One chunk at a time, body is a raw WAV recording - same contract as
  // voice.ts's own /voice/transcribe, deliberately not shared code: that
  // route also handles the conversational turn-taking refusal/timeout
  // behavior this one does not want.
  //
  // No raw audio is ever written to disk, here or anywhere else in this
  // feature: `req.body` (the WAV bytes) only ever goes into the in-memory
  // `FormData` below, forwarded straight to the Whisper endpoint over HTTP,
  // and is never passed to any `fs.*` call. The ONLY thing this route ever
  // writes to disk is the transcribed TEXT, a few lines down. Express's
  // `express.raw()` buffers the body in memory for the duration of this
  // handler and does not persist it either.
  router.post("/sessions/:id/meeting/chunk", express.raw({ type: "audio/wav", limit: "12mb" }), async (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    const state = active.get(session.id);
    if (!state) return res.status(409).json({ error: "No meeting is being recorded in this chat" });
    if (!Buffer.isBuffer(req.body) || req.body.length < 44 || req.body.toString("ascii", 0, 4) !== "RIFF")
      return res.status(400).json({ error: "A WAV recording is required" });
    const settings = config();
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(req.body)], { type: "audio/wav" }), "chunk.wav");
    form.set("response_format", "json");
    form.set("language", settings.language);
    if (settings.sttModel) form.set("model", settings.sttModel);
    try {
      const upstream = await fetch(settings.whisperUrl, { method: "POST", body: form, redirect: "error", signal: AbortSignal.timeout(60000) });
      if (!upstream.ok) throw new Error(`Whisper returned HTTP ${upstream.status}`);
      const result = await upstream.json() as { text?: unknown };
      const text = typeof result.text === "string" ? result.text.trim() : "";
      // A silent chunk (nobody spoke in those ~15s) transcribes to empty -
      // skip it rather than clutter the transcript with blank timestamps.
      if (text) fs.appendFileSync(state.filePath, `[${elapsedLabel(state.startedAt)}] ${text}\n`);
      res.json({ ok: true });
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  });

  router.post("/sessions/:id/meeting/stop", async (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    const state = active.get(session.id);
    if (!state) return res.status(409).json({ error: "No meeting is being recorded in this chat" });
    active.delete(session.id);
    fs.appendFileSync(state.filePath, `\n# Meeting ended ${new Date().toLocaleString()}\n`);
    const relPath = path.relative(session.workspace, state.filePath);
    try {
      await sessions.prompt(
        session.id,
        `A meeting just ended. The raw transcript is in ${relPath}. Read that file and summarize the meeting as structured notes: main topics, decisions made, and any action items (who/what). Write the summary in whatever language the transcript itself is in.`,
      );
      res.json({ ok: true, transcriptPath: relPath });
    } catch (e) {
      res.status(502).json({ error: (e as Error).message, transcriptPath: relPath });
    }
  });

  return router;
}
