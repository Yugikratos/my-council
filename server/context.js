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
    const date = (m.timestamp || "").slice(0, 10); // YYYY-MM-DD
    const when = date ? `(${date}) ` : "";
    const name = m.persona_name || m.persona_id || "another member";
    return `- ${when}You said to ${name}: "${m.user_message}" — ${name} replied: "${m.reply}"`;
  });
  return (
    "[Long-term memory — relevant moments from earlier sessions with the Council. " +
    "This is shared context to inform your reply, not your own words unless attributed " +
    "to you. You may refer to it naturally.]\n" +
    lines.join("\n")
  );
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
  // Did any OTHER member speak earlier in this session?
  const fromOthers = log.some(
    (m) => m.role === "assistant" && m.persona && m.persona !== persona.id
  );

  // The active persona's character sheet is always the system prompt. Only when
  // other members are present do we explain how their turns appear, and pin the
  // active persona's identity so it never slips into another's voice.
  let systemContent = persona.systemPrompt;
  if (fromOthers) {
    systemContent +=
      `\n\n---\nThis is a shared Council session. Earlier replies from OTHER members appear ` +
      `as context lines like: 'Earlier in this conversation, Kratos (another Council member) said: "..."'. Those are their ` +
      `words, not yours. Respond only as yourself, ${persona.displayName}, in your own voice. ` +
      `Never begin your reply with a name label such as "[Kratos]:", and never speak as another ` +
      `member. You may refer to what another member said.`;
  }

  // Convert each logged turn. Other members' turns become user-side context;
  // the active persona's own turns stay clean assistant turns.
  const turns = [];

  // Long-term memories lead, as user-side reference context (never assistant).
  // The merge step below folds this into the first real user turn.
  if (memories && memories.length) {
    turns.push({ role: "user", content: formatMemories(memories) });
  }

  for (const m of log) {
    if (m.role === "user") {
      turns.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      if (m.persona && m.persona !== persona.id) {
        const other = getPersona(m.persona);
        const name = other ? other.displayName : m.persona;
        turns.push({
          role: "user",
          content: `Earlier in this conversation, ${name} (another Council member) said: "${m.content}"`,
        });
      } else {
        turns.push({ role: "assistant", content: m.content });
      }
    }
  }

  // Gemma expects alternating roles; collapse any consecutive same-role turns
  // (which folding other members into the user side can create) into one.
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
