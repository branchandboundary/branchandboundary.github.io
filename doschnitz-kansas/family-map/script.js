(async function () {
  "use strict";

  const cards = await fetch("data/cards.json").then(r => r.json());
  const byBranch = { A: [], B: [], C: [] };
  cards.forEach(c => byBranch[c.branch].push(c));

  const [usStates, germany, thuringia] = await Promise.all([
    fetch("data/us-states.json").then(r => r.json()),
    fetch("data/germany.json").then(r => r.json()),
    fetch("data/thuringia.json").then(r => r.json()),
  ]);

  // ---------------- Map setup ----------------
  const map = L.map("map", { zoomControl: true, attributionControl: true }).setView([42, -40], 3);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 15,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  // Opening-view orientation shading — real state/country outlines, modern
  // borders used as the best available proxy (see legend note re: 1885).
  const faintStates = L.geoJSON(usStates, {
    style: { color: "#8A7A55", weight: 0.6, fillOpacity: 0, opacity: 0.5 },
    interactive: false
  });
  const highlightStates = L.geoJSON(usStates, {
    filter: f => f.properties.name === "Kansas" || f.properties.name === "New York",
    style: { color: "#9C4B33", weight: 1.4, fillOpacity: 0.10, fillColor: "#9C4B33" },
    onEachFeature: (f, layer) => layer.bindTooltip(f.properties.name)
  });
  const germanyLayer = L.geoJSON(germany, {
    style: { color: "#5F6B4F", weight: 1.4, fillOpacity: 0.12, fillColor: "#5F6B4F" },
    onEachFeature: (f, layer) => layer.bindTooltip("Germany (1885 imperial borders)")
  });
  const thuringiaLayer = L.geoJSON(thuringia, {
    style: { color: "#5F6B4F", weight: 1.4, fillOpacity: 0.12, fillColor: "#5F6B4F" },
    onEachFeature: (f, layer) => layer.bindTooltip("Thuringia — approximating the Schwarzburg-Rudolstadt principality")
  });
  const openingShapes = L.layerGroup([faintStates, highlightStates, germanyLayer]).addTo(map);

  // Webster Township approximation (~6mi square), centered between Site 1 / Site 2
  const websterTownship = L.rectangle(
    [[39.696, -98.591],[39.783, -98.461]],
    { color: "#5F6B4F", weight: 1, dashArray: "3 3", fillOpacity: 0.06, interactive:false }
  );

  let secondaryLayer = null;
  let insetMap = null;

  // ---------------- Progress-ring / guided markers ----------------
  const markerRegistry = {}; // card.id -> L.marker
  let siteMarkers = {}; // siteKey -> L.marker
  let branchLayer = L.layerGroup().addTo(map);

  function siteGroups(branchCards) {
    const groups = {};
    branchCards.forEach((c, i) => {
      if (!c.site) return;
      (groups[c.site] = groups[c.site] || []).push({ ...c, _i: i });
    });
    return groups;
  }

  function guidedIcon(state) {
    const cls = "pin-guided" + (state === "first" ? " is-first" : state === "current" ? " is-current" : state === "visited" ? " is-visited" : "");
    return L.divIcon({ className: "", html: `<div class="${cls}"></div>`, iconSize: [20,20], iconAnchor: [10,16] });
  }
  function siteIcon(filled, total) {
    const ring = MapCore.progressRingSVG(filled, total, 34);
    return L.divIcon({
      className: "", iconSize: [34,34], iconAnchor: [17,17],
      html: `<div class="pin-site-wrap"><div class="ring">${ring}</div><div class="core"></div></div>`
    });
  }
  function secondaryIcon() {
    return L.divIcon({ className: "", html: `<div class="pin-secondary"></div>`, iconSize: [10,10], iconAnchor: [5,5] });
  }

  // ---------------- State ----------------
  let currentBranch = null;
  let currentIndex = -1;
  const countyLocked = { A:false, B:false, C:false };

  const modalEl = document.getElementById("modal");
  const modal = MapCore.createModal(modalEl);
  const eventListEl = document.getElementById("event-list");
  const legendNoteEl = document.getElementById("legend-note");
  const insetPanelEl = document.getElementById("inset-panel");

  document.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => selectBranch(btn.dataset.branch));
  });

  function selectBranch(branch) {
    currentBranch = branch;
    currentIndex = -1;
    countyLocked[branch] = countyLocked[branch] || false;
    document.querySelectorAll(".tab").forEach(b => {
      const active = b.dataset.branch === branch;
      b.classList.toggle("is-active", active);
      b.setAttribute("aria-selected", active ? "true" : "false");
    });
    renderEventList();
    renderMarkers();
    hideInset();
    clearSecondary();
    modal.close();

    // Regional framing
    const bCards = byBranch[branch];
    openingShapes.eachLayer(l => map.removeLayer(l));
    if (map.hasLayer(thuringiaLayer)) map.removeLayer(thuringiaLayer);
    if (branch === "A") {
      thuringiaLayer.addTo(map);
      map.flyTo([50.75, 11.2], 7.4, { duration: 1.1 });
      showLegend("Principality boundaries are approximate — hand-fitted to the modern Thuringia state outline, the closest available proxy for the pre-1871 Schwarzburg-Rudolstadt principality.");
    } else {
      const group = L.featureGroup(bCards.map(c => L.marker([c.lat, c.lng])));
      map.flyToBounds(group.getBounds().pad(0.5), { duration: 1.1 });
      hideLegend();
    }
  }

  function renderEventList() {
    eventListEl.innerHTML = "";
    byBranch[currentBranch].forEach((c, i) => {
      const btn = document.createElement("button");
      btn.className = "event-item" + (i === currentIndex ? " is-current" : "");
      btn.innerHTML = `<span class="ev-year">${c.date.match(/\d{4}/) ? c.date.match(/\d{4}/)[0] : c.date}</span>${c.tagline} — ${c.place}`;
      btn.addEventListener("click", () => goToIndex(i));
      eventListEl.appendChild(btn);
    });
  }

  function renderMarkers() {
    branchLayer.clearLayers();
    siteMarkers = {};
    const bCards = byBranch[currentBranch];
    const groups = siteGroups(bCards);

    // ungrouped (individual) pins
    bCards.forEach((c, i) => {
      if (c.site || c.insetOnly) return;
      let state = "upcoming";
      if (i === currentIndex) state = "current";
      else if (i < currentIndex) state = "visited";
      else if (currentIndex === -1 && c.isFirst) state = "first";
      const m = L.marker([c.lat, c.lng], { icon: guidedIcon(state) });
      m.on("click", () => goToIndex(i));
      m.addTo(branchLayer);
      markerRegistry[c.id] = m;
    });

    // grouped (site) pins with progress rings
    Object.keys(groups).forEach(key => {
      const group = groups[key];
      const filled = group.filter(g => g._i <= currentIndex).length;
      const m = L.marker([group[0].lat, group[0].lng], { icon: siteIcon(filled, group.length) });
      m.on("click", () => {
        const nextUnvisited = group.find(g => g._i > currentIndex);
        goToIndex(nextUnvisited ? nextUnvisited._i : group[group.length - 1]._i);
      });
      m.addTo(branchLayer);
      siteMarkers[key] = m;
    });

    // county-locked township shading
    if (countyLocked[currentBranch]) {
      websterTownship.addTo(branchLayer);
    }
  }

  function attemptAdvance(idx) {
    const bCards = byBranch[currentBranch];
    const nextIdx = idx + 1;
    const nextCard = bCards[nextIdx];

    // Paperwork-only destinations (e.g. B10, Washington) never trigger a
    // journey — nobody in the story physically went there.
    if (nextCard.insetOnly) { goToIndex(nextIdx); return; }

    const origin = nextCard.embarkPoint || lastRealCard(bCards, idx);
    if (!origin) { goToIndex(nextIdx); return; }

    const miles = haversineMiles(origin.lat, origin.lng, nextCard.lat, nextCard.lng);
    if (miles < JOURNEY_MILES_THRESHOLD) { goToIndex(nextIdx); return; }

    modal.close();
    animateJourney(origin, nextCard, () => goToIndex(nextIdx));
  }

  function goToIndex(i) {
    currentIndex = i;
    const card = byBranch[currentBranch][i];
    renderMarkers();
    renderEventList();
    moveMapFor(card);
    clearSecondary();
    if (card.secondaryPin) showSecondary(card.secondaryPin);
    openModal(card);
  }

  function moveMapFor(card) {
    if (card.insetOnly) {
      showInset(card);
      return;
    }
    hideInset();
    if (card.countyZoom) {
      countyLocked[currentBranch] = true;
      map.flyTo([39.745, -98.63], 10.1, { duration: 1.3 });
      showLegend("Zoomed to Smith County, Kansas — includes Kirwin and Smith Centre for context.");
    } else if (card.countyWiden) {
      map.flyTo([39.72, -98.85], 9.2, { duration: 1.2 });
    } else if (countyLocked[currentBranch]) {
      map.flyTo([card.lat, card.lng], 10.3, { duration: 1.0 });
    } else if (currentBranch === "A") {
      map.flyTo([card.lat, card.lng], 8, { duration: 1.0 });
    } else {
      map.flyTo([card.lat, card.lng], card.route ? 3.4 : 5.5, { duration: 1.2 });
    }
  }

  function showSecondary(sp) {
    secondaryLayer = L.marker([sp.lat, sp.lng], { icon: secondaryIcon() })
      .bindTooltip(sp.name, { permanent: true, direction: "right", className: "pin-label", offset: [8,0] })
      .addTo(map);
  }
  function clearSecondary() {
    if (secondaryLayer) { map.removeLayer(secondaryLayer); secondaryLayer = null; }
  }

  function showInset(card) {
    insetPanelEl.classList.add("is-visible");
    insetPanelEl.setAttribute("aria-hidden", "false");
    if (!insetMap) {
      insetMap = L.map("inset-map", { zoomControl:false, attributionControl:false, dragging:false, scrollWheelZoom:false, doubleClickZoom:false, boxZoom:false, keyboard:false });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 9 }).addTo(insetMap);
    }
    insetMap.setView([card.lat, card.lng], 5);
    setTimeout(() => insetMap.invalidateSize(), 260);
    L.marker([card.lat, card.lng]).addTo(insetMap);
  }
  function hideInset() {
    insetPanelEl.classList.remove("is-visible");
    insetPanelEl.setAttribute("aria-hidden", "true");
  }

  function showLegend(text) { legendNoteEl.textContent = text; legendNoteEl.classList.add("is-visible"); }
  function hideLegend() { legendNoteEl.classList.remove("is-visible"); }

  // ---------------- Journey animation (ship / rail between distant events) ----------------
  const JOURNEY_MILES_THRESHOLD = 200;
  const journeyOverlayEl = document.getElementById("journey-overlay");
  const journeyIconEl = document.getElementById("journey-icon");
  const journeyTextEl = document.getElementById("journey-text");
  let journeyLine = null, journeyMarker = null, journeyRAF = null, journeyCancelled = false;

  function haversineMiles(lat1, lng1, lat2, lng2) {
    const R = 3958.8; // miles
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  // Walk backward from index i (inclusive) to find the last card representing
  // a real physical location — skips paperwork-only cards (e.g. B10, Washington),
  // since nobody in the story actually traveled there.
  function lastRealCard(branchCards, i) {
    for (let k = i; k >= 0; k--) {
      if (!branchCards[k].insetOnly) return branchCards[k];
    }
    return null;
  }

  // Simple heuristic: if the two points fall on opposite sides of the mid-
  // Atlantic (~30°W), treat it as a sea crossing; otherwise overland/rail.
  // Good enough for this story's actual geography (Europe <-> Kansas/NY);
  // a future "car"/"plane" mode would slot in here the same way.
  function journeyMode(origin, dest) {
    const oceanSide = lng => lng < -30;
    return oceanSide(origin.lng) !== oceanSide(dest.lng) ? "ship" : "rail";
  }

  function captionLabel(point) { return point.arrivalLabel || point.place; }

  function animateJourney(origin, dest, onDone) {
    const mode = journeyMode(origin, dest);
    const miles = Math.round(haversineMiles(origin.lat, origin.lng, dest.lat, dest.lng));
    const icon = mode === "ship" ? "⛵" : "🚂";
    const label = mode === "ship" ? "Transatlantic crossing" : "Overland journey";

    journeyIconEl.textContent = icon;
    journeyTextEl.textContent = `${label} — ${captionLabel(origin)} to ${captionLabel(dest)} (~${miles.toLocaleString()} mi)`;
    journeyOverlayEl.classList.add("is-active");
    journeyOverlayEl.setAttribute("aria-hidden", "false");
    document.body.classList.add("journey-active");

    const bounds = L.latLngBounds([origin.lat, origin.lng], [dest.lat, dest.lng]);
    map.flyToBounds(bounds.pad(0.35), { duration: 0.8 });

    journeyLine = L.polyline([[origin.lat, origin.lng], [dest.lat, dest.lng]], {
      color: "#5F6B4F", weight: 2, dashArray: "6 8", opacity: 0.85
    }).addTo(map);

    journeyMarker = L.marker([origin.lat, origin.lng], {
      icon: L.divIcon({ className: "", html: `<div class="journey-marker">${icon}</div>`, iconSize: [22,22], iconAnchor: [11,11] })
    }).addTo(map);

    journeyCancelled = false;
    const duration = 2200;
    const start = performance.now() + 800; // let the flyToBounds settle first
    const prefersReduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    function finish() {
      if (journeyRAF) cancelAnimationFrame(journeyRAF);
      journeyRAF = null;
      if (journeyLine) { map.removeLayer(journeyLine); journeyLine = null; }
      if (journeyMarker) { map.removeLayer(journeyMarker); journeyMarker = null; }
      journeyOverlayEl.classList.remove("is-active");
      journeyOverlayEl.setAttribute("aria-hidden", "true");
      document.body.classList.remove("journey-active");
      journeyOverlayEl.removeEventListener("click", skipHandler);
      onDone();
    }

    function skipHandler() {
      if (journeyCancelled) return;
      journeyCancelled = true;
      finish();
    }
    journeyOverlayEl.addEventListener("click", skipHandler);

    if (prefersReduced) {
      // Respect reduced-motion: show the line/caption briefly, skip the animated travel.
      setTimeout(() => { if (!journeyCancelled) finish(); }, 700);
      return;
    }

    function step(now) {
      if (journeyCancelled) return;
      const t = Math.min(1, Math.max(0, (now - start) / duration));
      const lat = origin.lat + (dest.lat - origin.lat) * t;
      const lng = origin.lng + (dest.lng - origin.lng) * t;
      journeyMarker.setLatLng([lat, lng]);
      if (t >= 1) { finish(); return; }
      journeyRAF = requestAnimationFrame(step);
    }
    journeyRAF = requestAnimationFrame(step);
  }

  // ---------------- Modal rendering ----------------
  let carouselIndex = 0;
  function openModal(card) {
    carouselIndex = 0;
    renderCarousel(card);
    document.getElementById("modal-date").textContent = card.date;
    document.getElementById("modal-place").textContent = card.place;
    document.getElementById("modal-title").textContent = card.tagline;

    const descEl = document.getElementById("modal-desc");
    descEl.innerHTML = applyCrossRefs(card.desc, card.crossRefs);
    document.getElementById("modal-full").innerHTML = card.full || "";

    const furtherEl = document.getElementById("modal-further");
    if (card.furtherReading && card.furtherReading.length) {
      furtherEl.innerHTML = "Further reading: " + card.furtherReading.map(f => `<a href="${f.url}" target="_blank" rel="noopener">${f.label}</a>`).join(" · ");
    } else furtherEl.innerHTML = "";

    // Note: card.flags (sourcing caveats, open questions) is intentionally
    // not rendered — it's editorial/research metadata, not visitor-facing content.

    document.getElementById("modal-source").textContent = "Source: " + card.source;
    document.getElementById("modal-closing").textContent = card.closingLine || "";

    const idx = byBranch[currentBranch].findIndex(c => c.id === card.id);
    document.getElementById("modal-progress").textContent = `${idx + 1} of ${byBranch[currentBranch].length}`;
    document.querySelector("[data-modal-back]").disabled = idx === 0;
    document.querySelector("[data-modal-next]").disabled = idx === byBranch[currentBranch].length - 1;

    modal.setHandlers({
      next: () => { if (idx < byBranch[currentBranch].length - 1) attemptAdvance(idx); },
      back: () => { if (idx > 0) goToIndex(idx - 1); },
      onClose: () => { clearSecondary(); hideInset(); renderMarkers(); }
    });
    modal.open();
    MapCore.initCrossRefPopovers(descEl, (targetBranch) => selectBranch(targetBranch));
  }

  function applyCrossRefs(text, crossRefs) {
    if (!crossRefs) return text;
    let out = text;
    crossRefs.forEach(cr => {
      const re = new RegExp(`\\b${cr.name}\\b`);
      out = out.replace(re, `<span class="crossref" tabindex="0" data-branch="${cr.branch}" data-text="${cr.text.replace(/"/g,'&quot;')}">${cr.name}</span>`);
    });
    return out;
  }

  function renderCarousel(card) {
    const el = document.getElementById("modal-carousel");
    if (!card.images || !card.images.length) { el.innerHTML = ""; return; }
    const img = card.images[carouselIndex];
    el.innerHTML = `
      ${card.images.length > 1 ? '<button class="carousel-btn carousel-prev" aria-label="Previous image">‹</button>' : ""}
      <img src="${img.file}" alt="${img.caption}">
      ${card.images.length > 1 ? '<button class="carousel-btn carousel-next" aria-label="Next image">›</button>' : ""}
      <div class="carousel-caption">${img.caption}${img.ai ? ' <span class="ai-badge">· AI-enhanced (ChatGPT)</span>' : ""}</div>
    `;
    if (card.images.length > 1) {
      el.querySelector(".carousel-prev").addEventListener("click", () => { carouselIndex = (carouselIndex - 1 + card.images.length) % card.images.length; renderCarousel(card); });
      el.querySelector(".carousel-next").addEventListener("click", () => { carouselIndex = (carouselIndex + 1) % card.images.length; renderCarousel(card); });
    }
  }

  // ---------------- Opening view (before any tab is chosen) ----------------
  // California coast to Germany, one continuous frame — no branch selected yet.
  map.fitBounds([[27, -124], [56, 16]]);
  showLegend("Germany's borders shown here follow the 1885 German Empire — Germany did not exist as a unified state until 1871. Click a name in the panel to begin that person's story.");
})();
