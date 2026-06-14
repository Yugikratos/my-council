// My Council — backend server.
// Serves the static chat UI and exposes a streaming chat endpoint. The server
// is stateless: the browser sends the full conversation each turn, and we wrap
// it with the active persona's system prompt before relaying it to Ollama.

import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { config } from "./config.js";
import { streamChat, OllamaUnavailableError } from "./ollama.js";
import { getPersona, listPersonas, DEFAULT_PERSONA_ID } from "./personas/index.js";
import { buildOllamaMessages } from "./context.js";
import { retrieve, store } from "./memory.js";

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
  const query = latestUser?.content ?? "";

  // Retrieve relevant memories from earlier sessions (fails soft).
  const { ok: memoryOk, memories } = await retrieve(query);

  // Build the message list for Ollama: the persona's character sheet, retrieved
  // long-term memories as attributed context, then the in-session conversation
  // (with other Council members' turns attributed by name).
  const fullMessages = buildOllamaMessages(persona, messages, memories);

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
  try {
    for await (const token of streamChat(fullMessages)) {
      // Clean token of asterisks, double quotes (straight and curly), and opening single curly quote.
      // We preserve apostrophes (') and closing single curly quotes (’) to keep English contractions intact.
      const cleanToken = token.replace(/[\*"“”‘]/g, "");
      reply += cleanToken;
      if (cleanToken) {
        send({ type: "token", value: cleanToken });
      }
    }
    completed = true;
    send({ type: "done" });
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
      send({
        type: "error",
        message: err.message || "Something went wrong talking to the model.",
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
