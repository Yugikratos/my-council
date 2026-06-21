// My Council — desktop avatar visuals and logic
// This logic is kept isolated to respect the frontend/backend contract.

const CACHE_BUSTER = Date.now();

class AvatarManager {
  constructor() {
    this.avatarEl = document.getElementById("avatar-image");
    this.containerEl = document.getElementById("avatar-container");
    this.isTalking = false;
    this.isSpeaking = false;
    this.activeId = null;
    this.emotion = "idle"; // Custom emotion states: "idle", "angry", "happy", etc.
    this._loadToken = 0;
    this._lastTargetSrc = null;
  }

  // Switches the portrait image
  switchPersona(id) {
    if (!this.avatarEl) return;
    this.activeId = id;
    this.emotion = "idle"; // Reset emotion on switch
    this._lastTargetSrc = null; // Clear so targetSrc is re-evaluated and loaded
    
    // Add a quick fade out effect
    this.avatarEl.style.opacity = 0;
    
    setTimeout(() => {
      this.avatarEl.alt = id;
      this.updateAvatarSrc();
      // Fade back in
      this.avatarEl.style.opacity = 1;
    }, 150);
  }

  // Toggles the talking/generating animation state
  setTalking(isTalking, isDeep = false) {
    this.isTalking = isTalking;
    if (!this.containerEl) return;
    
    if (isTalking) {
      this.containerEl.classList.add("talking");
      if (isDeep) {
        this.containerEl.classList.add("deep-generating");
      } else {
        this.containerEl.classList.remove("deep-generating");
      }
    } else {
      this.containerEl.classList.remove("talking");
      this.containerEl.classList.remove("deep-generating");
    }
    this.updateAvatarSrc();
  }

  // Toggles the speaking/audio playing animation state
  setSpeaking(isSpeaking) {
    this.isSpeaking = isSpeaking;
    if (!this.containerEl) return;

    if (isSpeaking) {
      this.containerEl.classList.add("speaking");
    } else {
      this.containerEl.classList.remove("speaking");
    }
    this.updateAvatarSrc();
  }

  // Explicitly sets a custom emotion pose
  setEmotion(emotion) {
    this.emotion = emotion || "idle";
    this.updateAvatarSrc();
  }

  // Helper that selects target source and applies preloading + fallback
  updateAvatarSrc() {
    if (!this.avatarEl || !this.activeId) return;

    let targetSrc = `avatars/${this.activeId}.png`; // Default fallback

    if (this.emotion && this.emotion !== "idle") {
      // Prioritize active custom emotions (e.g. avatars/[persona]-[emotion].gif)
      targetSrc = `avatars/${this.activeId}-${this.emotion}.gif`;
    } else if (this.isSpeaking) {
      // Prioritize mouth movement loop when speaking audio
      targetSrc = `avatars/${this.activeId}-talking.gif`;
    } else if (this.isTalking) {
      // Show thinking/channeling loop when generating reply
      targetSrc = `avatars/${this.activeId}-thinking.gif`;
    }

    if (targetSrc === this._lastTargetSrc) {
      return;
    }
    this._lastTargetSrc = targetSrc;

    const fullSrc = targetSrc + `?v=${CACHE_BUSTER}`;
    const token = ++this._loadToken;

    // Preload image in memory to prevent white flashes, fallback to PNG on error
    const img = new Image();
    img.src = fullSrc;
    img.onload = () => {
      if (token === this._loadToken && this.avatarEl) {
        this.avatarEl.src = fullSrc;
      }
    };
    img.onerror = () => {
      // Fallback cascade: if custom emotion/state GIF is missing, check state fallback
      let fallbackSrc = `avatars/${this.activeId}.png`;
      if (this.emotion && this.emotion !== "idle") {
        if (this.isSpeaking) {
          fallbackSrc = `avatars/${this.activeId}-talking.gif`;
        } else if (this.isTalking) {
          fallbackSrc = `avatars/${this.activeId}-thinking.gif`;
        }
      }

      // Check if we are already displaying the fallback to avoid loops
      if (this.avatarEl && !this.avatarEl.src.includes(fallbackSrc) && fallbackSrc !== targetSrc) {
        const fbImg = new Image();
        fbImg.src = fallbackSrc + `?v=${CACHE_BUSTER}`;
        fbImg.onload = () => {
          if (token === this._loadToken && this.avatarEl) {
            this.avatarEl.src = fallbackSrc + `?v=${CACHE_BUSTER}`;
          }
        };
        fbImg.onerror = () => {
          // Absolute fallback to base PNG
          const baseSrc = `avatars/${this.activeId}.png`;
          if (token === this._loadToken && this.avatarEl && !this.avatarEl.src.includes(baseSrc)) {
            this.avatarEl.src = baseSrc + `?v=${CACHE_BUSTER}`;
          }
        };
      } else if (this.avatarEl) {
        // Base fallback
        const baseSrc = `avatars/${this.activeId}.png`;
        if (token === this._loadToken && !this.avatarEl.src.includes(baseSrc)) {
          this.avatarEl.src = baseSrc + `?v=${CACHE_BUSTER}`;
        }
      }
    };
  }
}

// Expose to window so app.js can call it cleanly
window.avatarManager = new AvatarManager();


