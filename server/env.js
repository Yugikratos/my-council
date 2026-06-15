// Minimal, zero-dependency .env loader.
//
// Reads simple KEY=VALUE lines from a .env file at the repo root and populates
// process.env for any key not already set — a real environment variable ALWAYS
// wins over the file. This keeps secrets (e.g. GEMINI_API_KEY) out of tracked
// files: .env is gitignored; only .env.example (a placeholder) is committed.
//
// Security: values are NEVER logged or printed. Imported for its side effect by
// config.js, so it runs once before any env var is read.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(repoRoot, ".env");

try {
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();

    // Allow optional surrounding quotes: KEY="value" or KEY='value'.
    if (
      val.length >= 2 &&
      ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'")))
    ) {
      val = val.slice(1, -1);
    }

    // Real environment variables take precedence; only fill what's missing.
    if (key && !(key in process.env)) process.env[key] = val;
  }
} catch {
  // No .env file (or unreadable) — fine. Env vars may be set directly instead.
}
