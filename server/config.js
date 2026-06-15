// Central configuration for the My Council backend.
// Everything environment-specific lives here so there's one place to change it.
// Each value can be overridden with an environment variable.

// Load a local .env (gitignored) before reading any env vars. Side-effect import.
import "./env.js";

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
    // Which Gemini model to use. Free-tier flash by default; override if desired.
    model: process.env.GEMINI_MODEL || "gemini-1.5-flash",
    options: { temperature: 0.8 },
  },
};
