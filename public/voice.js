// My Council — Text-to-Speech (TTS) audio playback queue and mute toggle
// This file runs entirely on the client, managing audio events in memory.

class VoiceManager {
  constructor() {
    this.audio = new Audio();
    this.audio.autoplay = false;
    
    // Mute state (memory-only, session duration)
    this.muted = false;

    // Utterance queue state
    this.activeUtteranceId = null;
    this.queue = [];
    this.nextSeqToPlay = 0;
    this.isPlaying = false;
    this.isFinished = false;

    // Handle end of sentence playback
    this.audio.addEventListener("ended", () => {
      this.onSentenceEnded();
    });

    // Handle errors during playback gracefully to keep queue moving
    this.audio.addEventListener("error", (e) => {
      console.warn("Audio element error during playback, skipping sentence:", e);
      this.onSentenceEnded();
    });
  }

  // Updates the mute state and stops active playback if muting
  setMuted(muted) {
    this.muted = !!muted;
    if (this.muted) {
      this.stop();
    }
  }

  // Stops all playback, resets the queue and returns avatar state to idle
  stop() {
    this.audio.pause();
    this.audio.src = "";
    this.activeUtteranceId = null;
    this.queue = [];
    this.nextSeqToPlay = 0;
    this.isPlaying = false;
    this.isFinished = false;
    this.updateSpeakingState();
  }

  // Handles an incoming SSE audio event
  handleAudioEvent(event) {
    if (this.muted) {
      return; // Skip audio fetching and processing entirely when muted
    }

    const { utteranceId, seq, url, last } = event;

    // Detect if a new utterance has started, stop and switch immediately
    if (this.activeUtteranceId !== utteranceId) {
      this.stop();
      this.activeUtteranceId = utteranceId;
    }

    // Add segment to queue if we haven't seen it yet
    if (!this.queue.some((item) => item.seq === seq)) {
      this.queue.push({ seq, url, last });
      // Keep queue sorted by sequence index
      this.queue.sort((a, b) => a.seq - b.seq);
    }

    // Mark that the utterance is finished streaming once the last chunk arrives
    if (last) {
      this.isFinished = true;
    }

    this.playNextIfNeeded();
  }

  // Attempts to play the next segment in the queue
  playNextIfNeeded() {
    if (this.isPlaying) {
      return;
    }

    const nextItemIndex = this.queue.findIndex((item) => item.seq === this.nextSeqToPlay);
    if (nextItemIndex !== -1) {
      const nextItem = this.queue[nextItemIndex];
      this.isPlaying = true;
      this.nextSeqToPlay++;
      this.updateSpeakingState();

      this.audio.src = nextItem.url;
      this.audio.play().catch((err) => {
        console.warn("Audio playback play() interrupted or failed:", err);
        this.onSentenceEnded();
      });
    } else {
      // If we are finished receiving events and have played everything, clean up
      if (this.isFinished && this.nextSeqToPlay >= this.queue.length) {
        this.stop();
      }
    }
  }

  // Triggered when a sentence completes (or fails)
  onSentenceEnded() {
    this.isPlaying = false;
    
    // Check if the item we just completed was the last sentence
    const lastItem = this.queue.find((item) => item.last);
    if (lastItem && this.nextSeqToPlay > lastItem.seq) {
      this.stop();
      return;
    }

    this.playNextIfNeeded();
  }

  // Synchronize state with window.avatarManager
  updateSpeakingState() {
    if (window.avatarManager && typeof window.avatarManager.setSpeaking === "function") {
      window.avatarManager.setSpeaking(this.isPlaying);
    }
  }
}

// Instantiate globally
window.voiceManager = new VoiceManager();

// Bind UI event listener for the mute toggle
document.addEventListener("DOMContentLoaded", () => {
  const muteBtn = document.getElementById("mute-toggle");
  if (muteBtn) {
    muteBtn.addEventListener("click", () => {
      const currentlyMuted = window.voiceManager.muted;
      const nextMutedState = !currentlyMuted;
      
      window.voiceManager.setMuted(nextMutedState);
      
      if (nextMutedState) {
        muteBtn.textContent = "🔇";
        muteBtn.classList.add("muted");
        muteBtn.setAttribute("aria-label", "Unmute voice playback");
      } else {
        muteBtn.textContent = "🔊";
        muteBtn.classList.remove("muted");
        muteBtn.setAttribute("aria-label", "Mute voice playback");
      }
    });
  }
});
