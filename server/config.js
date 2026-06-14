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

    // Generation parameters passed to Ollama. num_ctx matches the 8k budget
    // chosen for the GTX 1650 (4GB) constraint; temperature gives the persona
    // a little room to breathe without going off the rails.
    options: {
      num_ctx: 8192,
      temperature: 0.8,
    },
  },
};
