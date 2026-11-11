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
import { streamChat, prewarmOllama, OllamaUnavailableError } from "./ollama.js";
import { openCloudStream } from "./cloud.js";
import { getPersona, listPersonas, DEFAULT_PERSONA_ID } from "./personas/index.js";
import { buildOllamaMessages } from "./context.js";
import { createReplyFilter } from "./reply-filter.js";
import { SentenceStreamer } from "./sentence-streamer.js";
import { createTtsPipeline } from "./tts-pipeline.js";
import { getAudioPath, prewarm } from "./tts.js";
import { transcribe } from "./stt.js";
import { retrieve, store } from "./memory.js";
import { routeTurn } from "./router.js";
import { idleDetector } from "./idle-detector.js";

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
  idleDetector.recordActivity();
  const { ok, text, error } = await transcribe(req.body, req.headers["content-type"]);
  if (!ok) return res.status(503).json({ error: error ?? "Speech-to-text is unavailable." });
  res.json({ text });
});

// Streaming chat endpoint.
// Request body: { personaId?: string, messages: [{ role, content }, ...] }
// Response: Server-Sent Events, one JSON payload per `data:` frame:
//   { type: "token", value: "..." }  — a piece of the reply
//   { type: "route", personaId, displayName, method, confidence } — routed persona event
//   { type: "done", source }         — the reply is complete (source: local|cloud)
//   { type: "notice", message }      — non-fatal info (e.g. memory unavailable)
//   { type: "error", message: "..." }— something went wrong
//   { type: "audio", utteranceId, seq, url, last } — OPTIONAL spoken audio
app.post("/api/chat", async (req, res) => {
  await idleDetector.preempt();

  const { personaId = "auto", messages } = req.body ?? {};

  const isAutoRoute = personaId === "auto" || !personaId;
  let persona = !isAutoRoute ? getPersona(personaId) : null;
  if (!isAutoRoute && !persona) {
    return res.status(400).json({ error: `Unknown persona: ${personaId}` });
  }
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: "`messages` must be an array." });
  }

  // The latest user message drives both the reply and memory retrieval.
  const latestUser = [...messages].reverse().find((m) => m.role === "user");
  const rawLatest = latestUser?.content ?? "";

  // --- Routing decision -----------------------------------------------------
  const routeToCloud = DEEP_MARKER.test(rawLatest.trimStart());
  const query = routeToCloud ? rawLatest.trimStart().replace(DEEP_MARKER, "") : rawLatest;

  // In Auto / Council mode, route to the best persona using our 3-tier router
  let routeDecision = null;
  if (isAutoRoute) {
    const lastAssistantTurn = [...messages].reverse().find((m) => m.role === "assistant");
    const currentSpeaker = lastAssistantTurn?.persona || DEFAULT_PERSONA_ID;
    routeDecision = await routeTurn({ query, currentPersonaId: currentSpeaker });
    persona = getPersona(routeDecision.personaId) || getPersona(DEFAULT_PERSONA_ID);
  }

  // If a marker was stripped, rebuild the message list with the cleaned latest
  // user turn so context.js and the model get the real question, not "/deep ...".
  const promptMessages =
    routeToCloud && latestUser
      ? messages.map((m) => (m === latestUser ? { ...m, content: query } : m))
      : messages;

  // Retrieve relevant memories from earlier sessions with RBAC filtering (fails soft).
  const { ok: memoryOk, memories } = await retrieve(query, persona.id);

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

  if (isAutoRoute && routeDecision) {
    send({
      type: "route",
      personaId: persona.id,
      displayName: persona.displayName,
      method: routeDecision.method,
      confidence: routeDecision.confidence,
    });
  }

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

  // Utterance grouping ID for spoken audio chunks
  const utteranceId = randomUUID();
  let sentenceStreamer = null;
  let ttsPipeline = null;

  function initStreamingTts() {
    if (config.tts.enabled) {
      if (ttsPipeline) ttsPipeline.cancel();
      ttsPipeline = createTtsPipeline({
        personaId: persona.id,
        utteranceId,
        onAudioReady: (event) => send(event),
      });
      sentenceStreamer = new SentenceStreamer({ minChars: 20 });
    }
  }

  initStreamingTts();

  // If the client disconnects or aborts early, cancel the background TTS pipeline
  // to avoid consuming CPU cycles on unsent audio.
  req.on("close", () => {
    if (ttsPipeline) ttsPipeline.cancel();
  });

  const pushToken = (token) => {
    const add = filter.push(token);
    if (add) {
      send({ type: "token", value: add });
      if (sentenceStreamer && ttsPipeline) {
        const sentences = sentenceStreamer.push(add);
        for (const s of sentences) {
          ttsPipeline.enqueue(s, false);
        }
      }
    }
  };

  // Flush any held tail once a stream ends (closes off the cleaned reply).
  const flushReply = () => {
    const tail = filter.flush();
    if (tail) {
      send({ type: "token", value: tail });
      if (sentenceStreamer && ttsPipeline) {
        const sentences = sentenceStreamer.push(tail);
        for (const s of sentences) {
          ttsPipeline.enqueue(s, false);
        }
      }
    }
    if (sentenceStreamer && ttsPipeline) {
      const remaining = sentenceStreamer.flush();
      for (let i = 0; i < remaining.length; i++) {
        const isLast = i === remaining.length - 1;
        ttsPipeline.enqueue(remaining[i], isLast);
      }
      ttsPipeline.finish();
    }
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
        // Fresh filter and streaming pipeline so the local attempt starts from a clean slate.
        filter = createReplyFilter({ displayName: persona.displayName });
        initStreamingTts();
        for await (const token of streamChat(fullMessages)) pushToken(token);
        flushReply();
      }
    } else {
      for await (const token of streamChat(fullMessages)) pushToken(token);
      flushReply();
    }
    completed = true;
    send({ type: "done", source });

    // Await completion of in-flight TTS synthesis before closing connection
    if (ttsPipeline) {
      try {
        await ttsPipeline.drain();
      } catch {
        /* never let audio synthesis affect the already-delivered reply */
      }
    }
  } catch (err) {
    console.error("[api/chat] Error during generation:", err);
    const msg = err?.message || String(err);
    if (
      err instanceof OllamaUnavailableError ||
      err?.name === "OllamaUnavailableError" ||
      msg.includes("Could not reach Ollama")
    ) {
      send({
        type: "error",
        message:
          "Can't reach Ollama. Make sure it's running (launch the Ollama app, " +
          "or run `ollama serve` in another terminal) and that the model is " +
          "pulled (`ollama pull gemma3:4b`), then try again.",
      });
    } else if (msg.includes("Ollama returned")) {
      send({
        type: "error",
        message:
          `Ollama error (${msg}). If Gemma 3 was cold-loading into GPU VRAM, ` +
          "please wait a moment and send your message again.",
      });
    } else {
      send({
        type: "error",
        message: `Something went wrong generating the reply (${msg}). Please try again.`,
      });
    }
  } finally {
    res.end();
  }

  // Persist the completed exchange verbatim, tagged with active persona & RBAC metadata
  // (fails soft; happens after the response is already sent to the client).
  // In 1-on-1 mode, visibility is strictly "private" to active persona to prevent telepathy.
  const finalReply = filter.text();
  if (completed && query && finalReply) {
    await store({
      personaId: persona.id,
      personaName: persona.displayName,
      userMessage: query,
      reply: finalReply,
      visibility: isAutoRoute ? "public" : "private",
      target: persona.id,
      source: "user",
      memoryType: "raw_turn",
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

  // Start background sleep cycle idle monitor
  idleDetector.start();

  // Warm ONE voice in the BACKGROUND after the port is open.
  prewarm(DEFAULT_PERSONA_ID);

  // Pre-warm and pin Gemma 3 in GPU VRAM in the BACKGROUND (non-blocking).
  prewarmOllama();
});
