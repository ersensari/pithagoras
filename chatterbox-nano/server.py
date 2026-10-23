#!/usr/bin/env python3
"""Chatterbox-Nano (English-only, CPU) TTS server for Yulify's Voice add-on.

Yulify's managed Voice installer only offers audio.cpp's GGUF conversion
of Chatterbox *Multilingual* (one ~500M-param file, all 23 languages baked
in, GPU-only, and its CMake build failed on this host). This server speaks
the same wire contract Yulify's runtime="chatterbox" branch already
sends to `breezeUrl` (api/voice.ts's /sessions/:id/voice/speech handler), so
it's a drop-in replacement: point breezeUrl at this server instead of the
managed container's 127.0.0.1:7860.

Model: ChatterboxTurboTTS(nano=True) - 110M params, English-only, no GPU
needed (README: "3x realtime on 8 CPU cores"). Deliberately NOT the
Multilingual model: the point of this server is to avoid downloading/running
the ~500M multilingual weights when only English is wanted.

Request body (exact shape Yulify sends for runtime="chatterbox"):
  {"model": "chatterbox", "input": "<text>", "language": "<ignored, English-only>",
   "response_format": "wav", "options": {"exaggeration": "0.5", "seed": "42"},
   "voice_ref": {"type": "base64", "data": "<base64 wav>"}}
Response: raw WAV bytes, Content-Type: audio/wav (Yulify checks this
content-type and converts the WAV itself - see wavPcm() in api/voice.ts).
"""
import base64
import io
import os
import tempfile
import threading

import soundfile as sf
import torch
from chatterbox.tts_turbo import ChatterboxTurboTTS
from fastapi import Body, FastAPI, HTTPException
from fastapi.responses import Response
from contextlib import asynccontextmanager

model: ChatterboxTurboTTS | None = None
_lock = threading.Lock()


@asynccontextmanager
async def lifespan(app: FastAPI):
    global model
    model = ChatterboxTurboTTS.from_pretrained(device="cpu", nano=True)
    yield


app = FastAPI(lifespan=lifespan)


@app.get("/health")
def health():
    return {"engine": "chatterbox-nano", "language": "en", "device": "cpu", "loaded": model is not None}


@app.post("/v1/audio/speech")
def audio_speech(req: dict = Body(...)):
    text = (req.get("input") or "").strip()
    if not text:
        raise HTTPException(400, "input required")
    voice_ref = req.get("voice_ref") or {}
    if voice_ref.get("type") != "base64" or not voice_ref.get("data"):
        raise HTTPException(400, "voice_ref.data (base64 wav) required - Chatterbox always clones a reference voice")
    options = req.get("options") or {}
    try:
        exaggeration = float(options.get("exaggeration", 0.5))
    except (TypeError, ValueError):
        exaggeration = 0.5
    try:
        seed = int(options.get("seed", 42))
    except (TypeError, ValueError):
        seed = 42

    ref_bytes = base64.b64decode(voice_ref["data"])
    with tempfile.NamedTemporaryFile(suffix=".wav") as ref_file:
        ref_file.write(ref_bytes)
        ref_file.flush()
        with _lock:
            torch.manual_seed(seed)
            assert model is not None
            wav = model.generate(text, audio_prompt_path=ref_file.name, exaggeration=exaggeration)

    audio = wav.squeeze().cpu().numpy()
    buf = io.BytesIO()
    # Yulify's wavPcm() (api/voice.ts) refuses anything but mono/24kHz/16-bit
    # PCM and does not resample - PCM_16 must be explicit, soundfile defaults to
    # float32 for a float input array otherwise.
    sf.write(buf, audio, model.sr, format="WAV", subtype="PCM_16")
    return Response(content=buf.getvalue(), media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8099)))
