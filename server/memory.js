// Node client for the local memory service (memory-service/, a ChromaDB wrapper).
//
// Every call FAILS SOFT: if the service is unreachable, retrieval returns no
// memories and storage is skipped, with a warning logged. The chat loop then
// continues as normal in-session conversation — the app must never crash just
// because the memory service is down.

import { config } from "./config.js";

const { url, enabled } = config.memory;

// Keep this short so a dead/hung service can't stall a chat turn for long.
const TIMEOUT_MS = 4000;

async function postJson(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`memory service responded ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Retrieve the most relevant past exchanges for `query`.
 * @returns {Promise<{ok: boolean, memories: Array}>}
 *   ok=false means the memory service was unreachable (caller should notify UI).
 */
export async function retrieve(query) {
  if (!enabled || !query) return { ok: true, memories: [] };
  try {
    const data = await postJson("/retrieve", { query });
    return { ok: true, memories: data.memories ?? [] };
  } catch (err) {
    console.warn(`[memory] retrieve failed: ${err.message}`);
    return { ok: false, memories: [] };
  }
}

/**
 * Persist one exchange verbatim, tagged with persona id + name (timestamp is
 * set service-side). Fails soft.
 * @returns {Promise<boolean>} true if stored.
 */
export async function store({ personaId, personaName, userMessage, reply }) {
  if (!enabled) return false;
  try {
    const data = await postJson("/store", {
      persona_id: personaId,
      persona_name: personaName,
      user_message: userMessage,
      reply,
    });
    // The service may decline to persist a low-value exchange (greeting,
    // non-answer); that's a success, not an error — just note it.
    if (data && data.stored === false) {
      console.log("[memory] skipped low-value exchange (not stored)");
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[memory] store failed: ${err.message}`);
    return false;
  }
}
