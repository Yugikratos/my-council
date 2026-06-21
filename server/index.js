// My Council — backend server.
// Serves the static chat UI and exposes a streaming chat endpoint. The server
// is stateless: the browser sends the full conversation each turn, and we wrap
// it with the active persona's system prompt before relaying it to Ollama.

import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";

import { config } from "./config.js";
import { streamChat, OllamaUnavailableError } from "./ollama.js";
import { openCloudStream } from "./cloud.js";
import { getPersona, listPersonas, DEFAULT_PERSONA_ID } from "./personas/index.js";
import { buildOllamaMessages } from "./context.js";
import { createReplyFilter } from "./reply-filter.js";
import { splitSentences } from "./text.js";
import { synthesize, registerAudio, getAudioPath, prewarm } from "./tts.js";
import { transcribe } from "./stt.js";
import { retrieve, store } from "./memory.js";

// A turn routes to the optional cloud tier only when prefixed with "/deep".
// Kept here as the single, obvious routing rule.
const DEEP_MARKER = /^\/deep\b[ \t]*/i;

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "..", "public");

const app = express();
app.use(express.json());
app.use(express.static(publicDir));

// List the available personas (used to populate the UI picker).
app.get("/api/personas", (req, res) => {
  res.json({ personas: listPersonas(), default: DEFAULT_PERSONA_ID });
});

// Serve a synthesized WAV referenced by an "audio" SSE event's url. Resolves
// only through the in-memory registry (tts.js validates id/seq and confirms the
// file is one we produced in the temp dir), so a request can never name an
// arbitrary path — no traversal surface.
app.get("/api/tts", (req, res) => {
  const id = req.query.id;
  const seq = Number(req.query.seq);
  const path = getAudioPath(id, seq);
  if (!path) return res.status(404).end();
  res.setHeader("Content-Type", "audio/wav");
  res.setHeader("Cache-Control", "no-store");
  createReadStream(path)
    .on("error", () => res.status(500).end())
    .pipe(res);
});

// Transcribe an uploaded push-to-talk audio clip via the local STT service.
// This is a SEPARATE endpoint from chat: it only returns text. The frontend puts
// that text into the composer and sends it through the normal /api/chat path —
// memory, persona, /deep, and TTS logic are untouched.
//
// FRONTEND CONTRACT (mic capture is built separately against this):
//   Request:  POST /api/transcribe
//             Content-Type: multipart/form-data
//             ONE file field named "file" — the recorded clip. webm/opus from
//             MediaRecorder is expected; wav also works. No other fields.
//   Response: 200 { "text": "..." }   — transcript ("" if silence/no speech)
//             503 { "error": "..." }  — STT unavailable/disabled (show, fail soft)
//
// express.raw buffers the multipart body verbatim (the global express.json()
// ignores non-JSON bodies), and stt.js forwards it with the original Content-Type
// so the boundary survives. No multipart parsing — and no new npm dependency.
app.post("/api/transcribe", express.raw({ type: "*/*", limit: "25mb" }), async (req, res) => {
  const { ok, text, error } = await transcribe(req.body, req.headers["content-type"]);
  if (!ok) return res.status(503).json({ error: error ?? "Speech-to-text is unavailable." });
  res.json({ text });
});

