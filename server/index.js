// My Council — backend server.
// Serves the static chat UI and exposes a streaming chat endpoint. The server
// is stateless: the browser sends the full conversation each turn, and we wrap
// it with the active persona's system prompt before relaying it to Ollama.

import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { config } from "./config.js";
import { streamChat, OllamaUnavailableError } from "./ollama.js";
import { openCloudStream } from "./cloud.js";
import { getPersona, listPersonas, DEFAULT_PERSONA_ID } from "./personas/index.js";
import { buildOllamaMessages } from "./context.js";
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

// Streaming chat endpoint.
// Request body: { personaId?: string, messages: [{ role, content }, ...] }
// Response: Server-Sent Events, one JSON payload per `data:` frame:
//   { type: "token", value: "..." }  — a piece of the reply
//   { type: "done" }                 — the reply is complete
//   { type: "notice", message }      — non-fatal info (e.g. memory unavailable)
//   { type: "error", message: "..." }— something went wrong
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

  let reply = "";
  let completed = false;
  // Which model actually produced the reply, reported to the UI in the "done"
  // event (carries no sensitive data). Starts as the routed choice; flips to
  // "local" if the cloud call fails before any token and we fall back.
  let source = routeToCloud ? "cloud" : "local";
  let producedTokens = 0;

  // Clean each token of asterisks, double quotes (straight and curly), and the
  // opening single curly quote; preserve apostrophes (') and closing curly quote
  // (’) so English contractions survive. Same rule for both local and cloud.
  const pushToken = (token) => {
    const cleanToken = token.replace(/[\*"“”‘]/g, "");
    if (cleanToken) {
      reply += cleanToken;
      producedTokens++;
      send({ type: "token", value: cleanToken });
    }
  };

  try {
    if (routeToCloud) {
      try {
        const cloudStream = await openCloudStream(fullMessages);
        for await (const token of cloudStream) pushToken(token);
      } catch (cloudErr) {
        // If the cloud already streamed part of a reply, we can't cleanly restart
        // — let the outer handler report it. Otherwise fall back to local Gemma
        // for this turn so the user's message is never lost. The key never
        // appears in cloudErr (sanitized in cloud.js); log only a category.
        if (producedTokens > 0) throw cloudErr;
        console.warn(`[cloud] unavailable (${cloudErr?.code ?? "error"}); using local model`);
        send({
          type: "notice",
          message: "Deep mode (cloud) was unavailable — answered with the local model instead.",
        });
        source = "local";
        reply = "";
        for await (const token of streamChat(fullMessages)) pushToken(token);
      }
    } else {
      for await (const token of streamChat(fullMessages)) pushToken(token);
    }
    completed = true;
    send({ type: "done", source });
  } catch (err) {
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
  if (completed && query && reply) {
    await store({
      personaId: persona.id,
      personaName: persona.displayName,
      userMessage: query,
      reply,
    });
  }
});

app.listen(config.port, () => {
  console.log("\nMy Council is running.");
  console.log(`  Open http://localhost:${config.port} in your browser.`);
  console.log(`  Talking to Ollama at ${config.ollama.baseUrl} (model: ${config.ollama.model}).`);
  console.log(
    `  Long-term memory: ${config.memory.enabled ? config.memory.url : "disabled"}.`
  );
  console.log("  Press Ctrl+C to stop.\n");
});
