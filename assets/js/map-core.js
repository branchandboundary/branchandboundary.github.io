/* ============================================================
   map-core.js — shared primitives for story-map projects.
   Generic on purpose: no family-specific data lives here.
   ============================================================ */

const MapCore = (() => {

  /** Build an SVG progress ring: `filled` of `total` segments lit. */
  function progressRingSVG(filled, total, size = 34) {
    const r = size / 2 - 3;
    const c = size / 2;
    const circumference = 2 * Math.PI * r;
    const segGap = total > 1 ? circumference / total * 0.12 : 0;
    const segLen = total > 1 ? circumference / total - segGap : circumference;
    let segs = "";
    for (let i = 0; i < total; i++) {
      const offset = (segLen + segGap) * i;
      const lit = i < filled;
      segs += `<circle cx="${c}" cy="${c}" r="${r}" fill="none"
        stroke="${lit ? "var(--wheat-light,#D9B65D)" : "rgba(255,255,255,0.35)"}"
        stroke-width="3" stroke-linecap="round"
        stroke-dasharray="${segLen} ${circumference - segLen}"
        stroke-dashoffset="${-offset}"
        transform="rotate(-90 ${c} ${c})" />`;
    }
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">${segs}</svg>`;
  }

  /** Modal controller: focus-trapping, Escape-to-close, Next/Back wiring. */
  function createModal(rootEl) {
    let onNext = null, onBack = null, onClose = null, onUserClose = null;
    const closeBtn = rootEl.querySelector("[data-modal-close]");
    const nextBtn = rootEl.querySelector("[data-modal-next]");
    const backBtn = rootEl.querySelector("[data-modal-back]");

    function open() {
      rootEl.classList.add("is-open");
      rootEl.setAttribute("aria-hidden", "false");
      closeBtn && closeBtn.focus();
      document.addEventListener("keydown", onKeydown);
    }
    function close() {
      rootEl.classList.remove("is-open");
      rootEl.setAttribute("aria-hidden", "true");
      document.removeEventListener("keydown", onKeydown);
      onClose && onClose();
    }
    function userClose() {
      close();
      onUserClose && onUserClose();
    }
    function onKeydown(e) {
      if (e.key === "Escape") userClose();
      if (e.key === "ArrowRight") onNext && onNext();
      if (e.key === "ArrowLeft") onBack && onBack();
      if (e.key === "Tab") {
        const focusables = rootEl.querySelectorAll('button, a[href], [tabindex]:not([tabindex="-1"])');
        if (!focusables.length) return;
        const first = focusables[0], last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    closeBtn && closeBtn.addEventListener("click", userClose);
    nextBtn && nextBtn.addEventListener("click", () => onNext && onNext());
    backBtn && backBtn.addEventListener("click", () => onBack && onBack());
    rootEl.addEventListener("click", (e) => { if (e.target === rootEl) userClose(); });

    return {
      open, close,
      setHandlers({ next, back, onClose: closeCb, onUserClose: userCloseCb }) {
        onNext = next; onBack = back; onClose = closeCb; onUserClose = userCloseCb;
      }
    };
  }

  /** Small dismiss-on-click-outside popover for cross-reference hypertext. */
  function initCrossRefPopovers(container, onJump) {
    container.querySelectorAll(".crossref").forEach(el => {
      let pop = null;
      function show() {
        hideAll();
        pop = document.createElement("span");
        pop.className = "crossref-popover";
        pop.setAttribute("role", "tooltip");
        pop.innerHTML = `<span>${el.dataset.text}</span><br><a href="#" class="crossref-jump">Go to their story →</a>`;
        el.appendChild(pop);
        // keep popover on-screen (avoid flush edges, per spec)
        requestAnimationFrame(() => {
          const rect = pop.getBoundingClientRect();
          if (rect.right > window.innerWidth - 12) pop.style.left = "auto", pop.style.right = "0";
          if (rect.left < 12) pop.style.left = "0";
        });
        pop.querySelector(".crossref-jump").addEventListener("click", (e) => {
          e.preventDefault();
          onJump(el.dataset.branch);
          hideAll();
        });
      }
      function hideAll() {
        document.querySelectorAll(".crossref-popover").forEach(p => p.remove());
      }
      el.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); show(); });
      el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); show(); } });
    });
    document.addEventListener("click", () => {
      document.querySelectorAll(".crossref-popover").forEach(p => p.remove());
    });
  }

  return { progressRingSVG, createModal, initCrossRefPopovers };
})();
