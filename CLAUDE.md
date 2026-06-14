\# My Council



\## Vision

A local-first desktop AI companion app where six anime/gaming character personas live on the user's desktop, share a unified persistent memory, are aware of each other, and offer different perspectives on the user's life. Each persona has a distinct personality, voice, and visual design, and remembers everything across sessions. Built for personal use — not commercial. The point is companionship and perspective, not productivity (productivity may come much later).



\## Naming

\- App name: \*\*My Council\*\*

\- Inside the app, the six personas are collectively "the Council" — e.g. "ask the Council," "what does the Council think"

\- Name was chosen to be open-ended so personas can be added/swapped later without the name breaking (rejected "Hexad" for locking in at six)

\- Repo: `my-council` (public)



\## The Six Personas

1\. \*\*Kratos\*\* (God of War) — brutal warrior, gruff, direct, carries deep trauma, speaks plainly and sparingly

2\. \*\*Dante\*\* (Devil May Cry) — cocky fighter, witty, playful, sarcastic, keeps things light even when serious

3\. \*\*Vergil\*\* (Devil May Cry) — cold strategist, ambitious, calculating, controlled, values power and discipline

4\. \*\*Jiraiya\*\* (Naruto) — wise mentor, philosophical, patient, roguish, offers perspective and guidance

5\. \*\*Naruto\*\* (Naruto) — optimistic, determined, never gives up, believes in people, brings energy and encouragement

6\. \*\*Anya\*\* (Spy x Family) — playful caretaker, curious, innocent, warm, genuinely wants to help



> Personas are swappable later — the architecture treats them as configurable slots, not hardcoded. Known watch-item: Kratos and Vergil both occupy a "cold/serious/burdened" register and may feel too similar in practice; candidate replacements if needed include Sephiroth, Aizen, or Itachi. Dante and Vergil being from the same universe is fine — their personalities are opposites.



\## Core Behavior Rules

\- All six personas SHARE one unified memory pool — what the user tells one, the others can know

\- Each persona is AWARE the other five exist and may reference them (e.g. "Naruto would tell you to push on, but I say rest")

\- This creates an "ensemble / council of voices" feel, not six isolated chatbots

\- Each persona stays fully in character — voice, tone, worldview, quirks drawn from source material

\- On launch, ONE persona loads (random by default) and appears as a desktop avatar

\- Personas reference past conversations naturally to create continuity across days



\## Runtime Flow

1\. App launches → one persona selected (random) → avatar appears in a corner of the desktop

2\. User sends message (text first; voice later)

3\. App retrieves relevant past context from memory (MemPalace, semantic search — not full history)

4\. Message + persona system prompt + persona-awareness + retrieved memory → local LLM (Gemma 3 4B via Ollama)

5\. LLM generates in-character response

6\. Response displayed (and later spoken via local TTS)

7\. Exchange stored back into memory (verbatim)

8\. Next launch: different persona, same shared memory



\## Tech Stack

\- \*\*Local LLM:\*\* Gemma 3 4B via Ollama — daily workhorse, free, runs offline

&#x20; - Model stored on `D:\\OllamaModels`, 8k context length

\- \*\*Memory:\*\* MemPalace (local, semantic search, verbatim storage; ChromaDB + PyYAML)

\- \*\*TTS (Phase 2):\*\* Piper or Coqui — local, free, voices matched per persona

\- \*\*Frontend:\*\* React (avatar UI / desktop widget); Electron for desktop presence (TBD)

\- \*\*Backend:\*\* Node.js

\- \*\*DB / store:\*\* SQLite + local vector store for conversation persistence

\- \*\*Version control:\*\* Git + GitHub (public repo: `my-council`)

\- \*\*No MCP\*\* in MVP — not needed for local-only build



\## Design Decisions \& Rationale (the \*why\*)



\### Local-first, build everything locally before any cloud

Start with Gemma running entirely on the machine — zero token cost, full privacy, no rate limits. Only add cloud APIs later, and only if local quality proves insufficient. This lets the user learn what's actually missing from real use instead of guessing.



\### Memory: verbatim storage + semantic retrieval (not summarization)

MemPalace stores conversations verbatim and retrieves only the semantically relevant chunks per message. This is the key cost/quality lever: it gives effectively unlimited long-term memory WITHOUT needing a large context window. That's why 8k context is fine — long-term memory lives in MemPalace, not in the context window. This also matters if cloud APIs are ever added: retrieving only relevant chunks keeps token usage (and cost) low instead of replaying full history every call.



