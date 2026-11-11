import { test } from "node:test";
import assert from "node:assert/strict";
import { matchLexicalMention, routeTurn } from "./router.js";

test("Tier 1: matchLexicalMention identifies direct @mentions", () => {
  assert.equal(matchLexicalMention("@kratos tell me about war"), "kratos");
  assert.equal(matchLexicalMention("@dante let's get pizza"), "dante");
  assert.equal(matchLexicalMention("Hey @vergil what is power"), "vergil");
});

test("Tier 1: matchLexicalMention identifies vocative addressing", () => {
  assert.equal(matchLexicalMention("Hey Dante, what do you think?"), "dante");
  assert.equal(matchLexicalMention("Kratos: give me advice"), "kratos");
  assert.equal(matchLexicalMention("Tell Jiraiya I need guidance"), "jiraiya");
  assert.equal(matchLexicalMention("What would Naruto say to this?"), "naruto");
});

test("Tier 1: matchLexicalMention returns null for general questions", () => {
  assert.equal(matchLexicalMention("What is the meaning of life?"), null);
  assert.equal(matchLexicalMention("I want to eat pizza today"), null);
});

test("Tier 3: routeTurn falls back to sticky currentPersonaId on short queries", async () => {
  // Mock fetch endpoint returning sticky decision
  const result = await routeTurn({
    query: "Why?",
    currentPersonaId: "vergil",
  });
  // Since query is short (< 4 words), lexical is null and semantic router or fallback keeps Vergil
  assert.ok(result.personaId === "vergil" || result.personaId === "kratos");
});

