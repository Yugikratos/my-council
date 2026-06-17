// Streaming reply sanitizer — enforces the voice constraints (see CLAUDE.md
// "Voice-First Prompt Constraints") on the MODEL'S output, not just in the
// prompt. A small local model ignores instructions often enough that the prompt
// alone can't be trusted: it still emits stage directions, *actions*, speaker
// labels, multi-line prose, and runs past the 1-3 sentence limit. This filter is
// the backstop that makes the output actually spokable.
//
// It runs token-by-token so the UI keeps streaming. The trick for correctness:
// we re-clean the WHOLE accumulated reply on every token and emit only the new
// stable suffix. Any tail that could still change — an unclosed *...* or (...)
// span — is held back until it closes, so we never emit text we'd have to take
// back. Both the local and cloud paths feed through one instance, so they get
// identical treatment.
//
// What it removes: *stage actions* and (stage actions); stray asterisks and
// double/opening quotes (apostrophes and the closing curly quote survive so
// contractions read right); a leading "Name:" speaker label; newlines and
// runs of whitespace (collapsed to single spaces). What it caps: the reply to
// the first MAX_SENTENCES sentences.

import { stripUnspeakable } from "./text.js";

// The prompts ask personas for 1-3 sentences; this is only the backstop. We cap
// at 4, not 3, to leave one sentence of slack so a trailing catchphrase after a
// full reply (Naruto's "Believe it!", Anya's "Waku waku!", Dante's "Jackpot!")
// isn't truncated — those are core to the persona specs. Still bounds runaway.
const MAX_SENTENCES = 4;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Index of a trailing UNCLOSED `*` (an opener with no closing `*` yet), or -1.
// An odd count of `*` means the last one is still open.
function trailingOpenStarIndex(s) {
  let count = 0;
  let last = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "*") {
      count++;
      last = i;
    }
  }
  return count % 2 === 1 ? last : -1;
}

// Index of the earliest unclosed `(`, or -1.
function firstUnclosedParenIndex(s) {
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") stack.push(i);
    else if (s[i] === ")") stack.pop();
  }
  return stack.length ? stack[0] : -1;
}

// Earliest point from which the tail is still in flux (an open span), or -1.
function holdIndex(s) {
  const a = trailingOpenStarIndex(s);
  const b = firstUnclosedParenIndex(s);
  if (a >= 0 && b >= 0) return Math.min(a, b);
  return Math.max(a, b); // whichever is >= 0, else -1
}

/**
 * Create a per-reply streaming filter.
 *
 * @param {{displayName?: string, maxSentences?: number}} opts
 *   displayName: the active persona's name, used to strip a leading "Name:"
 *     speaker label the model sometimes prepends.
 * @returns {{push(token: string): string, flush(): string, text(): string}}
 *   push  — feed a raw token; returns the new clean text to send (may be "").
 *   flush — call once at end of stream; returns any final clean text to send.
 *   text  — the full clean reply so far (for storage / fallback checks).
 */
export function createReplyFilter({ displayName, maxSentences = MAX_SENTENCES } = {}) {
  let raw = ""; // every raw token received, concatenated
  let emitted = ""; // clean text already sent to the client
  let finalText = null; // set on flush; the canonical clean reply

  const labelRe = displayName
    ? new RegExp("^\\s*" + escapeRegExp(displayName) + "\\s*:\\s*", "i")
    : null;

  // Strip spans/chars and collapse whitespace (shared with TTS via text.js so
  // the spoken/stored text matches), then drop a leading "Name:" speaker label
  // and any leading space. stripUnspeakable turns spans into a space (not "") so
  // adjacent words don't fuse: "hi*waves*there" -> "hi there".
  function clean(s) {
    let out = stripUnspeakable(s);
    if (labelRe) out = out.replace(labelRe, "");
    return out.replace(/^\s+/, ""); // drop leading space
  }

  // A leading bare word (no delimiter yet) could still become a "Name:" speaker
  // label, so before we've emitted anything we must NOT release it — otherwise
  // "Kratos: ..." streams the word "Kratos" before the colon arrives to identify
  // it. Holds only while the buffer is one unfinished word at the very start.
  function isPotentialLeadingLabel(s) {
    return labelRe !== null && emitted === "" && /^\s*[A-Za-z]+$/.test(s);
  }

  // Keep only the first `maxSentences` sentences. Consecutive terminators
  // (".", "!", "?", "...", "?!") count as one ending.
  function capSentences(text) {
    let count = 0;
    let i = 0;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === "." || c === "!" || c === "?") {
        while (i + 1 < text.length && ".!?".includes(text[i + 1])) i++;
        count++;
        if (count >= maxSentences) {
          i++;
          break;
        }
      }
    }
    return text.slice(0, i);
  }

  // Compute the clean string for the current raw buffer, holding back any
  // still-open trailing span, then emit the new suffix beyond what we've sent.
  // A trailing space is withheld (kept as the live edge) so we never stream a
  // dangling space ahead of a held span — it rejoins the next word instead.
  function reconcile(working) {
    const stable = capSentences(clean(working)).replace(/\s+$/, "");
    if (stable.startsWith(emitted)) {
      const add = stable.slice(emitted.length);
      emitted = stable;
      return add;
    }
    // Shouldn't happen (we never emit unstable text); never un-send — hold.
    return "";
  }

  return {
    push(token) {
      raw += token;
      const hold = holdIndex(raw);
      const working = hold >= 0 ? raw.slice(0, hold) : raw;
      if (isPotentialLeadingLabel(working)) return "";
      return reconcile(working);
    },

    flush() {
      // Stream ended: drop any dangling unclosed span (an incomplete stage
      // direction or a stray opener) rather than emit it.
      let working = raw;
      const a = trailingOpenStarIndex(working);
      if (a >= 0) working = working.slice(0, a);
      const b = firstUnclosedParenIndex(working);
      if (b >= 0) working = working.slice(0, b);

      const cleaned = capSentences(clean(working)).replace(/\s+$/, "");
      finalText = cleaned;
      if (cleaned.startsWith(emitted)) {
        const add = cleaned.slice(emitted.length);
        emitted = cleaned;
        return add;
      }
      // Final form trimmed a trailing space we already sent — nothing to add.
      return "";
    },

    text() {
      return finalText ?? emitted;
    },
  };
}
