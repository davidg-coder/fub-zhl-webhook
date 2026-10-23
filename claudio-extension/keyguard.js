// Runs at document_start, before FUB's own scripts, so these window
// capture listeners fire first. Keys typed inside Claudio's panel never
// reach FUB's single-key shortcuts (e.g. "e" opening the email composer).
// The browser still types the character; content.js gets Enter through
// window.__claudioOnEnter (content scripts share one isolated world).
(() => {
  const fromClaudio = (e) => e.target && e.target.id === "claudio-root";
  for (const type of ["keydown", "keypress", "keyup"]) {
    window.addEventListener(
      type,
      (e) => {
        if (!fromClaudio(e)) return;
        e.stopImmediatePropagation();
        if (type === "keydown" && e.key === "Enter" && !e.isComposing && window.__claudioOnEnter) {
          window.__claudioOnEnter();
        }
      },
      true
    );
  }
})();
