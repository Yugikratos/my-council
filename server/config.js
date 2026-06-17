// Central configuration for the My Council backend.
// Everything environment-specific lives here so there's one place to change it.
// Each value can be overridden with an environment variable.

// Load a local .env (gitignored) before reading any env vars. Side-effect import.
import "./env.js";

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Repo root, so default TTS paths can point at a vendored tools/piper/ dir
// regardless of where the process is launched from.
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

export const config = {
  // Port the local web server listens on.
  port: Number(process.env.PORT) || 3000,

  ollama: {
    // Local Ollama HTTP API. Ollama serves here by default.
    baseUrl: process.env.OLLAMA_URL || "http://localhost:11434",

    // The model must already be pulled in Ollama (`ollama pull gemma3:4b`).
    model: process.env.OLLAMA_MODEL || "gemma3:4b",

    // Generation parameters passed to Ollama. 4k context keeps the 4B model's
    // weights + KV cache within the GTX 1650's 4GB VRAM (avoids spilling to
    // CPU/RAM); long-term recall comes from the memory layer, not a big window.
    // temperature gives the persona room to breathe without going off the rails.
    options: {
      num_ctx: 4096,
      temperature: 0.8,
    },
  },

  // Local long-term memory service (ChromaDB wrapper). See memory-service/.
  // N (retrieval breadth) and the data path live in the Python config.
  memory: {
    url: process.env.MEMORY_URL || "http://127.0.0.1:8000",
    // Master switch. Set MEMORY_ENABLED=false to run pure in-session chat.
    enabled: process.env.MEMORY_ENABLED !== "false",
  },

  // Optional hybrid cloud tier (Google Gemini, free tier). Local Gemma stays the
  // default for ALL chat; a turn only goes to the cloud when the user prefixes it
  // with "/deep", and it falls back to local on any failure. See server/cloud.js.
  //
  // SECURITY: the API key is NEVER stored here. It is read at call time only from
  // the GEMINI_API_KEY environment variable (or a gitignored .env). The endpoint
  // is fixed to Google's official HTTPS host (NOT env-overridable) so the key can
  // never be redirected elsewhere.
  cloud: {
    // Master switch. Set CLOUD_ENABLED=false to disable /deep entirely (it will
    // then always fall back to local). Even when true, /deep needs a key set.
    enabled: process.env.CLOUD_ENABLED !== "false",
    // Fixed official endpoint base. Do not make this env-overridable — the key is
    // only ever sent here, over HTTPS.
    endpoint: "https://generativelanguage.googleapis.com/v1beta",
    // Which Gemini model to use. Free-tier flash by default; override with
    // GEMINI_MODEL if desired. Kept in sync with the deployed .env so /deep
    // doesn't silently downgrade if that line is ever dropped.
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    options: { temperature: 0.8 },
  },

  // Local TTS (Piper). Best-effort and OFF the critical path: if piper.exe or a
  // voice model is missing, synthesis fails soft (server/tts.js logs once and
  // returns null) and chat is unaffected. Nothing here is sent to any network.
  tts: {
    // Master switch. Default ON; set TTS_ENABLED=false to skip synthesis
    // entirely (no audio events emitted).
    enabled: process.env.TTS_ENABLED !== "false",

    // Vendored binary + voices. Defaults point at tools/piper/ in the repo;
    // override with PIPER_PATH / VOICES_DIR. piper.exe is NOT committed — vendor
    // it locally. Each voice needs BOTH <name>.onnx and <name>.onnx.json.
    piperPath: process.env.PIPER_PATH || join(repoRoot, "tools", "piper", "piper.exe"),
    voicesDir: process.env.VOICES_DIR || join(repoRoot, "tools", "piper", "voices"),

    // Optional post-synthesis pitch shift (ffmpeg). Piper itself has NO pitch
    // control — only an external tool can lower pitch, which is the only way to
    // reach a true Kratos register. ffmpeg is resolved from PATH by default;
    // override with FFMPEG_PATH. If ffmpeg is absent the shift is skipped and
    // the un-pitched WAV is served (synthesis still works — see server/tts.js).
    ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",

    // How many recent utterance WAVs to keep in OS temp before pruning oldest.
    retain: Number(process.env.TTS_RETAIN) || 12,

    // Shared synthesis params; per-persona entries below override as needed.
    // length_scale > 1 = slower/heavier; noise_* shape expressiveness.
    // pitch < 1 = deeper voice (post-shift via ffmpeg); 1.0 = no shift.
    defaults: { length_scale: 1.0, noise_scale: 0.667, noise_w: 0.8, pitch: 1.0 },

    // Per-persona voice map. `model` is a filename inside voicesDir (the .onnx;
    // its matching .onnx.json must sit beside it). Names below are sensible
    // Piper voices to drop in; swap freely. Tuned to match each character's vibe
    // (deep/slow for Kratos, lighter/quicker for Anya).
    voices: {
      // pitch 0.82 (~3 semitones down) for a deep Kratos register — verified by ear.
      kratos: { model: "en_GB-alan-medium.onnx", length_scale: 1.3, noise_scale: 0.6, pitch: 0.82 },
      dante: { model: "en_US-joe-medium.onnx", length_scale: 0.95 },
      vergil: { model: "en_US-ryan-medium.onnx", length_scale: 1.1, noise_scale: 0.5 },
      jiraiya: { model: "en_US-bryce-medium.onnx", length_scale: 1.05 },
      naruto: { model: "en_US-joe-medium.onnx", length_scale: 0.9, noise_w: 0.9 },
      anya: { model: "en_US-amy-medium.onnx", length_scale: 0.95, noise_w: 0.9 },
    },
  },
};
