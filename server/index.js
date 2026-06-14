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

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "..", "public");

const app = express();
app.use(express.json());
app.use(express.static(publicDir));

// List available personas (only Kratos for now). Handy for a future UI picker.
app.get("/api/personas", (req, res) => {
  res.json({ personas: listPersonas(), default: DEFAULT_PERSONA_ID });
});

// Build the Ollama message list from the running session log. The active
// persona's own turns are sent as-is; turns from other Council members are
// attributed by name (e.g. "[Vergil]: ...") so the active persona has context
// and can react to them while staying firmly in its own voice.
function buildOllamaMessages(persona, log) {
  const fromOthers = log.some(
    (m) => m.role === "assistant" && m.persona && m.persona !== persona.id
  );

  // Only add the attribution note when other members are actually present.
  let systemContent = persona.systemPrompt;
  if (fromOthers) {
    systemContent +=
      '\n\n[Shared Council session: replies marked like "[Vergil]: ..." are from ' +
      "other members, not you. Reply only as yourself, in your own voice, with no name marker.]";
  }

  const messages = [{ role: "system", content: systemContent }];

  for (const m of log) {
    if (m.role === "user") {
      messages.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      if (m.persona && m.persona !== persona.id) {
        const other = getPersona(m.persona);
        const name = other ? other.displayName : m.persona;
        messages.push({ role: "assistant", content: `[${name}]: ${m.content}` });
      } else {
        messages.push({ role: "assistant", content: m.content });
      }
    }
  }

  return messages;
}

// Streaming chat endpoint.
// Request body: { personaId?: string, messages: [{ role, content }, ...] }
// Response: Server-Sent Events, one JSON payload per `data:` frame:
//   { type: "token", value: "..." }  — a piece of the reply
//   { type: "done" }                 — the reply is complete
//   { type: "error", message: "..." }— something went wrong
app.post("/api/chat", async (req, res) => {
  const { personaId = DEFAULT_PERSONA_ID, messages } = req.body ?? {};

  const persona = getPersona(personaId);
  if (!persona) {
    return res.status(400).json({ error: `Unknown persona: ${personaId}` });
  }
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: "`messages` must be an array." });
  }

  // Build the message list for Ollama: the persona's character sheet plus the
  // running conversation, with other Council members' turns attributed by name.
  const fullMessages = buildOllamaMessages(persona, messages);

  // Open a Server-Sent Events stream to the browser.
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  try {
    for await (const token of streamChat(fullMessages)) {
      send({ type: "token", value: token });
    }
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
});

app.listen(config.port, () => {
  console.log("\nMy Council is running.");
  console.log(`  Open http://localhost:${config.port} in your browser.`);
  console.log(`  Talking to Ollama at ${config.ollama.baseUrl} (model: ${config.ollama.model}).`);
  console.log("  Press Ctrl+C to stop.\n");
});
