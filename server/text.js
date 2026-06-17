// Shared voice-cleaning primitives.
//
// The same constraints apply in two places: the streaming reply filter
// (server/reply-filter.js, which must work token-by-token) and TTS synthesis
// (server/tts.js, which works on the finished reply). Both must strip the same
// unspeakable noise — *stage actions*, (stage actions), stray asterisks and
// wrapping quotes, collapsed newlines — so what gets spoken matches what was
// shown and stored. This module is the single source of truth for those rules;
// reply-filter.js imports the primitives so the two can never drift apart.
//
// "Unspeakable" = characters/spans a TTS voice would either read aloud wrong
// ("asterisk laughs asterisk") or that exist only as formatting. We do NOT touch
// meaning or sentence punctuation — only formatting noise is removed.

// Chars we never want spoken: asterisks, double/opening quotes, and stray
// parentheses left after stage-direction spans are removed. Keeps ' (straight
// apostrophe) and ’ (closing curly quote) so English contractions survive
// ("It's", "isn't").
export const STRIP_CHARS = /[\*"“”‘()]/g;

// Strip stage-direction spans and stray formatting chars, then collapse all
// whitespace (including newlines) to single spaces. Does NOT trim the ends —
// callers decide that (reply-filter.js withholds a trailing space mid-stream;
// cleanForVoice trims). Spans become a space, not "", so adjacent words don't
// fuse: "hi*waves*there" -> "hi there".
export function stripUnspeakable(s) {
  let out = s.replace(/\*[^*]*\*/g, " "); // *stage action*
  // Remove (stage actions), innermost-first so nested parens fully clear:
  // "(now (really))" -> "(now )" -> "". A single non-recursive pass would
  // leave a stray ")".
  let prev;
  do {
    prev = out;
    out = out.replace(/\([^()]*\)/g, " ");
  } while (out !== prev);
  return out
    .replace(STRIP_CHARS, "") // stray * " “ ” ‘ ( )
    .replace(/\s+/g, " "); // newlines + runs -> single space
}

// Clean a finished reply for synthesis/display: strip unspeakable noise and
// trim the ends. Meaning and sentence punctuation are preserved.
export function cleanForVoice(text) {
  return stripUnspeakable(text).trim();
}

// Split cleaned text into sentences for per-sentence synthesis (so the first
// sentence can start playing while later ones are still being synthesized).
// Splits only on a terminator FOLLOWED BY whitespace, via a lookbehind — so a
// decimal like "3.14" (no space after the dot) is never split. Empty pieces are
// dropped. Terminators stay attached to their sentence.
export function splitSentences(text) {
  return cleanForVoice(text)
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
