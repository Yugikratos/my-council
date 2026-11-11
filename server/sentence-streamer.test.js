import { test } from "node:test";
import assert from "node:assert/strict";
import { SentenceStreamer } from "./sentence-streamer.js";

test("SentenceStreamer merges short interjections (< 20 chars)", () => {
  const streamer = new SentenceStreamer({ minChars: 20 });
  const chunk1 = streamer.push("Hmm. ");
  assert.deepEqual(chunk1, []);
  
  const chunk2 = streamer.push("Boredom is a choice. Find a task.");
  assert.deepEqual(chunk2, ["Hmm. Boredom is a choice."]);
  
  const chunk3 = streamer.flush();
  assert.deepEqual(chunk3, ["Find a task."]);
});

test("SentenceStreamer does not split on abbreviations or decimals", () => {
  const streamer = new SentenceStreamer({ minChars: 20 });
  const chunk1 = streamer.push("Dr. Smith said pi is 3.14 approximately. ");
  assert.deepEqual(chunk1, ["Dr. Smith said pi is 3.14 approximately."]);
  
  const chunk2 = streamer.push("He was completely correct in his calculations. ");
  assert.deepEqual(chunk2, ["He was completely correct in his calculations."]);
  
  assert.deepEqual(streamer.flush(), []);
});

test("SentenceStreamer does not split on ellipsis mid-thought", () => {
  const streamer = new SentenceStreamer({ minChars: 20 });
  const chunk1 = streamer.push("I am... fully functional and ready. Do not test my patience.");
  assert.deepEqual(chunk1, ["I am... fully functional and ready."]);
  
  const chunk2 = streamer.flush();
  assert.deepEqual(chunk2, ["Do not test my patience."]);
});

test("SentenceStreamer flushes short final clause", () => {
  const streamer = new SentenceStreamer({ minChars: 20 });
  const first = streamer.push("This is a complete sentence that is long enough. ");
  assert.deepEqual(first, ["This is a complete sentence that is long enough."]);
  
  const second = streamer.push("No.");
  assert.deepEqual(second, []);
  
  const finalChunk = streamer.flush();
  assert.deepEqual(finalChunk, ["No."]);
});
