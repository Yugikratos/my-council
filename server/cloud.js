// Optional cloud tier: Google Gemini (free tier), used only for "/deep" turns.
//
// Mirrors server/ollama.js: it takes the EXACT same message list that the local
// path builds (system prompt + attributed [OBSERVED HISTORY] / [DATABASE MEMORY
// LOGS] + grounding, all from context.js) and streams text chunks in the same
// shape. The persona's identity, voice-bleed protection, grounding, and memory
// are therefore preserved unchanged — only the model behind the reply differs.
//
// SECURITY (this repo is public):
//   * The API key is read ONLY from process.env.GEMINI_API_KEY, at call time.
//   * It is sent ONLY to Google's official HTTPS endpoint, ONLY via the
//     x-goog-api-key header (never in the URL, never query string).
//   * It is NEVER logged, printed, put in an error message, or yielded.
//   * Errors are generic with a category code; the raw upstream body is never
//     read into a message or surfaced.

import { config } from "./config.js";

// Belt-and-braces: the key must only ever go to Google. Even if config were
// tampered with, refuse to send the key anywhere else.
const ALLOWED_HOST = "https://generativelanguage.googleapis.com";

/**
 * A cloud failure the caller can fall back from. `code` is a safe category
 * ("no-key", "disabled", "auth", "rate-limit", "network", "http-XXX", "bad-host")
 * — never any secret or raw upstream detail.
 */
export class CloudError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "CloudError";
    this.code = code;
  }
}

// Translate the local message list (system + user/assistant) into Gemini's
// request body. Gemini uses "model" for the assistant role and a separate
// system_instruction field.
function toGeminiPayload(messages) {
  let systemInstruction;
  const contents = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemInstruction = { parts: [{ text: m.content }] };
    } else {
      contents.push({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      });
    }
  }
  const body = {
    contents,
    generationConfig: { temperature: config.cloud.options.temperature },
  };
  if (systemInstruction) body.system_instruction = systemInstruction;
  return body;
}

/**
 * Open a streaming Gemini chat. All pre-token failures (no key, disabled, auth,
 * rate limit, network, bad status) throw a CloudError BEFORE anything is yielded,
 * so the caller can cleanly fall back to local for the turn.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @returns {Promise<AsyncGenerator<string>>} resolves once the stream is open.
 */
export async function openCloudStream(messages) {
  if (!config.cloud.enabled) throw new CloudError("cloud tier disabled", "disabled");

  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new CloudError("no API key configured", "no-key");

  if (!config.cloud.endpoint.startsWith(ALLOWED_HOST)) {
    // Never send the key to a non-Google host.
    throw new CloudError("refusing to send key to non-official host", "bad-host");
  }

  const url = `${config.cloud.endpoint}/models/${config.cloud.model}:streamGenerateContent?alt=sse`;

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key, // header, never the URL
      },
      body: JSON.stringify(toGeminiPayload(messages)),
    });
  } catch {
    // Network-level failure. Do NOT surface the raw error (avoid any chance of
    // echoing request details).
    throw new CloudError("network error reaching cloud", "network");
  }

  if (!response.ok) {
    const code =
      response.status === 401 || response.status === 403
        ? "auth"
        : response.status === 429
        ? "rate-limit"
        : `http-${response.status}`;
    // Discard the body unread — we never log or surface upstream error text.
    try {
      await response.body?.cancel();
    } catch {
      /* ignore */
    }
    throw new CloudError("cloud request failed", code);
  }

  return streamGeminiSse(response);
}

// Gemini's streamGenerateContent?alt=sse returns Server-Sent Events: lines of
// `data: {GenerateContentResponse}`. Yield the text from each chunk.
async function* streamGeminiSse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line.startsWith("data:")) continue;

      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;

      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue; // skip a partial/non-JSON line
      }

      const parts = json?.candidates?.[0]?.content?.parts;
      if (Array.isArray(parts)) {
        const text = parts.map((p) => p.text).filter(Boolean).join("");
        if (text) yield text;
      }
    }
  }
}
