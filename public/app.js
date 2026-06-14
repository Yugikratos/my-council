// My Council — frontend chat logic.
//
// The browser owns the conversation (the server is stateless): we keep the full
// session log here and send it with every turn. Switching personas keeps one
// continuous session — the transcript stays, and each speaker is recorded so the
// server can attribute the other Council members' turns to the active persona.

const chatEl = document.getElementById("chat");
const formEl = document.getElementById("composer");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send");
const rosterEl = document.getElementById("roster");

let personas = []; // [{ id, displayName }] from GET /api/personas
let activeId = null; // id of the currently selected persona

// The session log, in order. Each entry is one turn:
//   { role: "user", content }
//   { role: "assistant", content, persona }   // persona = who said it
const history = [];

function activePersona() {
  return personas.find((p) => p.id === activeId);
}

// --- Persona roster (header picker) ---------------------------------------

async function loadPersonas() {
  try {
    const res = await fetch("/api/personas");
    const data = await res.json();
    personas = data.personas;
    activeId = data.default ?? personas[0]?.id;
    renderRoster();
    if (window.avatarManager && activeId) {
      window.avatarManager.switchPersona(activeId);
    }
  } catch {
    // If this fails the server is down; the first send will surface the error.
  }
}

function renderRoster() {
  rosterEl.innerHTML = "";
  for (const p of personas) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "persona-btn" + (p.id === activeId ? " active" : "");
    btn.textContent = p.displayName;
    btn.setAttribute("aria-pressed", String(p.id === activeId));
    btn.addEventListener("click", () => switchPersona(p.id));
    rosterEl.appendChild(btn);
  }
}

function switchPersona(id) {
  if (id === activeId) return;
  activeId = id;
  renderRoster();
  // One continuous session: keep the transcript, just mark who's taking over.
  addDivider(activePersona().displayName);
  
  if (window.avatarManager) {
    window.avatarManager.switchPersona(id);
  }
  
  inputEl.focus();
}

// --- UI helpers -----------------------------------------------------------

// Add a message bubble and return its body element (so we can stream into it).
function addMessage(role, text = "", speaker = "") {
  const bubble = document.createElement("div");
  bubble.className = `msg ${role}`;

  if (role !== "error") {
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = role === "user" ? "You" : speaker;
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

// A light marker in the transcript showing which persona now holds the floor.
function addDivider(name) {
  const last = chatEl.lastElementChild;
  if (last && last.classList.contains("divider")) last.remove(); // collapse repeats
  const div = document.createElement("div");
  div.className = "divider";
  div.textContent = name;
  chatEl.appendChild(div);
  scrollToBottom();
}

function scrollToBottom() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

function setBusy(busy) {
  sendBtn.disabled = busy;
  inputEl.disabled = busy;
  rosterEl.querySelectorAll("button").forEach((b) => (b.disabled = busy));
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

  const persona = activePersona();
  if (!persona) return; // personas haven't loaded yet

  // Show and record the user's message.
  addMessage("user", text);
  history.push({ role: "user", content: text });

  inputEl.value = "";
  inputEl.style.height = "auto";
  setBusy(true);

  // Placeholder bubble for the streaming reply, labeled with the active persona.
  const replyBody = addMessage("persona", "", persona.displayName);
  replyBody.parentElement.classList.add("cursor");

  if (window.avatarManager) {
    window.avatarManager.setTalking(true);
  }

  let reply = "";
  let errored = false;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ personaId: persona.id, messages: history }),
    });

    if (!res.ok) {
      throw new Error(`Server error (${res.status}).`);
    }

    await readStream(res, (event) => {
      if (event.type === "token") {
        reply += event.value;
        replyBody.textContent = reply;
        scrollToBottom();
      } else if (event.type === "notice") {
        // Non-fatal info (e.g. memory unavailable) — show above the reply bubble.
        const n = document.createElement("div");
        n.className = "notice";
        n.textContent = event.message;
        chatEl.insertBefore(n, replyBody.parentElement);
        scrollToBottom();
      } else if (event.type === "error") {
        errored = true;
        showError(replyBody, event.message);
      }
    });

    if (reply) {
      // Record who said it so later personas see it attributed by name.
      history.push({ role: "assistant", content: reply, persona: persona.id });
    } else if (!errored) {
      // Nothing came back and no error reported — drop the empty bubble.
      replyBody.parentElement.remove();
    }
  } catch (err) {
    showError(replyBody, err.message || "Could not reach the server.");
  } finally {
    // showError() may have already replaced the bubble, in which case
    // parentElement is null and this is a no-op.
    replyBody.parentElement?.classList.remove("cursor");
    setBusy(false);
    
    if (window.avatarManager) {
      window.avatarManager.setTalking(false);
    }
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

// Boot: load the roster, then focus the input.
loadPersonas().finally(() => inputEl.focus());
