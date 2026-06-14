# My Council

A local-first desktop AI companion app. Six anime/gaming character personas —
collectively **the Council** — share one memory and offer different perspectives
on your life. Everything runs locally: no cloud, no token cost.

See [`CLAUDE.md`](./CLAUDE.md) for the full vision, personas, and architecture.

## Status — MVP step 3

Persistent, shared, long-term memory now works. Close everything, reopen
tomorrow, and any persona can recall relevant things from past conversations
with **any** persona. Voice and avatars come in later steps.

What works now:

- Node.js + Express backend, streaming replies from local Ollama (`gemma3:4b`)
- Plain HTML/CSS/JS chat UI — no React/Electron/build step
- All six personas — Kratos, Dante, Vergil, Jiraiya, Naruto, Anya — each in
  character and aware it is one of the Council
- Header persona picker; switching keeps one continuous, correctly-attributed
  transcript (only the active persona ever occupies the assistant role)
- **Shared long-term memory** across sessions via local ChromaDB: each exchange
  is stored verbatim, tagged with the active persona + timestamp; each new turn
  semantically retrieves only the most relevant past entries and injects them as
  attributed reference context (so a persona can recall and reference what you
  told another persona, without imitating that persona's voice)
- **Graceful degradation:** if the memory service is down, chat still works in
  the current session and the UI says memory is unavailable — it never crashes

## Project structure

```
my-council/
├── start-all.ps1          # launch both services (memory + app) in one go
├── server/
│   ├── index.js           # Express server: serves the UI + POST /api/chat
│   ├── config.js          # Node-side config (Ollama, port, memory URL)
│   ├── ollama.js          # Ollama client: streams /api/chat responses
│   ├── context.js         # builds the prompt (attribution + memory injection)
│   ├── memory.js          # Node client for the memory service (fails soft)
│   └── personas/          # one character sheet per persona + registry
├── memory-service/        # Python: local ChromaDB wrapper (the memory engine)
│   ├── app.py             # FastAPI: /store, /retrieve, /health
│   ├── config.py          # Python-side config (N, data path, port, model)
│   ├── requirements.txt   # pinned deps (ChromaDB etc.)
│   └── chroma-data/        # persisted memory (created at runtime; gitignored)
└── public/                # chat UI (index.html, styles.css, app.js)
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

### Useful variants

```powershell
npm run dev                 # auto-restart the app on file changes
$env:MEMORY_ENABLED="false"; npm start   # run the app with memory off
```

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

| Setting        | Env var          | Default                  |
| -------------- | ---------------- | ------------------------ |
| Server port    | `PORT`           | `3000`                   |
| Ollama URL     | `OLLAMA_URL`     | `http://localhost:11434` |
| Ollama model   | `OLLAMA_MODEL`   | `gemma3:4b`              |
| Memory URL     | `MEMORY_URL`     | `http://127.0.0.1:8000`  |
| Memory on/off  | `MEMORY_ENABLED` | `true`                   |

**Python side** — [`memory-service/config.py`](./memory-service/config.py):
retrieval breadth **N** (`DEFAULT_TOP_N`, default 4), data path, collection
name, embedding model, host/port. The ChromaDB version is pinned in
[`requirements.txt`](./memory-service/requirements.txt).

> **"Long-term memory is unavailable" notice in the chat?** The app is running
> but the memory service isn't. Start it (`.\start-all.ps1`, or run `app.py`
> manually) and send your message again. Chat keeps working without it.
