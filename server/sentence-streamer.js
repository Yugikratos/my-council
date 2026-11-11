// Real-time sentence chunker for streaming LLM tokens.
//
// Extracts complete sentences as tokens arrive so TTS synthesis can begin
// immediately on sentence 0 while the LLM is still drafting sentence 1.
//
// Constraints:
// 1. Does NOT split on common abbreviations (Mr., Mrs., Ms., Dr., Prof., Sr., Jr., vs., e.g., i.e., etc.).
// 2. Does NOT split on ellipsis (... or …) or decimal numbers (e.g. 3.14).
// 3. Enforces a minimum character threshold (default 20) so short interjections
//    ("Hmm.", "Wait.") merge into the following clause for smoother prosody.
// 4. On flush(), yields any remaining text even if below the threshold.

const ABBREVIATIONS = /\b(?:mr|mrs|ms|dr|prof|sr|jr|vs|e\.g|i\.e|etc)\.$/i;

export class SentenceStreamer {
  /**
   * @param {object} [opts]
   * @param {number} [opts.minChars=20] minimum characters before a sentence boundary is accepted
   */
  constructor({ minChars = 20 } = {}) {
    this.minChars = minChars;
    this.buffer = "";
  }

  /**
   * Push incoming streaming text (tokens).
   * @param {string} text
   * @returns {string[]} complete sentences ready for synthesis
   */
  push(text) {
    if (!text) return [];
    this.buffer += text;
    return this._drain(false);
  }

  /**
   * Flush any remaining text at the end of the LLM stream.
   * @returns {string[]} remaining sentence(s)
   */
  flush() {
    return this._drain(true);
  }

  /**
   * Current uncommitted buffer content.
   */
  getBuffer() {
    return this.buffer;
  }

  _drain(isFlushing) {
    const sentences = [];
    let remaining = this.buffer;

    while (true) {
      // When flushing, allow boundary at end-of-string.
      // During active streaming, require trailing whitespace to ensure the sentence is truly ended.
      const regex = isFlushing ? /([.!?]+)(?:\s+|$)/g : /([.!?]+)\s+/g;
      let match;
      let foundBoundary = false;

      while ((match = regex.exec(remaining)) !== null) {
        const punct = match[1];
        const matchEnd = match.index + punct.length;
        const candidate = remaining.slice(0, matchEnd).trim();

        // 1. Guard against ellipsis (".." or "..." or "…")
        if (punct.length > 1 && /^\.+$/.test(punct)) {
          continue;
        }
        if (candidate.endsWith("…")) {
          continue;
        }

        // 2. Guard against abbreviations (e.g. "Dr.", "e.g.", "vs.")
        if (ABBREVIATIONS.test(candidate)) {
          continue;
        }

        // 3. Minimum length check: if not flushing, short phrases merge with next sentence
        if (!isFlushing && candidate.length < this.minChars) {
          continue;
        }

        // Valid boundary found!
        if (candidate.length > 0) {
          sentences.push(candidate);
        }
        remaining = remaining.slice(match.index + match[0].length);
        foundBoundary = true;
        break;
      }

      if (!foundBoundary) {
        break;
      }
    }

    if (isFlushing) {
      const leftover = remaining.trim();
      if (leftover.length > 0) {
        sentences.push(leftover);
      }
      this.buffer = "";
    } else {
      this.buffer = remaining;
    }

    return sentences;
  }
}
