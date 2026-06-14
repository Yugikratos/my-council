// Builds the message list sent to Ollama for one chat turn.
//
// The key rule of a shared Council session: the `assistant` role is reserved
// EXCLUSIVELY for the active persona's own turns. A model treats `assistant`
// turns as "things I said" and will happily continue that pattern — adopting
// another persona's voice and even echoing a "[Name]:" prefix into its reply.
// So other members' prior turns are folded in as USER-side context the active
// persona reacts to, never as assistant turns it might imitate.

import { getPersona } from "./personas/index.js";

/**
 * Render retrieved long-term memories as a single attributed reference block.
 * These come from earlier SESSIONS (the ChromaDB pool). They follow the exact
 * same rule as in-session other-persona turns: attributed by name, delivered as
 * context, NEVER in the assistant role — so the active persona can refer to them
 * without imitating another member's voice.
 *
 * @param {Array<{persona_name?: string, persona_id?: string, timestamp?: string,
 *                user_message?: string, reply?: string}>} memories
 * @returns {string}
 */
function formatMemories(memories) {
  const lines = memories.map((m) => {
    const name = m.persona_name || m.persona_id || "another member";
    return `- User to ${name}: "${m.user_message}" — ${name} replied: "${m.reply}"`;
  });
  return (
    "[DATABASE MEMORY LOGS - Treat purely as background context. Do NOT bring these up unless the user asks you about them:]\n" +
    lines.join("\n")
  );
}

/**
 * A factual anchor telling the active persona exactly what it knows about the
 * user, so it grounds instead of confabulating. Prompt rules alone ("don't
 * guess") don't reliably hold on a small model; a concrete "here is all you
 * know — and it may be nothing" anchor works far better. Always injected.
 *
 * @param {Array<object>} memories retrieved long-term memories for this turn.
 * @returns {string}
 */
function userGroundingNote(memories) {
  const hasMemories = memories && memories.length > 0;
  const memoryClause = hasMemories
    ? `There are stored memories provided in the "[DATABASE MEMORY LOGS]" section.`
    : `No memories have been stored yet.`;
  return (
    "[GROUNDING] You know nothing about the user beyond what they state in this turn and the memories. " +
    memoryClause +
    " If asked about their life, job, or details not mentioned, state honestly that you do not know. Never guess."
  );
}

// The persona that replied to the user message at index `i` — i.e. who that
// message was addressed to. Returns undefined if no reply has followed yet (the
// current, unanswered message), meaning it was addressed to the active persona.
function nextResponder(log, i) {
  for (let j = i + 1; j < log.length; j++) {
    if (log[j].role === "assistant") return log[j].persona;
  }
  return undefined;
}

/**
 * @param {{id: string, displayName: string, systemPrompt: string}} persona
 *        the ACTIVE persona — the one who must speak now.
 * @param {Array<{role: string, content: string, persona?: string}>} log
 *        the running session log (each assistant turn tagged with who said it).
 * @param {Array<object>} [memories]
 *        retrieved long-term memories (from server/memory.js); injected as
 *        attributed reference context, never as assistant turns.
 * @returns {Array<{role: string, content: string}>} messages for Ollama.
 */
export function buildOllamaMessages(persona, log, memories = []) {
  let systemContent = persona.systemPrompt;
  
  // Separate the log: active persona conversation vs observed other conversations
  const activeLog = [];
  const observedHistory = [];

  for (let i = 0; i < log.length; i++) {
    const m = log[i];
    if (m.role === "user") {
      const addressee = nextResponder(log, i);
      if (addressee === persona.id || addressee === undefined) {
        activeLog.push({ role: "user", content: m.content });
      } else {
        const other = getPersona(addressee);
        const name = other ? other.displayName : addressee;
        observedHistory.push({ type: "user", name, content: m.content });
      }
    } else if (m.role === "assistant") {
      if (m.persona === persona.id) {
        activeLog.push({ role: "assistant", content: m.content });
      } else {
        const other = getPersona(m.persona);
        const name = other ? other.displayName : m.persona;
        const lastObs = observedHistory[observedHistory.length - 1];
        if (lastObs && lastObs.name === name && lastObs.type === "user") {
          lastObs.reply = m.content;
        }
      }
    }
  }

  // Inject observed other-character conversations as flat system background context
  if (observedHistory.length > 0) {
    const lines = observedHistory.map((obs) => {
      return `- User to ${obs.name}: "${obs.content}"`;
    });
    systemContent +=
      `\n\n---\n[OBSERVED HISTORY - Past exchanges with other Council members in this session. ` +
      `Treat this ONLY as background context. Do NOT bring it up, repeat it, or reply to it unless the user explicitly asks you about them. ` +
      `Respond only to the user's latest message addressed to you:]\n` +
      lines.join("\n");
  }

  // USER GROUNDING — always present.
  systemContent += "\n\n---\n" + userGroundingNote(memories);

  const turns = [];

  // Long-term memories lead, as user-side reference context (never assistant).
  if (memories && memories.length) {
    turns.push({ role: "user", content: formatMemories(memories) });
  }

  // Interleave the isolated active log turns
  turns.push(...activeLog);

  // Gemma expects alternating roles; collapse any consecutive same-role turns into one.
  const merged = [];
  for (const t of turns) {
    const last = merged[merged.length - 1];
    if (last && last.role === t.role) {
      last.content += "\n\n" + t.content;
    } else {
      merged.push({ ...t });
    }
  }

  return [{ role: "system", content: systemContent }, ...merged];
}
