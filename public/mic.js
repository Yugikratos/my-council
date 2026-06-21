// My Council — Voice-activation (toggle + silence detection) voice input manager
// This file executes entirely on the client, managing mic stream recording, AudioContext monitoring, and STT API POST requests.

const SILENCE_TIMEOUT = 7000; // ms to wait after last speech before auto-stopping
const SPEECH_THRESHOLD = 0.015; // default fallback RMS amplitude threshold for speech detection

class MicManager {
  constructor() {
    this.btn = null;
    this.input = null;
    this.form = null;
    
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.state = "idle"; // "idle" | "listening" | "transcribing"
    
    this.stream = null;
    this.audioContext = null;
    this.analyser = null;
    this.sourceNode = null;
    
    this.silenceTimeoutId = null;
    this.volumeLoopId = null;
    this.resumeTimeoutId = null;
    
    this.hasSpeechBeenDetected = false;
    this.shouldTranscribe = false;
    
    // Persistent toggle/continuous listening state
    this.isAlwaysOn = false;
    this.isChatActive = false;
    this.isSpeaking = false;
    
    // Dynamic speech calibration & duration ceiling variables
    this.speechThreshold = 0.015;
    this.isCalibrating = false;
    this.calibrationSamples = [];
    this.maxDurationId = null;
  }

  // Bind toggle triggers once elements are available
  init() {
    this.btn = document.getElementById("mic-btn");
    this.input = document.getElementById("input");
    this.form = document.getElementById("composer");

    if (!this.btn || !this.input || !this.form) {
      console.warn("[mic] UI elements missing. Voice input disabled.");
      return;
    }

    // Single click/tap toggle listener
    this.btn.addEventListener("click", (e) => this.onButtonClick(e));
  }

  // Handle click toggling
  async onButtonClick(e) {
    if (e && typeof e.preventDefault === "function" && e.cancelable) {
      e.preventDefault();
    }

    if (this.state === "idle") {
      if (this.isAlwaysOn) {
        this.isAlwaysOn = false;
        this.cleanupStream();
        this.updateState("idle");
      } else {
        this.isAlwaysOn = true;
        await this.startListening();
      }
    } else if (this.state === "listening") {
      // Manual stop
      this.isAlwaysOn = false;
      this.stopRecording(false);
    } else if (this.state === "transcribing") {
      // Cancel continuous listening during transcription
      this.isAlwaysOn = false;
      this.cleanupStream();
      this.updateState("transcribing");
    }
  }

