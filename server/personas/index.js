// Persona registry — the single source of truth for which personas exist.
// The rest of the app only talks to this registry, never to individual persona
// files. To add another member of the Council: create a file in this folder
// (see kratos.js) and add it to the `roster` array below.

import { kratos } from "./kratos.js";
import { dante } from "./dante.js";
import { vergil } from "./vergil.js";
import { jiraiya } from "./jiraiya.js";
import { naruto } from "./naruto.js";
import { anya } from "./anya.js";

// Order here controls the order the names appear in the UI roster.
const roster = [kratos, dante, vergil, jiraiya, naruto, anya];

const personas = Object.fromEntries(roster.map((p) => [p.id, p]));

// The persona loaded by default. CLAUDE.md's runtime flow calls for "random on
// launch" eventually; we keep a fixed default for now so behavior is predictable.
export const DEFAULT_PERSONA_ID = kratos.id;

// Look up a persona by id. Returns undefined if it doesn't exist.
export function getPersona(id) {
  return personas[id];
}

// Public-facing list (no system prompts) — used to populate the UI picker.
export function listPersonas() {
  return roster.map(({ id, displayName }) => ({ id, displayName }));
}
