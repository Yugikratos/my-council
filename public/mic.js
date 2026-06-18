// My Council — Push-to-Talk (PTT) voice input manager
// This file executes entirely on the client, managing mic stream recording and STT API POST requests.

class MicManager {
  constructor() {
    this.btn = null;
    this.input = null;
    this.form = null;
    
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.isPressing = false;
    this.state = "idle"; // "idle" | "recording" | "transcribing"
    this.stream = null;
  }

  // Bind PTT triggers once elements are available
  init() {
    this.btn = document.getElementById("mic-btn");
    this.input = document.getElementById("input");
    this.form = document.getElementById("composer");

    if (!this.btn || !this.input || !this.form) {
      console.warn("[mic] UI elements missing. Voice input disabled.");
      return;
    }

    // Capture start on mousedown or touchstart
    this.btn.addEventListener("mousedown", (e) => this.onPressStart(e));
    this.btn.addEventListener("touchstart", (e) => this.onPressStart(e), { passive: false });

    // Capture release on mouseup, touchend, or mouseleave
    this.btn.addEventListener("mouseup", (e) => this.onPressEnd(e));
    this.btn.addEventListener("touchend", (e) => this.onPressEnd(e), { passive: false });
    this.btn.addEventListener("mouseleave", (e) => this.onPressEnd(e));
  }

  // Triggered when button is held down
  async onPressStart(e) {
    if (e && typeof e.preventDefault === "function" && e.cancelable) {
      e.preventDefault();
    }
    
    if (this.isPressing || this.state !== "idle") return;
    this.isPressing = true;

    try {
      this.updateState("recording");

      // Request microphone permissions if not already held
      if (!this.stream) {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      // If user released the button while permission prompt was still open, stop
      if (!this.isPressing) {
        this.updateState("idle");
        return;
      }

      this.audioChunks = [];
      
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
        this.onRecordingStopped();
      });

      this.mediaRecorder.start();
    } catch (err) {
      console.error("[mic] Microphone access error:", err);
      let noticeMsg = "Microphone access failed.";
      if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
        noticeMsg = "Microphone permission denied.";
      }
      this.showNotice(noticeMsg);
      this.updateState("idle");
      this.isPressing = false;
    }
  }

  // Triggered when button is released
  onPressEnd(e) {
    if (e && typeof e.preventDefault === "function" && e.cancelable) {
      e.preventDefault();
    }
    
    if (!this.isPressing) return;
    this.isPressing = false;

    if (this.state === "recording") {
      if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
        this.mediaRecorder.stop();
      } else {
        this.updateState("idle");
      }
    }
  }

  // Triggered once the recorder stops and outputs chunks
  async onRecordingStopped() {
    this.updateState("transcribing");

    try {
      const audioBlob = new Blob(this.audioChunks, { type: this.mediaRecorder.mimeType || "audio/webm" });
      
      // Prevent uploading empty or excessively short noise
      if (audioBlob.size < 1000) {
        this.showNotice("Recording too short.");
        this.updateState("idle");
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
        return;
      }

      // Inject text to composer textarea and submit it
      this.input.value = text;
      
      // Trigger textarea auto-height sizing event listener
      this.input.dispatchEvent(new Event("input"));

      // Delegate directly to existing submit event listener logic
      this.form.requestSubmit();
      this.updateState("idle");
    } catch (err) {
      console.error("[mic] Transcription failed:", err);
      this.showNotice("Transcription unavailable.");
      this.updateState("idle");
    }
  }

  // Transitions classes and text/aria-labels on the mic button element
  updateState(state) {
    this.state = state;
    if (!this.btn) return;

    this.btn.classList.remove("recording", "transcribing");

    if (state === "recording") {
      this.btn.classList.add("recording");
      this.btn.textContent = "🎙️";
      this.btn.setAttribute("aria-label", "Recording voice... release to transcribe.");
    } else if (state === "transcribing") {
      this.btn.classList.add("transcribing");
      this.btn.textContent = "⏳";
      this.btn.setAttribute("aria-label", "Transcribing voice input...");
    } else {
      this.btn.textContent = "🎤";
      this.btn.setAttribute("aria-label", "Push to talk");
    }
  }

  // Dynamically inserts a notice into the chat history area
  showNotice(message) {
    const chatEl = document.getElementById("chat");
    if (chatEl) {
      const n = document.createElement("div");
      n.className = "notice";
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
