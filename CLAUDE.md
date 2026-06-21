# My Council

## Vision

A local-first desktop AI companion app where six anime/gaming character personas live on the user's desktop, share a unified persistent memory, are aware of each other, and offer different perspectives on the user's life. Each persona has a distinct personality, voice, and visual design, and remembers everything across sessions. Built for personal use — not commercial. The point is companionship and perspective, not productivity (productivity may come much later).

## Naming

- App name: **My Council**
- Inside the app, the six personas are collectively "the Council" — e.g. "ask the Council," "what does the Council think"
- Name was chosen to be open-ended so personas can be added/swapped later without the name breaking (rejected "Hexad" for locking in at six)
- Repo: `my-council` (public)

## The Six Personas

1. **Kratos** (God of War) — brutal warrior, gruff, direct, carries deep trauma, speaks plainly and sparingly
2. **Dante** (Devil May Cry) — cocky fighter, witty, playful, sarcastic, keeps things light even when serious
3. **Vergil** (Devil May Cry) — cold strategist, ambitious, calculating, controlled, values power and discipline
4. **Jiraiya** (Naruto) — wise mentor, philosophical, patient, roguish, offers perspective and guidance
5. **Naruto** (Naruto) — optimistic, determined, never gives up, believes in people, brings energy and encouragement
6. **Anya** (Spy x Family) — playful caretaker, curious, innocent, warm, genuinely wants to help

> Personas are swappable later — the architecture treats them as configurable slots, not hardcoded. Known watch-item: Kratos and Vergil both occupy a "cold/serious/burdened" register and may feel too similar in practice; candidate replacements if needed include Sephiroth, Aizen, or Itachi. Dante and Vergil being from the same universe is fine — their personalities are opposites.

## Core Behavior Rules

- All six personas SHARE one unified memory pool — what the user tells one, the others can know
- Each persona is AWARE the other five exist and may reference them (e.g. "Naruto would tell you to push on, but I say rest")
- This creates an "ensemble / council of voices" feel, not six isolated chatbots
- Each persona stays fully in character — voice, tone, worldview, quirks drawn from source material
- Each launch loads ONE persona (random by default) that appears as a desktop avatar
- Personas reference past conversations naturally to create continuity across days

## Voice-First Prompt Constraints (Voice Companion Ready)

