"""My Council — local speech-to-text (STT) service.

A thin FastAPI wrapper around faster-whisper, parallel to the memory service.
Like that service it is one long-lived process: the Whisper model loads ONCE at
startup (CPU, int8) and is reused for every request — never per request. CPU-only
on purpose; the GTX 1650's VRAM stays reserved for Gemma.

faster-whisper decodes audio via PyAV (which bundles ffmpeg), so webm/opus from
the browser's MediaRecorder and plain wav both work with NO system ffmpeg binary
required.

Endpoints:
  GET  /health      -> { ok, model, device, compute_type }
  POST /transcribe  -> multipart upload (field "file": webm/opus or wav) -> { text }
"""
import os
import tempfile

from faster_whisper import WhisperModel
from fastapi import FastAPI, File, UploadFile

import config

# --- Model (loaded once at startup, reused for every request) ---------------

# Hardware constraint guard: STT must stay strictly on CPU with int8 quantization
# to prevent any VRAM allocation on the GTX 1650 (reserved entirely for Gemma 3 4B).
device_to_use = "cpu"
compute_type_to_use = "int8"
if config.DEVICE != "cpu" or config.COMPUTE_TYPE != "int8":
    print(f"[stt] Enforcing hardware safety: overriding device={config.DEVICE} to 'cpu' and compute_type={config.COMPUTE_TYPE} to 'int8'")

print(
    f"Loading faster-whisper model '{config.MODEL_SIZE}' "
    f"(device={device_to_use}, compute={compute_type_to_use})... "
    "first run downloads it (~145MB for 'base')."
)
model = WhisperModel(config.MODEL_SIZE, device=device_to_use, compute_type=compute_type_to_use)
print("Model loaded.")

app = FastAPI(title="My Council STT")


@app.get("/health")
def health():
    return {
        "ok": True,
        "model": config.MODEL_SIZE,
        "device": device_to_use,
        "compute_type": compute_type_to_use,
    }


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    # Read the upload, write it to a temp file, and hand the path to faster-whisper.
    # NEVER crash on bad/empty audio — return { text: "", error } and log once, so
    # the Node proxy and frontend can fail soft just like the memory path.
    try:
        data = await file.read()
    except Exception as e:  # noqa: BLE001 - fail soft on any read error
        print(f"[stt] failed to read upload: {e}")
        return {"text": "", "error": "could not read audio"}

    if not data:
        return {"text": "", "error": "empty audio"}

    # Preserve the upload's extension so PyAV picks the right demuxer; default to
    # .webm (what MediaRecorder produces).
    suffix = os.path.splitext(file.filename or "")[1] or ".webm"
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(data)
            tmp_path = tmp.name

        language = config.LANGUAGE or None  # "" -> auto-detect
        segments, _info = model.transcribe(
            tmp_path, beam_size=config.BEAM_SIZE, language=language
        )
        # segments is a lazy generator — iterating it runs the decode.
        text = "".join(segment.text for segment in segments).strip()
        return {"text": text}
    except Exception as e:  # noqa: BLE001 - never crash the service on bad audio
        print(f"[stt] transcription failed: {e}")
        return {"text": "", "error": "transcription failed"}
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


if __name__ == "__main__":
    import uvicorn

    print(f"My Council STT service starting on http://{config.HOST}:{config.PORT}")
    print(f"  Model: {config.MODEL_SIZE} | device: {config.DEVICE} | compute: {config.COMPUTE_TYPE}")
    uvicorn.run(app, host=config.HOST, port=config.PORT)
