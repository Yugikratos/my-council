// Three-Tier Persona Router (server/router.js)
//
// Selects the optimal Council persona to answer a user's prompt:
// Tier 1: Deterministic Lexical Parser (<1ms regex matching explicit mentions/vocatives).
// Tier 2: In-Memory Semantic Router (<15ms ONNX embedding cosine similarity on CPU).
// Tier 3: Conversational Inertia / Sticky Speaker Guard (preserves current speaker on short follow-ups or low confidence).

import { config } from "./config.js";
import { getPersona, DEFAULT_PERSONA_ID } from "./personas/index.js";

const PERSONA_NAMES = ["kratos", "dante", "vergil", "jiraiya", "naruto", "anya"];

// Regex for explicit mentions (e.g. "@kratos", "hey dante", "vergil, what do you think")
const MENTION_PATTERNS = [
  // @persona
  new RegExp(`@(${PERSONA_NAMES.join("|")})\\b`, "i"),
  // Leading vocative: "Hey Dante,", "Kratos: tell me", "Yo Naruto"
  new RegExp(`^(?:hey|hi|hello|yo)?\\s*(${PERSONA_NAMES.join("|")})\\s*[,:]`, "i"),
  // "Ask Kratos", "Tell Dante", "What does Vergil think"
  new RegExp(`\\b(?:ask|tell)\\s+(${PERSONA_NAMES.join("|")})\\b`, "i"),
  new RegExp(`\\bwhat\\s+(?:does|would)\\s+(${PERSONA_NAMES.join("|")})\\s+(?:think|say)\\b`, "i"),
];

/**
 * Tier 1: Fast lexical scan for direct character invocation.
 * @param {string} text
 * @returns {string|null} matched personaId or null
 */
export function matchLexicalMention(text) {
  if (!text) return null;
  const trimmed = text.trim();
  for (const pattern of MENTION_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match && match[1]) {
      const id = match[1].toLowerCase();
      if (getPersona(id)) return id;
    }
  }
  return null;
}

/**
 * Route a chat turn to the appropriate persona using the 3-tier hierarchy.
 *
 * @param {object} opts
 * @param {string} opts.query
 * @param {string} [opts.currentPersonaId] currently active persona in session
 * @param {number} [opts.confidenceThreshold=0.35]
 * @param {string} [opts.memoryUrl] injectable memory service URL
 * @returns {Promise<{personaId: string, displayName: string, method: string, confidence: number}>}
 */
export async function routeTurn({
  query,
  currentPersonaId = DEFAULT_PERSONA_ID,
  confidenceThreshold = 0.35,
  memoryUrl = config.memory.url,
}) {
  const defaultFallback = getPersona(currentPersonaId) ? currentPersonaId : DEFAULT_PERSONA_ID;

  // Tier 1: Lexical Match (<1ms, no network)
  const lexicalMatch = matchLexicalMention(query);
  if (lexicalMatch) {
    const persona = getPersona(lexicalMatch);
    return {
      personaId: persona.id,
      displayName: persona.displayName,
      method: "lexical",
      confidence: 1.0,
    };
  }

  // Tier 2 & 3: In-Memory Semantic Router in Python service (or sticky fallback)
  if (!config.memory.enabled) {
    const persona = getPersona(defaultFallback);
    return {
      personaId: persona.id,
      displayName: persona.displayName,
      method: "fallback_disabled",
      confidence: 0.0,
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000); // 2s bound

    const res = await fetch(`${memoryUrl}/route`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        current_persona: defaultFallback,
        confidence_threshold: confidenceThreshold,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      const data = await res.json();
      const chosenId = data.selected_persona || defaultFallback;
      const persona = getPersona(chosenId) || getPersona(defaultFallback);
      return {
        personaId: persona.id,
        displayName: persona.displayName,
        method: data.method || "semantic",
        confidence: data.confidence ?? 0.5,
      };
    }
  } catch (err) {
    console.warn(`[router] Semantic route failed (${err.message}) — using fallback`);
  }

  // Final fallback to sticky active persona
  const persona = getPersona(defaultFallback);
  return {
    personaId: persona.id,
    displayName: persona.displayName,
    method: "fallback",
    confidence: 0.0,
  };
}

