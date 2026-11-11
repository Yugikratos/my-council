// Idle Detector & Live Chat Preemption Daemon (server/idle-detector.js)
//
// Monitors system activity across chat and transcription endpoints.
// When the system has been idle for >= idleThresholdMs, dispatches a background
// consolidation request (Sleep Cycle ETL) to the memory service.
// If an incoming chat turn arrives while consolidation is active, preempts
// the consolidation job immediately so live chat gets 100% GPU priority.

import { config } from "./config.js";

export class IdleDetector {
  constructor({
    idleThresholdMs = config.memory.idleConsolidationMs || 5 * 60 * 1000,
    checkIntervalMs = 30 * 1000,
    memoryUrl = config.memory.url,
  } = {}) {
    this.idleThresholdMs = idleThresholdMs;
    this.checkIntervalMs = checkIntervalMs;
    this.memoryUrl = memoryUrl;
    this.lastActivityTime = Date.now();
    this.timer = null;
    this.isConsolidating = false;
  }

  /**
   * Start the background idle monitor.
   */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.checkIdle(), this.checkIntervalMs);
    // Don't keep the Node.js event loop alive solely for idle checking
    if (this.timer.unref) this.timer.unref();
  }

  /**
   * Stop the background idle monitor.
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Call whenever user interaction occurs (chat or STT transcription).
   */
  recordActivity() {
    this.lastActivityTime = Date.now();
  }

  /**
   * Preempt running consolidation immediately when live chat arrives.
   */
  async preempt() {
    this.recordActivity();
    if (this.isConsolidating) {
      console.log("[idle-detector] Live chat turn detected — preempting background consolidation.");
      try {
        await fetch(`${this.memoryUrl}/consolidate/abort`, { method: "POST" });
      } catch {
        /* fail soft */
      }
      this.isConsolidating = false;
    }
  }

  /**
   * Periodic check: trigger consolidation if idle threshold reached.
   */
  async checkIdle() {
    if (!config.memory.enabled) return;
    if (this.isConsolidating) return;

    const idleTime = Date.now() - this.lastActivityTime;
    if (idleTime >= this.idleThresholdMs) {
      this.isConsolidating = true;
      console.log(`[idle-detector] System idle for ${Math.round(idleTime / 1000)}s — triggering memory consolidation.`);
      try {
        const res = await fetch(`${this.memoryUrl}/consolidate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ batch_size: 10 }),
        });
        if (res.ok) {
          const result = await res.json();
          if (result.processed && result.processed > 0) {
            console.log(`[idle-detector] Consolidation batch completed: ${result.processed} raw turns processed, ${result.facts_added} facts added.`);
          }
        }
      } catch (err) {
        console.warn(`[idle-detector] Consolidation trigger failed: ${err.message}`);
      } finally {
        this.isConsolidating = false;
        // Bump activity time so we wait another full idle interval before next run
        this.recordActivity();
      }
    }
  }
}

export const idleDetector = new IdleDetector();

