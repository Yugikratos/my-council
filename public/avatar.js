// My Council — desktop avatar visuals and logic
// This logic is kept isolated to respect the frontend/backend contract.

class AvatarManager {
  constructor() {
    this.avatarEl = document.getElementById("avatar-image");
    this.containerEl = document.getElementById("avatar-container");
    this.isTalking = false;
  }

  // Switches the portrait image
  switchPersona(id) {
    if (!this.avatarEl) return;
    
    // Add a quick fade out effect
    this.avatarEl.style.opacity = 0;
    
    setTimeout(() => {
      this.avatarEl.src = `avatars/${id}.png`;
      this.avatarEl.alt = id;
      // Fade back in
      this.avatarEl.style.opacity = 1;
    }, 150);
  }

  // Toggles the talking/generating animation state
  setTalking(isTalking) {
    this.isTalking = isTalking;
    if (!this.containerEl) return;
    
    if (isTalking) {
      this.containerEl.classList.add("talking");
    } else {
      this.containerEl.classList.remove("talking");
    }
  }
}

// Expose to window so app.js can call it cleanly
window.avatarManager = new AvatarManager();
