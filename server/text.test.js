// Tests for the shared voice-cleaning primitives (server/text.js).
// Run: node --test server/text.test.js

import { test } from "node:test";
import assert from "node:assert/strict";

import { cleanForVoice, splitSentences, stripUnspeakable } from "./text.js";

test("cleanForVoice strips a *stage action* span", () => {
  assert.equal(cleanForVoice("*laughs* You came back."), "You came back.");
});

test("cleanForVoice collapses literal newlines to single spaces", () => {
  assert.equal(cleanForVoice("Hello\nthere.\n\nStay."), "Hello there. Stay.");
});

test("cleanForVoice strips wrapping double-quotes", () => {
  assert.equal(cleanForVoice('"You came back."'), "You came back.");
});

test("cleanForVoice preserves apostrophes/contractions and meaning", () => {
  assert.equal(cleanForVoice("It's done, isn't it?"), "It's done, isn't it?");
});

test("cleanForVoice clears nested (stage directions) without stray parens", () => {
  assert.equal(cleanForVoice("Go (now (really)) and rest."), "Go and rest.");
});

test("stripUnspeakable does not trim (callers decide)", () => {
  // A mid-stream caller relies on the ends being left alone.
  assert.equal(stripUnspeakable("  hi  "), " hi ");
});

test("splitSentences splits on terminators followed by whitespace", () => {
  assert.deepEqual(splitSentences("One. Two! Three?"), ["One.", "Two!", "Three?"]);
});

test("splitSentences does not split a decimal number", () => {
  assert.deepEqual(splitSentences("Pi is 3.14 today."), ["Pi is 3.14 today."]);
});

test("splitSentences cleans before splitting", () => {
  assert.deepEqual(
    splitSentences("*grins* You came back. Stay a while."),
    ["You came back.", "Stay a while."]
  );
});
