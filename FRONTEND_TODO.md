# Frontend agent — to-do (review of commit `0d719a6`)

Review findings on the voice-input + animated-avatar work. Ordered by priority.
All items are in `public/*` / `main.js` (frontend agent's lane).

## 🔴 Bug-risk — fix

### 1. `avatar.js` — guard against out-of-order image loads
`updateAvatarSrc()` runs on every state change and starts an async `new Image()`.
If states flip quickly (e.g. thinking → talking the instant TTS starts), an earlier
image's `onload` can land after the newer `src` was set and overwrite it with a
stale frame. Add a sequence token:
```js
// in updateAvatarSrc()
const token = ++this._loadToken;          // init this._loadToken = 0 in constructor
img.onload = () => { if (token === this._loadToken && this.avatarEl) this.avatarEl.src = fullSrc; };
// apply the same `token === this._loadToken` guard inside every onerror fallback branch
```

### 2. `mic.js` — cap recording length
The silence timer only arms after speech is detected and **resets on every frame
above `SPEECH_THRESHOLD`**. With constant noise/music, RMS never drops below
threshold, so it never auto-stops — the clip grows until it hits the server's
`express.raw({ limit: "25mb" })` (HTTP 413) or the 30s STT timeout. Add a hard
ceiling armed in `startListening()` and cleared in `stopRecording()`/`cleanup()`:
```js
this.maxDurationId = setTimeout(() => this.stopRecording(false), 45000);
```

## 🟡 Robustness / UX

### 3. Naming — it's voice-activation, not push-to-talk
`mic.js` is click-to-toggle + silence detection + auto-resume (its own header says
"Toggle-with-Silence-Detection"), not hold-to-talk PTT. Either keep the toggle
model and call it "voice activation," or implement true PTT. Docs were already
corrected on the backend side (README/CLAUDE.md/codebase_analysis.md) to
"voice activation (toggle + silence detection)" — code comments/labels should match.

### 4. `mic.js` — don't re-acquire the mic every cycle
`cleanupStream()` nulls `this.stream` and stops tracks after each recording, so
continuous mode calls `getUserMedia` again every turn (blinks the OS mic
indicator, adds latency). Keep the stream alive across an always-on session and
only release it on toggle-off. Also add a persistent "listening" indicator so the
user always knows the mic is hot.

### 5. `mic.js` — `stopRecording` inactive-recorder branch skips `checkResume()`
The `else` branch (recorder already inactive) goes straight to idle without
`checkResume()`, which can stall always-on listening. Add the call there too.

### 6. `mic.js` — calibrate the speech threshold
`SPEECH_THRESHOLD = 0.015` and `SILENCE_TIMEOUT = 7000` are hardcoded; mic gain
varies a lot per machine. Too-high threshold → speech never detected → ties into
#2 (records forever). Sample ~300ms of ambient noise on start and set threshold
relative to it (e.g. `noise * N`).

## 🟢 Polish / nits
- `styles.css`: `backdrop-filter: blur(16px)` is likely a no-op on a transparent
  Electron window (nothing composited behind it) — verify it adds anything, else
  drop it. The `rgba(...,0.85)` slab is doing the real work.
- `styles.css`: confirm `image-rendering: pixelated` on the downscaled portraits
  is the intended art direction (can look harsh) vs `auto`.
- `avatar.js`: short-circuit `updateAvatarSrc()` when `targetSrc` is unchanged, to
  avoid restarting a GIF animation on repeated same-state calls.
- `app.js`: reaches into mic internals (`micManager.isChatActive = true`, `.state`);
  a `micManager.notifyChatStart()` method would keep the contract clean.
- `mic.js`: `showNotice()` appends `.notice` divs to `#chat` that accumulate in the
  transcript and never clear.
- `main.js`: corner placement is good; clamp `x`/`y` to `>= 0` for small/scaled displays.

## Theme commits (`e9c50c6`, `46c9d25`) — review

### 7. 🔴 `app.js` — `className =` wipes the `collapsed` state (real bug)
`loadPersonas()` (line ~40) and `switchPersona()` (line ~72) set
`appEl.className = "app theme-" + id`, which **replaces the whole class list**.
But the chat collapse toggle lives on the same element (`app.js:361`
`appContainer.classList.toggle("collapsed")`, styled by `.app.collapsed`). So:
collapse the chat with 💬, then switch persona → the className reset drops
`collapsed` and the chat unexpectedly pops back open. Use `classList` instead:
```js
function applyTheme(id) {
  const appEl = document.querySelector(".app");
  if (!appEl) return;
  [...appEl.classList].forEach(c => { if (c.startsWith("theme-")) appEl.classList.remove(c); });
  appEl.classList.add(`theme-${id}`);
}
```
…and call `applyTheme(id)` from both spots (kills the duplication too).

### 8. 🔴 `styles.css` — Google Fonts `@import` breaks offline-first
```css
@import url('https://fonts.googleapis.com/css2?family=Cinzel...&family=VT323&display=swap');
```
This is a **network dependency in an app whose entire premise is local / offline /
no-cloud** (CLAUDE.md, README). It fails or flashes unstyled when offline, is
render-blocking, and leaks a request to Google's servers on every launch. Fix:
**self-host the fonts** — download the woff2 files into `public/fonts/` and
declare them with `@font-face` locally. No external fetch, no offline breakage.

### 9. 🟢 `styles.css` — `opacity: 0.92` on `.chat-container` dims the text too
Applying `opacity` to the whole container fades the messages/text, not just the
panel, and creates a stacking context. Prefer a panel color with built-in alpha
(e.g. keep `background: rgba(...)`) and drop the container-level `opacity`.

### 10. 🟢 `--persona-border` defined per theme but verify it's consumed
Each `.theme-*` sets `--persona-border`, but it doesn't appear wired to
`.msg.persona`'s border in the diff. Either use it (persona bubbles get the theme
accent border) or drop the unused variable.

## Cleanup
- `public/avatars/kratos_clean.png` was a scratch file and is (correctly) not
  committed — delete it if it's no longer needed.