To support Text-to-Speech (TTS) integration, the system prompts and context injection follow strict voice constraints to prevent the local LLM from generating unspokable text:
1. **Dialogue Only:** Personas must output *only* spoken dialogue. No physical actions, stage directions, or internal thoughts.
2. **No Narration:** No first-person narration (e.g. no "I laughed", "I took a drink").
3. **No Formatting Characters:** No quotation marks (") or asterisks (*) are allowed in the persona output. They must speak directly.
4. **Snappy Replies:** Replies are constrained to 1-3 sentences maximum (ideal for voice widgets).
5. **Memory Retrieval Safeguards:**
   - **Greeting Filter:** Generic greetings (e.g. "hi", "hey", "sup") are filtered out of memory retrieval entirely to prevent irrelevant past memories from loading into the context.
   - **Semantic Distance Threshold:** A cosine similarity threshold of `0.7` is enforced in `server/memory.js`. Any retrieved memory with a distance higher than `0.7` is dropped as semantically unrelated.
   - **Database-Style Context Injection:** Memories are injected as structured dry logs (e.g. `[DATABASE MEMORY LOGS - User to Kratos: "..."]`), explicitly instructing the LLM to treat them as background facts and never to blurt them out unprompted.
6. **Context Isolation (Conversation Isolation):**
   - Active chat logs sent to the LLM are isolated: the assistant history **only** contains turns between the user and the active persona.
   - User turns addressed to other personas are formatted as a dry background block (`[OBSERVED HISTORY]`) at the top of the prompt.
   - This completely stops semantic leakage (e.g., Naruto answering queries addressed to Kratos) while retaining shared awareness.
7. **Character Reference Constraints:**
   - Personas must not mention other members unless the user explicitly brings them up first, preventing random hyper-fixation.

## Runtime Flow

1. App launches → one persona selected (random) → avatar appears in a corner of the desktop
2. User sends message (text first; voice later)
3. App retrieves relevant past context from the shared memory (ChromaDB, semantic search — not full history)
4. Message + persona system prompt + persona-awareness + retrieved memory → local LLM (Gemma 3 4B via Ollama)
5. LLM generates in-character response
6. Response displayed (and later spoken via local TTS)
7. Exchange stored back into memory (verbatim)
8. Next launch: different persona, same shared memory

## Tech Stack

- **Local LLM:** Gemma 3 4B via Ollama — daily workhorse, free, runs offline
  - Model stored on `D:\OllamaModels`, run at 4k context length (see VRAM note under Target Hardware)
- **Cloud LLM (optional):** Google Gemini free tier, reached only via the manual `/deep` trigger; one turn at a time, with automatic fallback to local Gemma. Key read from env / a gitignored `.env` only (see Hybrid cloud strategy).
- **Memory:** Local ChromaDB — verbatim storage + semantic retrieval — wrapped by a small local FastAPI service the Node app calls over localhost (see the "Memory engine" decision below). *Not* MemPalace.
- **TTS:** **Piper** (chosen over Coqui) — local, free, a voice matched per persona, optional ffmpeg pitch-shift. **Implemented** (`server/tts.js`); fails soft to text-only.
- **STT (voice input):** **faster-whisper** — local, free, CPU/int8, its own FastAPI service (`stt-service/`, port 8001). **Implemented**; browser mic → `POST /api/transcribe` → proxy (`server/stt.js`), fails soft.
- **Frontend:** Plain HTML/CSS/JS served by Express — no React, no build step. The avatar UI + chat widget are hand-written (React was dropped as unnecessary overhead for a single-window local app).
- **Desktop shell:** Electron (`main.js`) — **implemented** (was TBD). A frameless, transparent, always-on-top window renders the active persona as a draggable desktop companion. It starts the Express server in-process if its port is free, or hooks an already-running one.
- **Backend:** Node.js
- **DB / store:** SQLite + local vector store for conversation persistence (provided by ChromaDB)
- **Version control:** Git + GitHub (public repo: `my-council`)
- **No MCP** in MVP — not needed for local-only build

## Design Decisions & Rationale (the *why*)

### Local-first, build everything locally before any cloud

Start with Gemma running entirely on the machine — zero token cost, full privacy, no rate limits. Only add cloud APIs later, and only if local quality proves insufficient. This lets the user learn what's actually missing from real use instead of guessing.

### Memory: verbatim storage + semantic retrieval (not summarization)

The memory layer stores conversations verbatim and retrieves only the semantically relevant chunks per message. This is the key cost/quality lever: it gives effectively unlimited long-term memory WITHOUT needing a large context window. That's why a small context is fine (we run 4k to keep the 4B model + KV cache within the GTX 1650's 4GB VRAM) — long-term memory lives in the vector store, not in the context window. This also matters if cloud APIs are ever added: retrieving only relevant chunks keeps token usage (and cost) low instead of replaying full history every call.

### Memory engine: ChromaDB directly, not MemPalace (decided)

CLAUDE.md originally named MemPalace. After evaluation we build directly on **ChromaDB** instead. Reasons: (1) MemPalace is designed primarily as an MCP tool for AI clients, not a library to embed inside an app like this; (2) it currently has a critical write-flush bug on recent ChromaDB versions; (3) it is effectively a thin wrapper around ChromaDB, which is what it uses under the hood anyway. The memory *design* from CLAUDE.md is unchanged (one shared pool, verbatim storage, semantic retrieval, persona+timestamp tags) — only the underlying library differs.

