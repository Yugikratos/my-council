// Node client for the local STT service (stt-service/, a faster-whisper wrapper).
//
// Mirrors memory.js: a thin localhost proxy that FAILS SOFT. The browser uploads
// audio to the Node app (POST /api/transcribe), and we forward it here so the
// browser never talks to the Python service directly. If STT is down or the audio
// is unusable, we return an error the route surfaces to the UI — chat itself is a
// separate path and is never affected.

import { config } from "./config.js";

const { url, enabled, timeoutMs } = config.stt;

/**
 * Forward an uploaded audio payload to the STT service for transcription.
 * @param {Buffer} body raw request body — the multipart/form-data payload, with
 *   the audio in a field named "file" (we forward it verbatim, boundary intact).
 * @param {string} contentType the incoming Content-Type header (carries the
 *   multipart boundary the Python side needs to parse the upload).
 * @returns {Promise<{ok: boolean, text: string, error?: string}>}
 *   ok=false means STT was unreachable/disabled (the route returns 503).
 */
export async function transcribe(body, contentType) {
  if (!enabled) return { ok: false, text: "", error: "Speech-to-text is disabled." };

  // CPU transcription takes a few seconds; allow headroom but bound it so a hung
  // service can't stall the request forever.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/transcribe`, {
      method: "POST",
      headers: contentType ? { "content-type": contentType } : {},
      body,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`STT service responded ${res.status}`);
    const data = await res.json();
    return { ok: true, text: data.text ?? "" };
  } catch (err) {
    console.warn(`[stt] transcribe failed: ${err.message}`);
    return { ok: false, text: "", error: "Speech-to-text is unavailable." };
  } finally {
    clearTimeout(timer);
  }
}