// Streaming chat endpoint.
// Request body: { personaId?: string, messages: [{ role, content }, ...] }
// Response: Server-Sent Events, one JSON payload per `data:` frame:
//   { type: "token", value: "..." }  — a piece of the reply
//   { type: "done", source }         — the reply is complete (source: local|cloud)
//   { type: "notice", message }      — non-fatal info (e.g. memory unavailable)
//   { type: "error", message: "..." }— something went wrong
//   { type: "audio", utteranceId, seq, url, last } — OPTIONAL spoken audio
//       Emitted AFTER "done", one per sentence, only when TTS is enabled and
//       synthesis succeeds. The token text contract is unchanged: text streams
//       and completes exactly as before, so a client that ignores "audio" (the
//       current frontend does) behaves identically. Shape:
//         utteranceId — id grouping this reply's sentences (one per reply)
//         seq         — 0-based sentence index; play in ascending order
//         url         — GET it for the WAV bytes: /api/tts?id=<id>&seq=<seq>
//         last        — true on the final sentence of the reply
//       Per-sentence so the first can play while later ones still synthesize.
//
// Memory is layered BENEATH the chat loop: we retrieve relevant long-term
// memories before building the prompt, and store the exchange after replying.
// Both fail soft — if the memory service is down, chat still works in-session.
app.post("/api/chat", async (req, res) => {
  const { personaId = DEFAULT_PERSONA_ID, messages } = req.body ?? {};

  const persona = getPersona(personaId);
  if (!persona) {
    return res.status(400).json({ error: `Unknown persona: ${personaId}` });
  }
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: "`messages` must be an array." });
  }

  // The latest user message drives both the reply and memory retrieval.
  const latestUser = [...messages].reverse().find((m) => m.role === "user");
  const rawLatest = latestUser?.content ?? "";

  // --- Routing decision (the ONE place it's made) ---------------------------
  // "/deep ..." routes this turn to the cloud tier (Gemini); everything else
  // stays on local Gemma. Strip the marker so the persona never sees it, and use
  // the cleaned text everywhere downstream (prompt, retrieval, storage). The
  // persona, context, grounding, and memory are identical either way — only the
  // model behind the reply changes.
  const routeToCloud = DEEP_MARKER.test(rawLatest.trimStart());
  const query = routeToCloud ? rawLatest.trimStart().replace(DEEP_MARKER, "") : rawLatest;

  // If a marker was stripped, rebuild the message list with the cleaned latest
  // user turn so context.js and the model get the real question, not "/deep ...".
  const promptMessages =
    routeToCloud && latestUser
      ? messages.map((m) => (m === latestUser ? { ...m, content: query } : m))
      : messages;

  // Retrieve relevant memories from earlier sessions (fails soft).
  const { ok: memoryOk, memories } = await retrieve(query);

  // Build the message list: the persona's character sheet, retrieved long-term
  // memories as attributed context, then the in-session conversation (with other
  // Council members' turns attributed by name). The SAME list feeds either model.
  const fullMessages = buildOllamaMessages(persona, promptMessages, memories);

  // Open a Server-Sent Events stream to the browser.
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  // Let the user know if long-term memory couldn't be reached this turn.
  if (!memoryOk) {
    send({
      type: "notice",
      message:
        "Long-term memory is unavailable — continuing with this session only. " +
        "(Is the memory service running? See README.)",
    });
  }

  let completed = false;
  // Which model actually produced the reply, reported to the UI in the "done"
  // event (carries no sensitive data). Starts as the routed choice; flips to
  // "local" if the cloud call fails before any token and we fall back.
  let source = routeToCloud ? "cloud" : "local";

  // One sanitizer per reply enforces the voice constraints on the MODEL'S output
  // (strips stage directions, *actions*, speaker labels, newlines; caps to 3
  // sentences) — the prompt alone doesn't reliably hold on a small model. Both
  // the local and cloud paths feed through it. It buffers any unstable tail and
  // emits only the new clean suffix, so the UI keeps streaming. See reply-filter.js.
  let filter = createReplyFilter({ displayName: persona.displayName });

  const pushToken = (token) => {
    const add = filter.push(token);
    if (add) send({ type: "token", value: add });
  };
  // Flush any held tail once a stream ends (closes off the cleaned reply).
  const flushReply = () => {
    const tail = filter.flush();
    if (tail) send({ type: "token", value: tail });
  };

  try {
    if (routeToCloud) {
      try {
        const cloudStream = await openCloudStream(fullMessages);
        for await (const token of cloudStream) pushToken(token);
        flushReply();
      } catch (cloudErr) {
        // If the cloud already streamed part of a reply, we can't cleanly restart
        // — let the outer handler report it. Otherwise fall back to local Gemma
        // for this turn so the user's message is never lost. The key never
        // appears in cloudErr (sanitized in cloud.js); log only a category.
        if (filter.text().length > 0) throw cloudErr;
        console.warn(`[cloud] unavailable (${cloudErr?.code ?? "error"}); using local model`);
        send({
          type: "notice",
          message: "Deep mode (cloud) was unavailable — answered with the local model instead.",
        });
        source = "local";
        // Fresh filter so the local attempt starts from a clean slate.
        filter = createReplyFilter({ displayName: persona.displayName });
        for await (const token of streamChat(fullMessages)) pushToken(token);
        flushReply();
      }
    } else {
      for await (const token of streamChat(fullMessages)) pushToken(token);
      flushReply();
    }
    completed = true;
    send({ type: "done", source });

    // --- Optional spoken audio --------------------------------------------
    // After the text reply is fully done, synthesize it per sentence and emit
    // an "audio" event per WAV. This is strictly additive: the token stream and
    // "done" already fired with unchanged timing, so a client ignoring "audio"
    // is unaffected. Best-effort — synthesize() fails soft (returns null) and
    // the whole block is wrapped so TTS can NEVER break a delivered reply. We
    // keep the connection open through synthesis (res.end() is in finally).
    if (config.tts.enabled) {
      try {
        const sentences = splitSentences(filter.text());
        const utteranceId = randomUUID();
        for (let seq = 0; seq < sentences.length; seq++) {
          const wav = await synthesize(sentences[seq], persona.id);
          if (!wav) break; // missing piper/model — stop trying this turn
          registerAudio(utteranceId, seq, wav);
          send({
            type: "audio",
            utteranceId,
            seq,
            url: `/api/tts?id=${utteranceId}&seq=${seq}`,
            last: seq === sentences.length - 1,
          });
        }
      } catch {
        /* never let audio synthesis affect the already-delivered reply */
      }
    }
  } catch (err) {
    console.error("[api/chat] Error during generation:", err);
    if (err instanceof OllamaUnavailableError) {
      send({
        type: "error",
        message:
          "Can't reach Ollama. Make sure it's running (launch the Ollama app, " +
          "or run `ollama serve` in another terminal) and that the model is " +
          "pulled (`ollama pull gemma3:4b`), then try again.",
      });
    } else {
      // Generic on purpose — never surface a raw upstream error (defends against
      // any chance of leaking sensitive request detail).
      send({
        type: "error",
        message: "Something went wrong generating the reply. Please try again.",
      });
    }
  } finally {
    res.end();
  }

  // Persist the completed exchange verbatim, tagged with the active persona
  // (fails soft; happens after the response is already sent to the client).
  // Store the SANITIZED reply — the same text the user saw and that TTS will
  // speak — so memory stays consistent with what was actually said.
  const finalReply = filter.text();
  if (completed && query && finalReply) {
    await store({
      personaId: persona.id,
      personaName: persona.displayName,
      userMessage: query,
      reply: finalReply,
    });
  }
});

// Bind to loopback only. This is a personal, local-first app holding private
// memory and able to spend the Gemini key (via /deep) — it must NOT be reachable
// from the local network. Matches how the Python services bind 127.0.0.1.
app.listen(config.port, "127.0.0.1", () => {
  console.log("\nMy Council is running.");
  console.log(`  Open http://localhost:${config.port} in your browser.`);
  console.log(`  Talking to Ollama at ${config.ollama.baseUrl} (model: ${config.ollama.model}).`);
  console.log(
    `  Long-term memory: ${config.memory.enabled ? config.memory.url : "disabled"}.`
  );
  console.log("  Press Ctrl+C to stop.\n");

  // Warm ONE voice in the BACKGROUND after the port is open. The active persona
  // is chosen client-side and unknown here, so we warm the default (Kratos);
  // every other voice warms naturally on its first real synthesis. Not awaited
  // → never delays the server accepting requests. Fail-soft inside prewarm().
  // Warming a single voice (not all six) avoids D: drive + CPU contention while
  // Ollama is loading Gemma into VRAM at the same moment.
  prewarm(DEFAULT_PERSONA_ID);
});
