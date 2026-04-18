// Phia YouTube popup — tab switching + API key save
(function () {
  // ── Tab switching ──────────────────────────────────────────────────────────
  const tabs = document.querySelectorAll(".tab");
  const panels = document.querySelectorAll(".panel");

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const targetId = tab.getAttribute("aria-controls");

      tabs.forEach((t) => {
        t.classList.remove("tab--active");
        t.setAttribute("aria-selected", "false");
      });
      panels.forEach((p) => {
        p.classList.remove("panel--active");
        p.hidden = true;
      });

      tab.classList.add("tab--active");
      tab.setAttribute("aria-selected", "true");
      const target = document.getElementById(targetId);
      if (target) {
        target.classList.add("panel--active");
        target.hidden = false;
      }
    });
  });

  // ── Settings: load saved key ───────────────────────────────────────────────
  const apiKeyInput = document.getElementById("api-key");
  const saveBtn = document.getElementById("save-key");
  const saveStatus = document.getElementById("save-status");

  self.Phia.storage.getSettings().then((settings) => {
    if (settings.geminiApiKey) {
      apiKeyInput.value = settings.geminiApiKey;
    }
  });

  // ── Settings: save key ────────────────────────────────────────────────────
  saveBtn.addEventListener("click", () => {
    const key = apiKeyInput.value.trim();
    self.Phia.storage
      .setSettings({ geminiApiKey: key || null })
      .then(() => {
        saveStatus.textContent = "Saved.";
        saveStatus.className = "save-status save-status--ok";
        setTimeout(() => {
          saveStatus.textContent = "";
          saveStatus.className = "save-status";
        }, 2000);
      })
      .catch((err) => {
        saveStatus.textContent = "Error: " + err.message;
        saveStatus.className = "save-status save-status--err";
      });
  });
})();