Implementation: a small local **Python FastAPI service** (`memory-service/`) wraps a ChromaDB `PersistentClient` and exposes `POST /store`, `POST /retrieve`, `GET /health`. The Node/Express app calls it over localhost (chosen over per-call Python subprocesses so the embedding model + DB client load once, and over Chroma's own server to keep embeddings local in Python). Embeddings use the local all-MiniLM-L6-v2 (ONNX, CPU) — no cloud, and the GPU stays free for Gemma. ChromaDB is pinned to **1.5.9** (its Rust core ships prebuilt Windows wheels — no C++ build tools, unlike the 0.5.x line that needs `chroma-hnswlib`), and persistence is verified by a restart test. Runs on a dedicated **Python 3.12 venv** (the machine's Python 3.14 is too new for ChromaDB's native deps to have prebuilt Windows wheels).

Critical reuse: retrieved memories from other personas are injected as *attributed reference context* (e.g. `In an earlier session, Kratos said: "…"`), never in the assistant role — the same rule that fixed in-session voice-bleed (`server/context.js`), so the memory layer cannot reintroduce that bug.

### Shared memory + inter-persona awareness is the differentiator

Closest existing projects: Mimir's Memory Hub (multi-character, but SEPARATE memory per character), Open-LLM-VTuber (avatar + memory, single-character focus), PersonAi (multi-persona, no shared memory layer). My Council's unique combination = one shared memory pool across all personas + personas aware of each other + desktop avatar presence. Study those repos for architecture patterns, but the shared-memory-with-awareness design is the original part.

### Hybrid cloud strategy (first slice implemented)

The intended tiering:

- Gemma 3 4B (local) handles the bulk of daily conversation — free
- Gemini free tier as a no-cost quality booster when local falls short (note: Gemini Pro web subscription does NOT include API; only the separate free API tier does)
- Claude API only for rare deep/complex moments — pay-per-token, used sparingly
- Open question the user is leaning toward: possibly drop Claude entirely to avoid any spend, running local + Gemini free only. Decide after living with local-only.
- Cost note that drove this: full Sonnet replaying history daily for a 30-min chat would run ~$30–60/mo (over budget); hybrid keeps it near-free.

**Status (implemented):** a manual **`/deep`** trigger now routes a single turn to the Gemini free tier (`server/cloud.js`), with automatic fallback to local Gemma on *any* failure (no key, rate limit, network, auth). Same persona, same memory, same voice rules — only the model behind that one reply is stronger, and the exchange is stored to memory like any other. Security posture: the key is read only from env / a gitignored `.env`, sent only to Google's official HTTPS endpoint via a request header, and never logged, returned, or shown in the UI. Claude is **not** wired in yet (leaning toward local + Gemini-free only). Still manual-only — auto-routing when local quality is low is a future step. See README → "Hybrid cloud — `/deep`".

### Per-persona model assignment (future idea)

Eventually each persona could map to a different model tier matching their character — a "wiser" persona gets a stronger model, a "simpler/goofier" one gets a lighter/cheaper model. Optimizes both experience and cost. Parked for later; not in MVP.

### Avatars

- Keep original character designs, authentic to source material, anime style
- Avatar sits in a corner of the desktop (pixelated or anime style both acceptable)
- Start static or minimal idle animation; richer talking-sync animation is Phase 2
- Don't over-invest in animation before the core chat + memory loop works
- **Status (implemented):** per-persona portraits (`public/avatars/<id>.png`) render in the Electron widget via `public/avatar.js` (`AvatarManager`). They fade-swap on persona switch and pulse while a reply is generating — with a distinct pulse for `/deep` cloud turns. The window is frameless/transparent/always-on-top, the avatar is drag-to-move, and 💬 collapses/expands the chat panel.
- **Status (implemented — animated states):** `AvatarManager` now swaps to per-persona animated GIFs by state: `<id>-thinking.gif` while a reply is generating, `<id>-talking.gif` while TTS audio is playing, falling back to the static `<id>.png` when idle. It also supports explicit emotion poses (`<id>-<emotion>.gif`) via `setEmotion()`. Each load preloads in memory (no white flash) and cascades to the next-best asset if a GIF is missing, so a persona with only a base PNG still works. Finer lip-sync remains Phase 2.

### Voices

- Free local TTS only (no paid voice services, no licensing of real VA voices)
- Match each persona's vibe as closely as possible via voice selection + pitch/speed tweaks (e.g. deep/gravelly for Kratos, lighter/younger for Anya)
- Accepted tradeoff: not the authentic voice-actor voices, but character-appropriate and free
- **Status (implemented):** local **Piper** TTS speaks each reply (`server/tts.js`), with a per-persona voice map in `server/config.js` (`tts.voices`) tuning `length_scale`, `noise_scale`/`noise_w`, and `pitch`. Pitch shifting uses optional ffmpeg as a post-pass. Everything fails soft — no `piper.exe`/voices or no ffmpeg just degrades to text or un-shifted audio, never an error. Synthesis is CPU-side so the GPU stays free for Gemma. The client queues and plays clips via `public/voice.js`, which also drives the talking-state avatar swap. See README → "Local TTS — Piper".

### Voice input (STT — implemented)

- The mirror of TTS: a local **faster-whisper** service (`stt-service/`, port 8001, CPU/int8) transcribes microphone audio. The browser records via `MediaRecorder` (`public/mic.js`), uploads to the Node app (`POST /api/transcribe`), which proxies to the Python service through `server/stt.js` — the browser never hits Python directly, mirroring the memory path.
- UX is a mic toggle with **silence detection** and continuous (always-on) listening: it auto-stops after a silence window, transcribes, submits the turn, and resumes listening when the persona finishes speaking. It coordinates with `voice.js`/`app.js` so it never records while the AI is generating or speaking. Fails soft end-to-end (denied mic, empty/short audio, or a down service just shows a notice; chat is unaffected).
- This advances the Phase 2 "Voice input / wake word" item (voice input done; wake word still future).

## Target Hardware (dev + runtime machine)

- ASUS laptop, Windows 11 Home, PowerShell
- CPU: Intel i7-9750H (6 cores / 12 threads)
- RAM: 16GB
- GPU: NVIDIA GTX 1650, 4GB VRAM — **the binding constraint**; model must fit in ~4GB or it spills to CPU/RAM and slows down. This is why Gemma 3 4B (Q4, ~2.5–3GB) is the chosen size and a 4k (not larger) context is used.
- Storage: C: ~34GB free (avoid — SSD, tight); D: ~530GB free (use for models, repo, node_modules)
- Expectation: responses stream at a readable pace, not instant. Fine for conversation. Drop to a ~1B model only if 4B feels too slow.

## Development Environment

- VS Code with Claude Code on Windows / PowerShell
- All build guidance assumes this setup
- Note: Ollama's "Launch Claude Code" feature points Claude Code at a LOCAL model — do NOT use it for building. Build with real Claude Code (cloud Claude) for code quality; Gemma is only the app's runtime brain, never the code-writing brain.

## MVP Scope (build in this order)

All seven MVP steps are done — the local chat + shared-memory loop, the desktop widget, and local TTS all ship. Voice input (STT) and animated avatar states, originally Phase 2, also landed early (see below).

1. ✅ Project scaffolding
2. ✅ Single persona chatting end-to-end through Ollama (text only)
3. ✅ Persona system prompts for all six
4. ✅ Shared memory integration (ChromaDB — shared pool + retrieval; see "Memory engine" decision)
5. ✅ Persona switching
6. ✅ Desktop avatar rendering — static portraits + minimal idle/talking pulse, in an Electron widget
7. ✅ Local TTS per persona — Piper, per-persona voices + ffmpeg pitch (see "Voices" above)

## Phase 2 (later)

- Richer avatar animations, talking sync — **partially done:** per-state thinking/talking GIFs and emotion poses ship (see "Avatars" above); finer lip-sync still open
- Voice input / wake word — **voice input done** (local faster-whisper STT + mic toggle with silence detection; see "Voice input" above); wake word still open
- Mood tracking across personas
- Multi-persona group conversations
- Optional cloud tier — **first slice done:** manual `/deep` → Gemini free tier (see Hybrid cloud strategy above). Still open: a Claude tier, and auto-routing instead of the manual trigger
- Per-persona model assignment
- Persona customization UI

## Estimated Effort

Medium complexity. Core building blocks already exist (Ollama, ChromaDB, local TTS, Electron). Main work is wiring them together + avatar UI + shared-memory/awareness logic. Rough estimate: ~2–3 weeks focused for a solid MVP (chat, memory, persona switching, basic animation), then ~1 month of polish and consistency tuning.

## Explicitly NOT doing yet

- No MCP (not needed for local MVP)
- No productivity/task features yet — companion experience first

> Note: "fully local first" held — local chat + shared memory shipped before any cloud was wired. Cloud is now an *optional opt-in* layer (manual `/deep` → Gemini free), never a dependency: with no key set, the app runs 100% local.
