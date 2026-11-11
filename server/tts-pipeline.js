// Asynchronous FIFO TTS synthesis queue with concurrency = 1.
//
// Synthesizes complete sentences on CPU via Piper in the background while
// the LLM is still generating subsequent tokens. Enforces single-worker FIFO
// execution to prevent CPU thrashing on the host processor.

import { synthesize, registerAudio } from "./tts.js";

/**
 * Creates an asynchronous TTS streaming pipeline.
 *
 * @param {object} opts
 * @param {string} opts.personaId      active persona for voice selection
 * @param {string} opts.utteranceId    stable UUID for this reply's audio segments
 * @param {(event: object) => void} opts.onAudioReady callback to emit an SSE event to client
 * @param {(text: string, id: string) => Promise<string|null>} [opts.synthesizeFn] injectable for tests
 * @param {(id: string, seq: number, path: string) => void} [opts.registerAudioFn] injectable for tests
 */
export function createTtsPipeline({
  personaId,
  utteranceId,
  onAudioReady,
  synthesizeFn = synthesize,
  registerAudioFn = registerAudio,
}) {
  const queue = [];
  let seq = 0;
  let isFinished = false;
  let isCancelled = false;
  let isProcessing = false;
  let drainResolve = null;

  // Track the most recently emitted audio event so we can ensure `last: true`
  // reaches the client even if the final sentence was emitted before LLM stream closed.
  let lastEmittedEvent = null;

  async function processQueue() {
    if (isProcessing) return;
    isProcessing = true;

    while (queue.length > 0 && !isCancelled) {
      const item = queue.shift();
      const currentSeq = item.seq;
      const isLast = item.isLast;

      try {
        const wav = await synthesizeFn(item.text, personaId);
        if (wav && !isCancelled) {
          registerAudioFn(utteranceId, currentSeq, wav);
          const audioEvent = {
            type: "audio",
            utteranceId,
            seq: currentSeq,
            url: `/api/tts?id=${utteranceId}&seq=${currentSeq}`,
            last: isLast,
          };
          lastEmittedEvent = audioEvent;
          onAudioReady(audioEvent);
        }
      } catch (err) {
        console.warn(`[tts-pipeline] Synthesis failed for seq ${currentSeq}:`, err);
      }
    }

    isProcessing = false;

    if (isCancelled) {
      queue.length = 0;
      if (drainResolve) drainResolve();
      return;
    }

    if (isFinished && queue.length === 0) {
      // If the LLM has finished and all queued audio has emitted, check if the
      // last emitted event was marked last: false. If so, emit an update so the
      // client knows playback is complete.
      if (lastEmittedEvent && !lastEmittedEvent.last && !isCancelled) {
        lastEmittedEvent.last = true;
        onAudioReady({
          ...lastEmittedEvent,
          last: true,
        });
      }
      if (drainResolve) {
        drainResolve();
      }
    }
  }

  return {
    /**
     * Enqueue a sentence for synthesis.
     * @param {string} sentence
     * @param {boolean} [isLast=false]
     */
    enqueue(sentence, isLast = false) {
      if (isCancelled || !sentence || !sentence.trim()) return;
      const currentSeq = seq++;
      queue.push({ text: sentence.trim(), seq: currentSeq, isLast });
      processQueue();
    },

    /**
     * Mark that no more sentences will be enqueued.
     */
    finish() {
      isFinished = true;
      if (queue.length > 0) {
        queue[queue.length - 1].isLast = true;
      }
      processQueue();
    },

    /**
     * Await until all enqueued items are synthesized and dispatched.
     * @returns {Promise<void>}
     */
    async drain() {
      if (!isProcessing && queue.length === 0) {
        return;
      }
      return new Promise((resolve) => {
        drainResolve = resolve;
      });
    },

    /**
     * Cancel the pipeline immediately (e.g. client disconnected / aborted).
     */
    cancel() {
      isCancelled = true;
      queue.length = 0;
      if (drainResolve) drainResolve();
    },

    /**
     * Total number of items processed or pending.
     */
    totalEnqueued() {
      return seq;
    },
  };
}

