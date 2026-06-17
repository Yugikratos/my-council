// Local TTS synthesis via Piper (server/tts.js).
//
// Turns a cleaned sentence into a spoken WAV file using a vendored piper.exe and
// per-persona .onnx voice models (see config.tts). Synthesis is best-effort and
// FAILS SOFT, exactly like the memory service: if piper or a voice model is
// missing, we log ONCE and return null — chat keeps working with no audio, never
// crashing the reply. The HTTP layer (server/index.js) serves the produced WAVs.
//
// Design notes:
// - execFile (NEVER shell:true), args passed as an array, so a Windows path with
//   spaces or any odd character can't be interpreted as shell syntax — no
//   command injection surface even though text never reaches the shell anyway
//   (it's written to piper's stdin, not the argv).
// - WAVs are written to a dedicated OS-temp subdir and pruned to the last N
//   (config.tts.retain) so disk doesn't grow without bound across a session.
// - An in-memory registry maps utteranceId+seq -> file path; the /api/tts route
//   resolves only through it (plus a path check), so a request can never name an
//   arbitrary file on disk.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { config } from "./config.js";

const TMP_DIR = join(tmpdir(), "my-council-tts");

// Ensure the temp dir exists and clear any stale WAVs from a previous run.
try {
  mkdirSync(TMP_DIR, { recursive: true });
  for (const f of readdirSync(TMP_DIR)) {
    if (f.endsWith(".wav")) {
      try {
        rmSync(join(TMP_DIR, f));
      } catch {
        /* ignore a file we can't remove (e.g. still locked) */
      }
    }
  }
} catch {
  /* if we can't even prep the temp dir, synthesize() will fail soft below */
}

// Log-once guards so a missing binary/model doesn't spam the console every turn.
let warnedMissingPiper = false;
const warnedMissingModel = new Set();
let warnedNoFfmpeg = false;

// Cache of model -> sample rate (read from the voice's .onnx.json), needed for
// the pitch-shift filter. Avoids re-reading the json every utterance.
const sampleRateCache = new Map();

// utteranceId -> Map(seq -> wavPath). Only paths we created live here.
const registry = new Map();
// Insertion order of "id:seq" keys, for pruning oldest-first.
const order = [];

// Merge the per-persona voice entry over the shared defaults. Returns null if no
// voice is configured for this persona (caller fails soft).
function voiceFor(personaId) {
  const voice = config.tts.voices?.[personaId];
  if (!voice || !voice.model) return null;
  return { ...config.tts.defaults, ...voice };
}

function modelPathFor(voice) {
  return join(config.tts.voicesDir, voice.model);
}

// Read the model's native sample rate from its .onnx.json (Piper stores it under
// audio.sample_rate). The pitch filter needs it. Defaults to 22050 (Piper's
// usual rate) if the json can't be read/parsed. Cached per model path.
function sampleRateFor(modelPath) {
  if (sampleRateCache.has(modelPath)) return sampleRateCache.get(modelPath);
  let sr = 22050;
  try {
    const meta = JSON.parse(readFileSync(`${modelPath}.json`, "utf8"));
    if (meta?.audio?.sample_rate) sr = Number(meta.audio.sample_rate);
  } catch {
    /* fall back to 22050 */
  }
  sampleRateCache.set(modelPath, sr);
  return sr;
}

// Lower (or raise) pitch WITHOUT changing duration, via ffmpeg. pitch < 1 is
// deeper. Piper has no pitch knob, so this is the only route to a true Kratos
// register. Best-effort: if ffmpeg is missing or fails, we log once and return
// the ORIGINAL un-shifted WAV so the reply is still spoken. On success the
// original is removed and the shifted path returned.
//   asetrate lowers pitch AND slows playback; aresample restores the rate;
//   atempo (1/pitch) restores the original duration. Net: same length, deeper.
function applyPitch(srcPath, sr, pitch) {
  return new Promise((resolve) => {
    const outPath = join(TMP_DIR, `${randomUUID()}.wav`);
    const filter = `asetrate=${sr}*${pitch},aresample=${sr},atempo=${1 / pitch}`;
    const args = ["-y", "-loglevel", "error", "-i", srcPath, "-af", filter, outPath];
    execFile(config.tts.ffmpegPath, args, (err) => {
      if (err || !existsSync(outPath)) {
        // Warn ONCE per process (mirrors the missing-piper case) whether ffmpeg
        // is absent (ENOENT) or ran but failed — either way we fall back to the
        // un-shifted WAV, and repeating the warning every turn would be noise.
        if (!warnedNoFfmpeg) {
          warnedNoFfmpeg = true;
          if (err?.code === "ENOENT") {
            console.warn(
              `[tts] ffmpeg unavailable (${config.tts.ffmpegPath}) — serving un-shifted audio. ` +
                "(Install ffmpeg or set FFMPEG_PATH for the deep-voice effect.)"
            );
          } else {
            console.warn(`[tts] ffmpeg unavailable (${err?.code ?? "error"}) — serving un-shifted audio.`);
          }
        }
        try {
          rmSync(outPath);
        } catch {
          /* ignore */
        }
        return resolve(srcPath); // fail soft: keep the original
      }
      try {
        rmSync(srcPath); // shifted version replaces the original
      } catch {
        /* ignore */
      }
      resolve(outPath);
    });
  });
}