\### Shared memory + inter-persona awareness is the differentiator

Closest existing projects: Mimir's Memory Hub (multi-character, but SEPARATE memory per character), Open-LLM-VTuber (avatar + memory, single-character focus), PersonAi (multi-persona, no shared memory layer). My Council's unique combination = one shared memory pool across all personas + personas aware of each other + desktop avatar presence. Study those repos for architecture patterns, but the shared-memory-with-awareness design is the original part.



\### Hybrid cloud strategy (Phase 2, optional)

If/when cloud is added, the intended tiering:

\- Gemma 3 4B (local) handles the bulk of daily conversation — free

\- Gemini free tier as a no-cost quality booster when local falls short (note: Gemini Pro web subscription does NOT include API; only the separate free API tier does)

\- Claude API only for rare deep/complex moments — pay-per-token, used sparingly

\- Open question the user is leaning toward: possibly drop Claude entirely to avoid any spend, running local + Gemini free only. Decide after living with local-only.

\- Cost note that drove this: full Sonnet replaying history daily for a 30-min chat would run \~$30–60/mo (over budget); hybrid keeps it near-free.



\### Per-persona model assignment (future idea)

Eventually each persona could map to a different model tier matching their character — a "wiser" persona gets a stronger model, a "simpler/goofier" one gets a lighter/cheaper model. Optimizes both experience and cost. Parked for later; not in MVP.



\### Avatars

\- Keep original character designs, authentic to source material, anime style

\- Avatar sits in a corner of the desktop (pixelated or anime style both acceptable)

\- Start static or minimal idle animation; richer talking-sync animation is Phase 2

\- Don't over-invest in animation before the core chat + memory loop works



\### Voices

\- Free local TTS only (no paid voice services, no licensing of real VA voices)

\- Match each persona's vibe as closely as possible via voice selection + pitch/speed tweaks (e.g. deep/gravelly for Kratos, lighter/younger for Anya)

\- Accepted tradeoff: not the authentic voice-actor voices, but character-appropriate and free



\## Target Hardware (dev + runtime machine)

\- ASUS laptop, Windows 11 Home, PowerShell

\- CPU: Intel i7-9750H (6 cores / 12 threads)

\- RAM: 16GB

\- GPU: NVIDIA GTX 1650, 4GB VRAM — \*\*the binding constraint\*\*; model must fit in \~4GB or it spills to CPU/RAM and slows down. This is why Gemma 3 4B (Q4, \~2.5–3GB) is the chosen size and 8k (not larger) context is used.

\- Storage: C: \~34GB free (avoid — SSD, tight); D: \~530GB free (use for models, repo, node\_modules)

\- Expectation: responses stream at a readable pace, not instant. Fine for conversation. Drop to a \~1B model only if 4B feels too slow.



\## Development Environment

\- VS Code with Claude Code on Windows / PowerShell

\- All build guidance assumes this setup

\- Note: Ollama's "Launch Claude Code" feature points Claude Code at a LOCAL model — do NOT use it for building. Build with real Claude Code (cloud Claude) for code quality; Gemma is only the app's runtime brain, never the code-writing brain.



\## MVP Scope (build in this order)

1\. Project scaffolding

2\. \*\*START HERE:\*\* single persona chatting end-to-end through Ollama (text only)

3\. Persona system prompts for all six

4\. MemPalace integration (shared memory + retrieval)

5\. Persona switching

6\. Desktop avatar rendering (static → minimal idle animation)

7\. Local TTS per persona



\## Phase 2 (later)

\- Richer avatar animations, talking sync

\- Voice input / wake word

\- Mood tracking across personas

\- Multi-persona group conversations

\- Optional cloud tier (Gemini free / Claude) per hybrid strategy above

\- Per-persona model assignment

\- Persona customization UI



\## Estimated Effort

Medium complexity. Core building blocks already exist (Ollama, MemPalace, local TTS, React). Main work is wiring them together + avatar UI + shared-memory/awareness logic. Rough estimate: \~2–3 weeks focused for a solid MVP (chat, memory, persona switching, basic animation), then \~1 month of polish and consistency tuning.



\## Explicitly NOT doing yet

\- No MCP (not needed for local MVP)

\- No cloud APIs in MVP — fully local first

\- No productivity/task features yet — companion experience first

