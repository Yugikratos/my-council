// Central configuration for the My Council backend.
// Everything environment-specific lives here so there's one place to change it.
// Each value can be overridden with an environment variable.

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
};
