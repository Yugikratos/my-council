import { test } from "node:test";
import assert from "node:assert/strict";
import { createTtsPipeline } from "./tts-pipeline.js";

test("tts-pipeline processes sentences in strict FIFO order with single concurrency", async () => {
  const events = [];
  let concurrentExecutions = 0;
  let maxConcurrency = 0;

  // Mock synthesis function with simulated delay
  async function mockSynthesize(text, personaId) {
    concurrentExecutions++;
    if (concurrentExecutions > maxConcurrency) {
      maxConcurrency = concurrentExecutions;
    }
    await new Promise((r) => setTimeout(r, 20));
    concurrentExecutions--;
    return `/tmp/${text}.wav`;
  }

  function mockRegisterAudio(utteranceId, seq, path) {}

  const pipeline = createTtsPipeline({
    personaId: "kratos",
    utteranceId: "test-utt",
    onAudioReady: (evt) => events.push(evt),
    synthesizeFn: mockSynthesize,
    registerAudioFn: mockRegisterAudio,
  });

  pipeline.enqueue("Sentence 1.", false);
  pipeline.enqueue("Sentence 2.", false);
  pipeline.enqueue("Sentence 3.", true);
  pipeline.finish();

  await pipeline.drain();

  assert.equal(maxConcurrency, 1, "Concurrency must never exceed 1");
  assert.equal(events.length, 3);
  assert.equal(events[0].seq, 0);
  assert.equal(events[0].last, false);
  assert.equal(events[1].seq, 1);
  assert.equal(events[1].last, false);
  assert.equal(events[2].seq, 2);
  assert.equal(events[2].last, true);
});

test("tts-pipeline cancellation drops remaining queue", async () => {
  const events = [];
  async function mockSynthesize(text, personaId) {
    await new Promise((r) => setTimeout(r, 20));
    return `/tmp/${text}.wav`;
  }

  const pipeline = createTtsPipeline({
    personaId: "kratos",
    utteranceId: "cancel-utt",
    onAudioReady: (evt) => events.push(evt),
    synthesizeFn: mockSynthesize,
    registerAudioFn: () => {},
  });

  pipeline.enqueue("First sentence.", false);
  pipeline.enqueue("Second sentence.", false);
  pipeline.enqueue("Third sentence.", true);

  // Cancel immediately
  pipeline.cancel();
  await pipeline.drain();

  assert.ok(events.length <= 1, "Cancelled pipeline should drop subsequent items");
});