  // Starts the microphone stream, recorders, and level analyzers
  async startListening() {
    if (this.state !== "idle") return;

    // Do not start if the AI is actively processing or speaking
    if (this.isChatActive || this.isSpeaking) {
      console.log("[mic] Delaying listening: chat active or AI speaking.");
      return;
    }

    try {
      this.updateState("listening");
      this.hasSpeechBeenDetected = false;
      this.audioChunks = [];

      // Arm hard recording duration cap (45s)
      this.maxDurationId = setTimeout(() => {
        console.log("[mic] Max recording duration reached. Automatically stopping.");
        this.stopRecording(false);
      }, 45000);

      // Request/reuse microphone stream
      if (!this.stream) {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      // If state was changed (e.g. toggled off) during permission prompt, abort
      if (this.state !== "listening") {
        this.cleanup();
        return;
      }

      // Auto-detect optimal mime type
      let options = {};
      if (typeof MediaRecorder.isTypeSupported === "function") {
        if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
          options = { mimeType: "audio/webm;codecs=opus" };
        } else if (MediaRecorder.isTypeSupported("audio/webm")) {
          options = { mimeType: "audio/webm" };
        } else if (MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")) {
          options = { mimeType: "audio/ogg;codecs=opus" };
        }
      }

      this.mediaRecorder = new MediaRecorder(this.stream, options);

      this.mediaRecorder.addEventListener("dataavailable", (event) => {
        if (event.data && event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      });

      this.mediaRecorder.addEventListener("stop", () => {
        this.handleRecorderStop();
      });

      // Initialize Web Audio API components for silence detection
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AudioContextClass();
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      
      this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);
      this.sourceNode.connect(this.analyser);

      // Start dynamic threshold calibration for first 300ms
      this.isCalibrating = true;
      this.calibrationSamples = [];
      setTimeout(() => {
        if (this.state === "listening" && this.isCalibrating) {
          const avg = this.calibrationSamples.reduce((a, b) => a + b, 0) / (this.calibrationSamples.length || 1);
          const max = Math.max(...this.calibrationSamples, 0);
          
          // Calibrate threshold: 2.5x the max ambient noise, clamped between 0.01 and 0.05
          this.speechThreshold = Math.min(0.05, Math.max(0.01, max * 2.5));
          this.isCalibrating = false;
          console.log(`[mic] Calibrated speech threshold to ${this.speechThreshold.toFixed(4)} (ambient avg: ${avg.toFixed(4)}, max: ${max.toFixed(4)})`);
        }
      }, 300);

      // Start the volume analysis loop
      this.startVolumeLoop();

      this.mediaRecorder.start();
      console.log("[mic] Listening started. Calibrating and monitoring silence...");
    } catch (err) {
      console.error("[mic] Microphone access or AudioContext error:", err);
      let noticeMsg = "Microphone access failed.";
      if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
        noticeMsg = "Microphone permission denied.";
      }
      this.showNotice(noticeMsg);
      this.isAlwaysOn = false;
      this.cleanup();
      this.updateState("idle");
    }
  }

  // Analyzes live volume levels and controls silence timer
  startVolumeLoop() {
    if (this.volumeLoopId) {
      clearInterval(this.volumeLoopId);
    }
    const bufferLength = this.analyser.frequencyBinCount;
    const dataArray = new Float32Array(bufferLength);

    this.volumeLoopId = setInterval(() => {
      if (!this.analyser) return;
      this.analyser.getFloatTimeDomainData(dataArray);

      // Calculate Root Mean Square (RMS) volume
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i] * dataArray[i];
      }
      const rms = Math.sqrt(sum / bufferLength);

      if (this.isCalibrating) {
        this.calibrationSamples.push(rms);
        return; // Skip speech/silence checks during 300ms calibration
      }

      // Check if sound level crosses the calibrated speech threshold
      const threshold = this.speechThreshold || SPEECH_THRESHOLD;
      if (rms > threshold) {
        if (!this.hasSpeechBeenDetected) {
          this.hasSpeechBeenDetected = true;
          console.log("[mic] Speech detected. Silence timer armed.");
        }
        
        // Reset the silence timer
        if (this.silenceTimeoutId) {
          clearTimeout(this.silenceTimeoutId);
        }
        this.silenceTimeoutId = setTimeout(() => {
          console.log("[mic] Silence timeout reached. Automatically stopping.");
          this.stopRecording(false);
        }, SILENCE_TIMEOUT);
      }
    }, 100);
  }

  // Stop recording sequence
  stopRecording(isCancel = false) {
    if (this.state !== "listening") return;

    // Clear hard ceiling duration timeout
    if (this.maxDurationId) {
      clearTimeout(this.maxDurationId);
      this.maxDurationId = null;
    }

    // Determine if we should attempt transcription
    this.shouldTranscribe = this.hasSpeechBeenDetected && !isCancel;

    // Stop volume loop and clear timers immediately
    if (this.volumeLoopId) {
      clearInterval(this.volumeLoopId);
      this.volumeLoopId = null;
    }
    if (this.silenceTimeoutId) {
      clearTimeout(this.silenceTimeoutId);
      this.silenceTimeoutId = null;
    }

    // Clean up AudioContext elements
    if (this.audioContext) {
      if (this.audioContext.state !== "closed") {
        this.audioContext.close().catch(err => {
          console.error("[mic] Error closing AudioContext:", err);
        });
      }
      this.audioContext = null;
    }
    this.analyser = null;
    this.sourceNode = null;

    // Stop MediaRecorder (which triggers the "stop" handler)
    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      this.mediaRecorder.stop();
    } else {
      if (!this.isAlwaysOn) {
        this.cleanupStream();
      }
      this.updateState("idle");
      this.checkResume();
    }
  }

  // Handle the recorder stopped event
  async handleRecorderStop() {
    if (!this.isAlwaysOn) {
      this.cleanupStream();
    }

    if (this.shouldTranscribe) {
      await this.onRecordingStopped();
    } else {
      this.updateState("idle");
      this.checkResume();
    }
  }

  // Release microphone hardware
  cleanupStream() {
    if (this.stream) {
      this.stream.getTracks().forEach(track => {
        try {
          track.stop();
        } catch (e) {
          console.error("[mic] Error stopping track:", e);
        }
      });
      this.stream = null;
    }
  }

  // General absolute cleanup
  cleanup() {
    if (this.maxDurationId) {
      clearTimeout(this.maxDurationId);
      this.maxDurationId = null;
    }
    if (this.volumeLoopId) {
      clearInterval(this.volumeLoopId);
      this.volumeLoopId = null;
    }
    if (this.silenceTimeoutId) {
      clearTimeout(this.silenceTimeoutId);
      this.silenceTimeoutId = null;
    }
    if (this.resumeTimeoutId) {
      clearTimeout(this.resumeTimeoutId);
      this.resumeTimeoutId = null;
    }
    if (this.audioContext) {
      if (this.audioContext.state !== "closed") {
        this.audioContext.close().catch(() => {});
      }
      this.audioContext = null;
    }
    this.analyser = null;
    this.sourceNode = null;
    this.cleanupStream();
    this.mediaRecorder = null;
  }

  // Triggered once the recorder stops and outputs chunks
  async onRecordingStopped() {
    this.updateState("transcribing");

    try {
      const audioBlob = new Blob(this.audioChunks, { type: this.mediaRecorder?.mimeType || "audio/webm" });
      
      // Prevent uploading empty or excessively short noise
      if (audioBlob.size < 1000) {
        this.showNotice("Recording too short.");
        this.updateState("idle");
        this.checkResume();
        return;
      }

      const formData = new FormData();
      formData.append("file", audioBlob, "recording.webm");

      const res = await fetch("/api/transcribe", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        throw new Error(`STT HTTP status: ${res.status}`);
      }

      const data = await res.json();
      const text = (data.text || "").trim();

      if (!text) {
        this.showNotice("Could not understand audio.");
        this.updateState("idle");
        this.checkResume();
        return;
      }

      // Inject text to composer textarea and submit it
      this.input.value = text;
      
      // Trigger textarea auto-height sizing event listener
      this.input.dispatchEvent(new Event("input"));

      // Set chat to active immediately before submitting, so resume doesn't fire prematurely
      this.isChatActive = true;

      // Delegate directly to existing submit event listener logic
      this.form.requestSubmit();
      this.updateState("idle");
      this.checkResume();
    } catch (err) {
      console.error("[mic] Transcription failed:", err);
      this.showNotice("Transcription unavailable.");
      this.updateState("idle");
      this.checkResume();
    }
  }

  // Hooks invoked by VoiceManager and app.js to handle continuous listening
  onSpeakingStateChange(isPlaying) {
    this.isSpeaking = isPlaying;
    this.checkResume();
  }

  onChatTurnComplete() {
    this.isChatActive = false;
    this.checkResume();
  }

  // Automatically restarts listening when conditions are met
  checkResume() {
    if (this.isAlwaysOn && !this.isChatActive && !this.isSpeaking && this.state === "idle") {
      if (this.resumeTimeoutId) {
        clearTimeout(this.resumeTimeoutId);
      }
      this.resumeTimeoutId = setTimeout(() => {
        if (this.isAlwaysOn && !this.isChatActive && !this.isSpeaking && this.state === "idle") {
          this.startListening();
        }
      }, 300);
    }
  }

  notifyChatStart() {
    this.isChatActive = true;
    if (this.state === "listening") {
      this.stopRecording(true); // isCancel = true
    }
  }

  // Transitions classes and text/aria-labels on the mic button element
  updateState(state) {
    this.state = state;
    if (!this.btn) return;

    this.btn.classList.remove("recording", "transcribing");
    this.btn.classList.toggle("always-on", this.isAlwaysOn);

    if (state === "listening") {
      this.btn.classList.add("recording");
      this.btn.textContent = "🎙️";
      this.btn.setAttribute("aria-label", "Listening... tap again to stop.");
    } else if (state === "transcribing") {
      this.btn.classList.add("transcribing");
      this.btn.textContent = "⏳";
      this.btn.setAttribute("aria-label", "Transcribing voice input...");
    } else {
      this.btn.textContent = "🎤";
      if (this.isAlwaysOn) {
        this.btn.setAttribute("aria-label", "Voice activation active; waiting to resume.");
      } else {
        this.btn.setAttribute("aria-label", "Tap to speak (voice activation)");
      }
    }
  }

  // Dynamically inserts a notice into the chat history area
  showNotice(message) {
    const chatEl = document.getElementById("chat");
    if (chatEl) {
      // Remove any existing mic notices to prevent accumulation
      chatEl.querySelectorAll(".mic-notice").forEach(n => n.remove());

      const n = document.createElement("div");
      n.className = "notice mic-notice";
      n.textContent = message;
      chatEl.appendChild(n);
      chatEl.scrollTop = chatEl.scrollHeight;
    }
  }
}

// Instantiate globally
window.micManager = new MicManager();

// Initialize on load or immediately if DOM is already parsed
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    window.micManager.init();
  });
} else {
  window.micManager.init();
}