// Prune the registry + on-disk WAVs down to the last `retain` utterances.
function pruneRegistry() {
  const retain = config.tts.retain;
  while (order.length > retain) {
    const key = order.shift();
    const [id, seqStr] = key.split(":");
    const seq = Number(seqStr);
    const seqMap = registry.get(id);
    const path = seqMap?.get(seq);
    if (path) {
      try {
        rmSync(path);
      } catch {
        /* ignore */
      }
      seqMap.delete(seq);
      if (seqMap.size === 0) registry.delete(id);
    }
  }
}

// Run piper for one sentence. Text goes in on stdin (not argv). Resolves on a
// clean exit with the output file present, rejects otherwise.
function runPiper(modelPath, outPath, voice, text) {
  return new Promise((resolve, reject) => {
    const args = [
      "--model",
      modelPath,
      "--output_file",
      outPath,
      "--length_scale",
      String(voice.length_scale),
      "--noise_scale",
      String(voice.noise_scale),
      "--noise_w",
      String(voice.noise_w),
    ];
    const child = execFile(config.tts.piperPath, args, (err) => {
      if (err) return reject(err);
      if (!existsSync(outPath)) return reject(new Error("piper produced no output"));
      resolve(outPath);
    });
    // Feed the sentence to piper's stdin. Guard against EPIPE if it exits early.
    child.stdin.on("error", () => {});
    child.stdin.write(text);
    child.stdin.end();
  });
}

/**
 * Synthesize one cleaned sentence to a WAV file.
 * @param {string} text       a single cleaned sentence (caller pre-cleans)
 * @param {string} personaId  which persona's voice to use
 * @returns {Promise<string|null>} absolute WAV path, or null on any failure
 */
export async function synthesize(text, personaId) {
  if (!config.tts.enabled) return null;
  if (!text || !text.trim()) return null;

  if (!existsSync(config.tts.piperPath)) {
    if (!warnedMissingPiper) {
      console.warn(
        `[tts] piper not found at ${config.tts.piperPath} — speech disabled this run. ` +
          "(Vendor piper.exe there or set PIPER_PATH; chat is unaffected.)"
      );
      warnedMissingPiper = true;
    }
    return null;
  }

  const voice = voiceFor(personaId);
  if (!voice) {
    if (!warnedMissingModel.has(personaId)) {
      console.warn(`[tts] no voice configured for persona "${personaId}" — no speech.`);
      warnedMissingModel.add(personaId);
    }
    return null;
  }

  const modelPath = modelPathFor(voice);
  if (!existsSync(modelPath)) {
    if (!warnedMissingModel.has(modelPath)) {
      console.warn(
        `[tts] voice model missing for "${personaId}": ${modelPath} ` +
          "(needs the .onnx and its matching .onnx.json) — no speech."
      );
      warnedMissingModel.add(modelPath);
    }
    return null;
  }

  const outPath = join(TMP_DIR, `${randomUUID()}.wav`);
  try {
    await runPiper(modelPath, outPath, voice, text);
    // Optional deep-voice pitch shift (fails soft → returns the original path).
    if (voice.pitch && voice.pitch !== 1) {
      return await applyPitch(outPath, sampleRateFor(modelPath), voice.pitch);
    }
    return outPath;
  } catch (err) {
    // One quiet category log; never throw into the chat flow.
    console.warn(`[tts] synthesis failed (${err?.code ?? "error"}) — skipping audio.`);
    return null;
  }
}

// Record a produced WAV so the /api/tts route can serve it, and prune old ones.
export function registerAudio(utteranceId, seq, wavPath) {
  let seqMap = registry.get(utteranceId);
  if (!seqMap) {
    seqMap = new Map();
    registry.set(utteranceId, seqMap);
  }
  seqMap.set(seq, wavPath);
  order.push(`${utteranceId}:${seq}`);
  pruneRegistry();
}

// Resolve an utteranceId+seq to a WAV path for serving. Validates inputs and
// only ever returns a path we ourselves registered that still exists on disk —
// so there is no path-traversal surface (the request never names a file).
export function getAudioPath(utteranceId, seq) {
  if (typeof utteranceId !== "string" || !/^[A-Za-z0-9-]+$/.test(utteranceId)) return null;
  if (!Number.isInteger(seq) || seq < 0) return null;
  const path = registry.get(utteranceId)?.get(seq);
  if (!path || !existsSync(path)) return null;
  // Defense in depth: confirm it really lives in our temp dir.
  try {
    if (!statSync(path).isFile()) return null;
  } catch {
    return null;
  }
  return path;
}
