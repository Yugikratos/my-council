// Ollama client. Isolates all LLM transport behind a single streaming function
// so the rest of the app never touches the HTTP details. When a cloud tier is
// added later, it slots in alongside this module without changing the routes.

import { config } from "./config.js";

const { baseUrl, model, options, keepAlive } = config.ollama;

// Thrown when we can't reach Ollama at all (e.g. it isn't running). The server
// catches this specifically to show a friendly "start Ollama" message.
export class OllamaUnavailableError extends Error {}

/**
 * Pre-warm and pin the configured model into Ollama VRAM in the background.
 * Non-blocking, fails soft if Ollama is unreachable.
 */
export async function prewarmOllama() {
  try {
    const response = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: "",
        keep_alive: keepAlive,
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (response.ok) {
      console.log(`[ollama] Model "${model}" pre-warmed and pinned in VRAM (keep_alive: ${keepAlive}).`);
    } else {
      console.warn(`[ollama] Pre-warm returned status ${response.status}`);
    }
  } catch (err) {
    console.warn(`[ollama] Pre-warm skipped (${err.message})`);
  }
}

/**
 * Stream a chat completion from the local Ollama server.
 *
 * @param {Array<{role: string, content: string}>} messages - the full message
 *        list: system prompt first, then the alternating user/assistant turns.
 * @returns {AsyncGenerator<string>} yields response text chunks as they arrive.
 */
export async function* streamChat(messages) {
  let response;
  try {
    response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        keep_alive: keepAlive,
        options,
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    if (err.name === "TimeoutError") {
      throw new Error(`Ollama timed out waiting for model "${model}" to load into VRAM after 90s.`);
    }
    // fetch rejects (ECONNREFUSED) when nothing is listening on the port.
    throw new OllamaUnavailableError(`Could not reach Ollama at ${baseUrl}`);
  }

  if (!response.ok) {
    // A 404 here usually means the model hasn't been pulled.
    const detail = await response.text().catch(() => "");
    throw new Error(`Ollama returned ${response.status}. ${detail}`.trim());
  }

  // Ollama streams newline-delimited JSON objects, each carrying a small piece
  // of the reply in message.content. We buffer partial lines because a single
  // network chunk can split a JSON object across reads.
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
      if (!line) continue;

      let json;
      try {
        json = JSON.parse(line);
      } catch {
        continue; // skip anything that isn't a complete JSON line
      }

      if (json.message?.content) {
        yield json.message.content;
      }
      // json.done === true marks the end of the stream.
    }
  }
}
