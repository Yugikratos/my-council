// My Council — frontend chat logic.
//
// The browser owns the conversation history (the server is stateless): we keep
// the full message list here and send it with every turn. The persona's reply
// streams back token by token over Server-Sent Events.

const PERSONA_ID = "kratos";

const chatEl = document.getElementById("chat");
const formEl = document.getElementById("composer");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send");
const personaNameEl = document.getElementById("persona-name");

// The conversation so far, in Ollama's message format. The system prompt is
// added server-side, so this holds only user/assistant turns.
const history = [];

// --- UI helpers -----------------------------------------------------------

// Add a message bubble and return its body element (so we can stream into it).
function addMessage(role, text = "") {
  const bubble = document.createElement("div");
  bubble.className = `msg ${role}`;

  if (role !== "error") {
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = role === "user" ? "You" : personaNameEl.textContent;
    bubble.appendChild(who);
  }

  const body = document.createElement("span");
  body.className = "body";
  body.textContent = text;
  bubble.appendChild(body);

  chatEl.appendChild(bubble);
  scrollToBottom();
  return body;
}

function scrollToBottom() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

function setBusy(busy) {
  sendBtn.disabled = busy;
  inputEl.disabled = busy;
  if (!busy) inputEl.focus();
}

// Replace a streaming bubble with an error message.
function showError(body, message) {
  const bubble = body.parentElement;
  bubble.className = "msg error";
  bubble.textContent = message;
  scrollToBottom();
}

// Auto-grow the textarea as you type.
inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
});

// Enter sends; Shift+Enter inserts a newline.
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    formEl.requestSubmit();
  }
});

// --- Chat flow ------------------------------------------------------------

formEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;

  // Show and record the user's message.
  addMessage("user", text);
  history.push({ role: "user", content: text });

  inputEl.value = "";
  inputEl.style.height = "auto";
  setBusy(true);

  // Placeholder bubble for the streaming reply, with a blinking caret.
  const replyBody = addMessage("persona", "");
  replyBody.parentElement.classList.add("cursor");

  let reply = "";
  let errored = false;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ personaId: PERSONA_ID, messages: history }),
    });

    if (!res.ok) {
      throw new Error(`Server error (${res.status}).`);
    }

    await readStream(res, (event) => {
      if (event.type === "token") {
        reply += event.value;
        replyBody.textContent = reply;
        scrollToBottom();
      } else if (event.type === "error") {
        errored = true;
        showError(replyBody, event.message);
      }
    });

    if (reply) {
      // Keep the reply in history so the conversation flows naturally.
      history.push({ role: "assistant", content: reply });
    } else if (!errored) {
      // Nothing came back and no error reported — drop the empty bubble.
      replyBody.parentElement.remove();
    }
  } catch (err) {
    showError(replyBody, err.message || "Could not reach the server.");
  } finally {
    // The caret class lives on the reply bubble; showError() may have already
    // replaced it, in which case parentElement is null and this is a no-op.
    replyBody.parentElement?.classList.remove("cursor");
    setBusy(false);
  }
});

// Read a Server-Sent Events stream (frames separated by a blank line, each line
// prefixed with "data:") and invoke onEvent for every JSON payload.
async function readStream(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    let sepIndex;
    while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sepIndex).trim();
      buffer = buffer.slice(sepIndex + 2);
      if (!frame.startsWith("data:")) continue;

      try {
        onEvent(JSON.parse(frame.slice(5).trim()));
      } catch {
        // Ignore a malformed frame rather than breaking the stream.
      }
    }
  }
}

inputEl.focus();
