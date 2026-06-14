// Persona registry — the single source of truth for which personas exist.
// The rest of the app only talks to this registry, never to individual persona
// files. To add another member of the Council: create a file in this folder
// (see kratos.js) and register it in the `personas` map below.

import { kratos } from "./kratos.js";

const personas = {
  [kratos.id]: kratos,
};

// The persona loaded by default. In a later step this becomes "random on launch".
export const DEFAULT_PERSONA_ID = kratos.id;

// Look up a persona by id. Returns undefined if it doesn't exist.
export function getPersona(id) {
  return personas[id];
}

// Public-facing list (no system prompts) — useful for a future persona picker.
export function listPersonas() {
  return Object.values(personas).map(({ id, displayName }) => ({ id, displayName }));
}
