# My Council

A local-first desktop AI companion app. Six anime/gaming character personas —
collectively **the Council** — share one memory and offer different perspectives
on your life. Everything runs locally: no cloud, no token cost.

See [`CLAUDE.md`](./CLAUDE.md) for the full vision, personas, and architecture.

## Status — MVP step 6 (desktop widget)

The full local loop works: chat, shared cross-session memory, persona switching,
and a desktop avatar widget. Close everything, reopen tomorrow, and any persona
can recall relevant things from past conversations with **any** persona. Local
TTS (voice) is the one remaining MVP step.

What works now:

- Node.js + Express backend, streaming replies from local Ollama (`gemma3:4b`)
- Plain HTML/CSS/JS chat UI — no React, no build step (runs in a browser at
  `localhost:3000`, or in the Electron desktop widget below)
- **Desktop avatar widget (Electron):** a frameless, transparent, always-on-top
  window shows the active persona's portrait in a corner of the desktop. Drag the
  avatar to move it; click 💬 to collapse/expand the chat panel. The portrait
  fade-swaps when you switch personas and pulses while a reply is generating.
  Launch with `npm run start:widget` (see [below](#run-as-a-desktop-widget-electron)).
- All six personas — Kratos, Dante, Vergil, Jiraiya, Naruto, Anya — each in
  character and aware it is one of the Council
- Header persona picker; switching keeps one continuous, correctly-attributed
  transcript (only the active persona ever occupies the assistant role)
- **Shared long-term memory** across sessions via local ChromaDB: each exchange
  is stored verbatim, tagged with the active persona + timestamp; each new turn
  semantically retrieves only the most relevant past entries and injects them as
  attributed reference context (so a persona can recall and reference what you
  told another persona, without imitating that persona's voice)
- **Optional `/deep` cloud turn:** prefix a message with `/deep` to route just
  that turn to Google Gemini (free tier) instead of local Gemma — same persona,
  memory, and voice rules. Falls back to local automatically if unavailable; the
  reply is badged "Deep Mind" only when it genuinely came from the cloud. (See
  [Hybrid cloud — `/deep`](#hybrid-cloud--deep-optional).)
- **Graceful degradation:** if the memory service is down, chat still works in
  the current session and the UI says memory is unavailable — it never crashes

## Project structure

```
my-council/
├── start-all.ps1          # launch both services (memory + app) in one go
├── main.js                # Electron entry: frameless desktop widget (npm run start:widget)
├── server/
│   ├── index.js           # Express server: serves the UI + POST /api/chat
│   ├── config.js          # Node-side config (Ollama, port, memory, cloud)
│   ├── env.js             # loads a gitignored .env (zero-dependency)
│   ├── ollama.js          # Ollama client: streams /api/chat responses
│   ├── cloud.js           # Gemini client for /deep turns (key from env only)
│   ├── context.js         # builds the prompt (attribution + memory injection)
│   ├── memory.js          # Node client for the memory service (fails soft)
│   └── personas/          # one character sheet per persona + registry
├── memory-service/        # Python: local ChromaDB wrapper (the memory engine)
│   ├── app.py             # FastAPI: /store, /retrieve, /health
│   ├── config.py          # Python-side config (N, data path, port, model)
│   ├── requirements.txt   # pinned deps (ChromaDB etc.)
│   └── chroma-data/       # persisted memory (created at runtime; gitignored)
└── public/                # chat UI + desktop avatar
    ├── index.html
    ├── styles.css
    ├── app.js             # chat logic, SSE streaming, /deep handling
    ├── avatar.js          # AvatarManager: portrait swap + talking animation
    └── avatars/           # one PNG portrait per persona
```

## Prerequisites

- **Node.js 18+** (the backend uses the built-in `fetch`)
- **Ollama** running, with the model pulled:
  ```powershell
  ollama pull gemma3:4b
  ```
- **Python 3.12** for the memory service. The memory engine (ChromaDB) needs
  native packages that don't yet have prebuilt Windows wheels on very new
  Pythons (e.g. 3.14), so use 3.12 specifically. Install it once:
  ```powershell
  winget install -e --id Python.Python.3.12
  ```
  (Open a fresh terminal afterward so `py -3.12` is found.)

## One-time setup

```powershell
# From the repo root.

# 1. Node dependencies
npm install

# 2. Python 3.12 virtual environment for the memory service
py -3.12 -m venv .venv

# 3. Install the memory service's pinned dependencies into that venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r memory-service\requirements.txt
```

> If `.\.venv\Scripts\Activate.ps1` is ever blocked by execution policy, you do
> **not** need to activate — the commands above call the venv's `python.exe`
> directly. (To activate anyway: `Set-ExecutionPolicy -Scope Process RemoteSigned`.)

## Run it (Windows / PowerShell)

Make sure Ollama is running, then from the repo root:

```powershell
.\start-all.ps1
```

This opens two windows — the **memory service** (port 8000) and the **My Council
app** (port 3000). On first run the memory service downloads the embedding model
(~80 MB, one time), so give it a few seconds. Then open:

```
http://localhost:3000
```

### Running the two services manually (instead of start-all)

```powershell
# Terminal 1 — memory service
.\.venv\Scripts\python.exe memory-service\app.py

# Terminal 2 — app
npm start
```

### Run as a desktop widget (Electron)

To run My Council as a frameless desktop companion instead of a browser tab:

```powershell
# 1. Start the memory service so personas remember across sessions:
.\.venv\Scripts\python.exe memory-service\app.py

# 2. In another terminal, launch the widget:
npm run start:widget
```

The widget (`main.js`) starts the Express app **in-process** if port 3000 is free,
or hooks onto an already-running one — so it coexists with `start-all.ps1`. It
opens a transparent, always-on-top window: drag the avatar to reposition it, and
click 💬 to collapse or expand the chat. Electron is a dev dependency, so run
`npm install` once first to fetch it.

### Useful variants

```powershell
npm run dev                 # auto-restart the app on file changes
$env:MEMORY_ENABLED="false"; npm start   # run the app with memory off
```

## Hybrid cloud — `/deep` (optional)

Local Gemma handles every message by default. For a moment that needs more depth,
prefix your message with **`/deep`** and that one turn is routed to Google
**Gemini** (free tier) instead — same persona, same memory, same voice rules;
only the model behind the reply is stronger. Everything else stays local.

It is fully optional and **degrades gracefully**: if no key is set (or the cloud
call fails for any reason — rate limit, network, auth), the turn falls back to
local Gemma and the chat shows a short notice. Normal local chat never depends on
it and never crashes if it's missing.

### Set your Gemini API key (PowerShell)

Get a free key at <https://aistudio.google.com/apikey>, then pick one option.

**Option A — a local `.env` file (recommended; gitignored):**

```powershell
Copy-Item .env.example .env
# then edit .env and set:  GEMINI_API_KEY=your-key-here
```

**Option B — an environment variable:**

```powershell
# this PowerShell session only:
$env:GEMINI_API_KEY = "your-key-here"

# OR persist it for your user (reopen the terminal afterwards):
setx GEMINI_API_KEY "your-key-here"
```

> **Security.** The key is read only from the environment / `.env` (never
> hardcoded), is sent only to Google's official HTTPS endpoint via a request
> header, and is never logged, shown in the UI, or included in any error. `.env`
> and `.env.*` are gitignored; only `.env.example` (a placeholder) is committed.
> This repo is public — keep secrets out of it.

### Use it

Send a normal message for local Gemma, or start a message with `/deep`:

```
/deep What does it really mean to forgive someone who never apologised?
```

The `/deep` marker is stripped before the persona sees it, so a `/deep` message
to Kratos is still answered by **Kratos**, with the same memory and grounding.
The reply is stored to memory exactly like a local one. If cloud mode is
unavailable you'll get the local answer plus a one-line notice.

## Persistence test (prove memory survives a restart and is shared)

1. Start both services (`.\start-all.ps1`) and open http://localhost:3000.
2. With **Kratos** active, tell him something specific, e.g.
   *"My dog's name is Mochi and she just turned three."*
3. **Fully stop both services** (close both windows, or Ctrl+C in each).
4. Start both again (`.\start-all.ps1`), reload the page.
5. Switch to **Anya** and ask: *"Do you remember my dog?"*
6. Anya should recall **Mochi** and attribute it correctly — that you mentioned
   it to **Kratos** earlier — proving memory persisted across a full restart and
   is shared across personas.

You can also check the store directly:

```powershell
# entry count
Invoke-WebRequest http://127.0.0.1:8000/health -UseBasicParsing | Select-Object -Expand Content
```

## Configuration

**Node side** — [`server/config.js`](./server/config.js) (env-overridable):

| Setting        | Env var          | Default                       |
| -------------- | ---------------- | ----------------------------- |
| Server port    | `PORT`           | `3000`                        |
| Ollama URL     | `OLLAMA_URL`     | `http://localhost:11434`      |
| Ollama model   | `OLLAMA_MODEL`   | `gemma3:4b`                   |
| Memory URL     | `MEMORY_URL`     | `http://127.0.0.1:8000`       |
| Memory on/off  | `MEMORY_ENABLED` | `true`                        |
| Cloud on/off   | `CLOUD_ENABLED`  | `true`                        |
| Gemini model   | `GEMINI_MODEL`   | `gemini-1.5-flash`            |
| Gemini API key | `GEMINI_API_KEY` | _(unset — required for_ `/deep`_)_ |

> The Gemini API key is read **only** from the environment or a gitignored
> `.env` — never hardcoded, never stored in `config.js`. See
> [Hybrid cloud — `/deep`](#hybrid-cloud--deep-optional).

**Python side** — [`memory-service/config.py`](./memory-service/config.py):
retrieval breadth **N** (`DEFAULT_TOP_N`, default 4), data path, collection
name, embedding model, host/port. The ChromaDB version is pinned in
[`requirements.txt`](./memory-service/requirements.txt).

> **"Long-term memory is unavailable" notice in the chat?** The app is running
> but the memory service isn't. Start it (`.\start-all.ps1`, or run `app.py`
> manually) and send your message again. Chat keeps working without it.
