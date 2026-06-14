# My Council

A local-first desktop AI companion app. Six anime/gaming character personas —
collectively **the Council** — share one memory and offer different perspectives
on your life. Everything runs locally: no cloud, no token cost.

See [`CLAUDE.md`](./CLAUDE.md) for the full vision, personas, and architecture.

## Status — MVP step 1

This is the first build slice: **one persona (Kratos) chatting end-to-end
through your local Ollama model, with streaming replies.** Memory, voice,
avatars, persona switching, and the other five personas come in later steps.

What works now:

- Node.js + Express backend
- Connects to local Ollama (`/api/chat`) and streams tokens back live
- Plain HTML/CSS/JS chat UI — no React/Electron/build step
- Kratos persona (system prompt) wrapped around every message
- In-session conversation history, held in the browser (cleared on refresh)

## Project structure

```
my-council/
├── server/
│   ├── index.js          # Express server: serves the UI + POST /api/chat
│   ├── config.js         # Ollama URL, model, port — change settings here
│   ├── ollama.js         # Ollama client: streams /api/chat responses
│   └── personas/
│       ├── index.js      # persona registry (add new personas here)
│       └── kratos.js     # Kratos character sheet
└── public/
    ├── index.html        # chat UI
    ├── styles.css
    └── app.js            # frontend logic (streaming, history)
```

## Prerequisites

- **Node.js 18+** (the backend uses the built-in `fetch`)
- **Ollama** installed and running, with the model pulled:
  ```powershell
  ollama pull gemma3:4b
  ```
  Ollama serves at `http://localhost:11434` by default.

## Run it (Windows / PowerShell)

From the repo root:

```powershell
# 1. Install dependencies (first time only)
npm install

# 2. Start the app
npm start
```

Then open your browser to:

```
http://localhost:3000
```

You should see the **My Council** window with **Kratos** active. Type a message
and press **Enter** — his reply streams in word by word. The conversation stays
in context for the session; refreshing the page starts a fresh chat.

### Useful variants

```powershell
# Auto-restart the server on file changes while developing
npm run dev

# Use a different port (example: 4000)
$env:PORT=4000; npm start
```

> **"Can't reach Ollama" in the chat?** Start Ollama (launch the Ollama app, or
> run `ollama serve` in another terminal), make sure `gemma3:4b` is pulled, then
> send your message again.

## Configuration

Defaults live in [`server/config.js`](./server/config.js) and can be overridden
with environment variables:

| Setting      | Env var        | Default                  |
| ------------ | -------------- | ------------------------ |
| Server port  | `PORT`         | `3000`                   |
| Ollama URL   | `OLLAMA_URL`   | `http://localhost:11434` |
| Ollama model | `OLLAMA_MODEL` | `gemma3:4b`              |
