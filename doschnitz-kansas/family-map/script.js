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
  window.__debugMap = map;
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png", {
    maxZoom: 15,
    subdomains: "abcd",
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO"
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
  // Remembers where you left off in each person's story, so closing a card
  // and clicking that name again picks up where you were instead of
  // resetting to the top every time.
  const lastIndexByBranch = { A:-1, B:-1, C:-1 };

  const modalEl = document.getElementById("modal");
  const modal = MapCore.createModal(modalEl);
  const legendNoteEl = document.getElementById("legend-note");
  const insetPanelEl = document.getElementById("inset-panel");
  const ottomarPhotoEl = document.getElementById("ottomar-photo-panel");
  const sidepanelEl = document.getElementById("sidepanel");

  document.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.classList.contains("is-active")) {
        // Tapping the already-open name again closes it back up -- the
        // only way to reach the other two names on mobile, since they're
        // hidden while a branch is chosen (see branch-chosen CSS).
        collapseAccordion();
      } else {
        selectBranch(btn.dataset.branch);
      }
    });
  });

  // Every bounds-fitting map move (fitBounds/flyToBounds) needs to reserve
  // screen space for the sidebar overlay, or the eastern/bottom edge of
  // whatever's being fitted silently ends up hidden underneath it — worse
  // at narrower windows, where the sidebar is a bigger fraction of the
  // total width. Leaflet's own container size doesn't know about the
  // sidebar since it's a separate fixed-position overlay, not a resize of
  // the map div itself.
  function mapPadding() {
    const isMobile = window.matchMedia("(max-width: 720px)").matches;
    if (isMobile) {
      return { paddingTopLeft: [10, 60], paddingBottomRight: [10, window.innerHeight * 0.42 + 10] };
    }
    const sidebarWidth = Math.min(360, window.innerWidth * 0.92);
    return { paddingTopLeft: [10, 60], paddingBottomRight: [sidebarWidth + 16, 10] };
  }

  function selectBranch(branch) {
    currentBranch = branch;
    // Resume where this branch was last left, rather than always resetting
    // to the top of the list.
    currentIndex = lastIndexByBranch[branch];
    countyLocked[branch] = countyLocked[branch] || false;
    document.querySelectorAll(".tab").forEach(b => {
      const active = b.dataset.branch === branch;
      b.classList.toggle("is-active", active);
      b.setAttribute("aria-selected", active ? "true" : "false");
      b.setAttribute("aria-expanded", active ? "true" : "false");
    });
    document.querySelectorAll(".tab-group").forEach(g => {
      g.classList.toggle("is-active", g.dataset.branch === branch);
    });
    // On a short mobile viewport, the title/intro text and the two inactive
    // tab buttons were all still competing for the same ~42vh sidepanel
    // space as the active accordion, squeezing its event list down to
    // almost nothing (a few px tall, its items rendered off-screen with no
    // way to reach them). This class lets mobile CSS hide everything but
    // the active tab once a branch is actually chosen, matching the room
    // desktop always had. No effect on desktop, which has full-height room
    // for all of this at once.
    sidepanelEl.classList.add("branch-chosen");
    renderEventList();
    renderMarkers();
    hideInset();
    clearSecondary();
    modal.close();

    // Item 20: Ottomar's photo cutout — appears on selecting his tab, fades
    // out as soon as an event in his story is actually opened (see goToIndex).
    ottomarPhotoEl.classList.toggle("is-visible", branch === "C");

    // Scroll the remembered position into view (if any) so it's visible
    // the moment the list expands, not just highlighted off-screen.
    if (currentIndex >= 0) {
      const activeItem = document.querySelector(`.event-list[data-branch="${branch}"] .event-item.is-current`);
      activeItem && activeItem.scrollIntoView({ block: "nearest" });
    }

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
      map.flyToBounds(group.getBounds().pad(0.5), { duration: 1.1, ...mapPadding() });
      hideLegend();
    }
  }

  // Collapses the accordion entirely — back to three flat names, none
  // expanded — so picking a different person starts from a clean state
  // rather than leaving the previous person's list open underneath them.
  // The remembered position (lastIndexByBranch) is untouched by this, so
  // reopening the same name later resumes rather than restarting.
  function collapseAccordion() {
    document.querySelectorAll(".tab-group").forEach(g => g.classList.remove("is-active"));
    document.querySelectorAll(".tab").forEach(b => {
      b.classList.remove("is-active");
      b.setAttribute("aria-selected", "false");
      b.setAttribute("aria-expanded", "false");
    });
    sidepanelEl.classList.remove("branch-chosen");
  }

  const DOC = "../shared/documents/";
  const BRANCH_FURTHER_READING = {
    A: [{ label: "Dr. Johann Gottlob Bock (1804-1855)", url: DOC + "Dr_Johann_Gottlob_Bock_V20.pdf" }],
    B: [
      { label: "Research Note: Robert Bock", url: DOC + "Notes_on_Robert_Bock_v12.pdf" },
      { label: "The Rochester Circle of Robert Bock", url: DOC + "Robert_Bock_Rochester_Circle_FINAL.pdf" },
    ],
    C: [{ label: "Playing the Long Game: Bock Settlement and Land Acquisition in Smith County, Kansas, 1872–1921", url: DOC + "Playing_the_Long_Game__Bock_Settlement_and_Land_Acquisition_copy.pdf" }],
  };

  function renderEventList() {
    document.querySelectorAll(".event-list").forEach(el => {
      if (el.dataset.branch !== currentBranch) el.innerHTML = "";
    });
    const eventListEl = document.querySelector(`.event-list[data-branch="${currentBranch}"]`);
    eventListEl.innerHTML = "";
    byBranch[currentBranch].forEach((c, i) => {
      const btn = document.createElement("button");
      const isVisited = i < currentIndex;
      const isCurrent = i === currentIndex;
      btn.className = "event-item" + (isCurrent ? " is-current" : "") + (isVisited ? " is-visited" : "");
      const check = isVisited ? `<span class="ev-check" aria-hidden="true">✓</span>` : "";
      btn.innerHTML = `${check}<span class="ev-year">${c.date.match(/\d{4}/) ? c.date.match(/\d{4}/)[0] : c.date}</span>${c.tagline} — ${c.place}`;
      btn.addEventListener("click", () => goToIndex(i));
      eventListEl.appendChild(btn);
    });

    const readings = BRANCH_FURTHER_READING[currentBranch];
    if (readings && readings.length) {
      const block = document.createElement("div");
      block.className = "branch-further-reading";
      const items = readings.map(r => `<li><a href="${r.url}" target="_blank" rel="noopener">${r.label}</a></li>`).join("");
      block.innerHTML = `<div class="bfr-label">Further reading</div><ul>${items}</ul>`;
      eventListEl.appendChild(block);
    }
  }

  // Item 18: every labeled pin shows its place name beside it. Default is
  // "left" (away from the sidebar and the docked card, which both live on
  // the right), flipping to "right" only when the pin sits close enough to
  // the left edge that a left-hand label would run off-screen.
  function labelDirectionFor(lat, lng) {
    const pt = map.latLngToContainerPoint([lat, lng]);
    return pt.x < 160 ? "right" : "left";
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
      // Only the pin actually being viewed right now gets a label. Labeling
      // every pin regardless of zoom is what caused illegible overlapping
      // text at wide/zoomed-out views where several pins sit close together.
      if (state === "current") {
        const dir = labelDirectionFor(c.lat, c.lng);
        m.bindTooltip(c.place, { permanent: true, direction: dir, className: "pin-label", offset: dir === "right" ? [8,0] : [-8,0] });
      }
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
      const isCurrentGroup = group.some(g => g._i === currentIndex);
      if (isCurrentGroup) {
        const dir = labelDirectionFor(group[0].lat, group[0].lng);
        m.bindTooltip(group[0].place, { permanent: true, direction: dir, className: "pin-label", offset: dir === "right" ? [10,0] : [-10,0] });
      }
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
    // journey — nobody in the story physically went there. Same for any
    // card explicitly flagged noJourney: the automatic distance trigger has
    // no notion of *who* made a given trip, so cards where the branch's own
    // subject didn't personally travel (e.g. Rudy's death — Emil went, not
    // Ottomar) need an explicit override rather than relying on distance alone.
    if (nextCard.insetOnly || nextCard.noJourney || bCards[idx].noJourney) { goToIndex(nextIdx); return; }

    const origin = nextCard.embarkPoint || lastRealCard(bCards, idx);
    if (!origin) { goToIndex(nextIdx); return; }

    const miles = haversineMiles(origin.lat, origin.lng, nextCard.lat, nextCard.lng);
    if (miles < JOURNEY_MILES_THRESHOLD) { goToIndex(nextIdx); return; }

    modal.close();
    animateJourney(origin, nextCard, () => goToIndex(nextIdx));
  }

  let settleTimer = null;
  function repositionWhenSettled(card) {
    const handler = () => {
      clearTimeout(settleTimer);
      // Interrupting an in-progress flyTo (e.g. a tab switch's animation
      // still finishing when a card opens) fires its own early moveend
      // before the real target is reached — debounce so we act on the
      // last one in a burst, not the first.
      settleTimer = setTimeout(() => {
        map.off("moveend", handler);
        renderMarkers();
        positionModal(card);
      }, 80);
    };
    map.on("moveend", handler);
  }

  // ---------------- PLSS section-grid overlay (Site 1, Site 2, White Rock) ----------------
  // No real PLSS shapefile is available offline, so the grid is constructed
  // from standard survey geometry (1-mile-square sections, standard
  // boustrophedon numbering) anchored to the BLM-verified coordinates
  // already on file for these three tracts. This is an approximation for
  // map placement, not a survey-grade claim -- same caveat the design doc
  // already applies to the coordinates themselves.
  const SECTION_ROWCOL = {
    6:[1,1],5:[1,2],4:[1,3],3:[1,4],2:[1,5],1:[1,6],
    7:[2,1],8:[2,2],9:[2,3],10:[2,4],11:[2,5],12:[2,6],
    18:[3,1],17:[3,2],16:[3,3],15:[3,4],14:[3,5],13:[3,6],
    19:[4,1],20:[4,2],21:[4,3],22:[4,4],23:[4,5],24:[4,6],
    30:[5,1],29:[5,2],28:[5,3],27:[5,4],26:[5,5],25:[5,6],
    31:[6,1],32:[6,2],33:[6,3],34:[6,4],35:[6,5],36:[6,6],
  };

  function buildTownship(refSectionNum, refSW) {
    const [row, col] = SECTION_ROWCOL[refSectionNum];
    const mileLat = 1 / 69.0;
    const mileLng = 1 / (69.172 * Math.cos(refSW.lat * Math.PI / 180));
    const twpNWlat = refSW.lat + row * mileLat;
    const twpNWlng = refSW.lng - (col - 1) * mileLng;
    const sections = {};
    Object.keys(SECTION_ROWCOL).forEach(numStr => {
      const num = +numStr;
      const [r, c] = SECTION_ROWCOL[num];
      const nwLat = twpNWlat - (r - 1) * mileLat;
      const nwLng = twpNWlng + (c - 1) * mileLng;
      const seLat = nwLat - mileLat;
      const seLng = nwLng + mileLng;
      sections[num] = { sw: [seLat, nwLng], ne: [nwLat, seLng], mileLat, mileLng };
    });
    return sections;
  }

  // Anchored to Site 2 (SW¼ Sec. 3) — Site 1 (Sec. 10) sits in the same township.
  const websterTwp = buildTownship(3, { lat: 39.72987 - 0.25 / 69.0, lng: -98.55744 - 0.25 / (69.172 * Math.cos(39.73 * Math.PI/180)) });
  // Anchored to White Rock (Sec. 36) — its own separate township.
  const whiterockTwp = buildTownship(36, { lat: 39.83692 - 0.25 / 69.0, lng: -98.50954 - 0.25 / (69.172 * Math.cos(39.84 * Math.PI/180)) });

  function quarterBounds(sec, quarter) {
    const midLat = (sec.sw[0] + sec.ne[0]) / 2;
    const midLng = (sec.sw[1] + sec.ne[1]) / 2;
    if (quarter === "NE") return [[midLat, midLng], sec.ne];
    if (quarter === "SW") return [sec.sw, [midLat, midLng]];
    if (quarter === "halfNEhalfSE") {
      // S½NE¼ and N½SE¼ combined (White Rock's actual legal description)
      return [[sec.sw[0], midLng], sec.ne];
    }
    return [sec.sw, sec.ne];
  }

  let sectionGridLayer = L.layerGroup();
  let secondaryGridLayer = L.layerGroup();
  const plssCaveatEl = document.getElementById("plss-caveat");

  function drawSectionGrid(layer, twp, highlightNum, quarter, townshipName) {
    layer.clearLayers();
    Object.keys(twp).forEach(numStr => {
      const num = +numStr;
      const sec = twp[num];
      const isHighlight = num === highlightNum;
      L.rectangle([sec.sw, sec.ne], {
        color: isHighlight ? "#9C4B33" : "#8A7A55",
        weight: isHighlight ? 2 : 0.8,
        fillOpacity: 0,
        opacity: isHighlight ? 0.9 : 0.45,
        interactive: false
      }).addTo(layer);
    });
    if (highlightNum && twp[highlightNum]) {
      L.rectangle(quarterBounds(twp[highlightNum], quarter), {
        color: "#9C4B33", weight: 1.5, fillOpacity: 0.22, fillColor: "#9C4B33", interactive: false
      }).addTo(layer);
    }
    if (townshipName) {
      // Township name in block capitals, placed along the grid's top edge —
      // enough to answer "what am I looking at" without adding real clutter,
      // since it's just one static label, not a name per section.
      const nw = twp[1].ne; // NE-most section's NE corner ~= township's own NE corner
      const se = twp[31].sw; // SW-most section's SW corner ~= township's own SW corner
      const topCenterLat = nw[0];
      const centerLng = (nw[1] + se[1]) / 2;
      L.marker([topCenterLat, centerLng], {
        icon: L.divIcon({ className: "", html: `<div class="twp-label">${townshipName}</div>`, iconSize: [1,1] }),
        interactive: false
      }).addTo(layer);
    }
    layer.addTo(map);
    if (plssCaveatEl) plssCaveatEl.classList.add("is-visible");
  }
  function hideSectionGrid(layer) {
    layer.clearLayers();
    if (!sectionGridLayer.getLayers().length && !secondaryGridLayer.getLayers().length && plssCaveatEl) {
      plssCaveatEl.classList.remove("is-visible");
    }
  }

  function plssTargetForCard(card) {
    if (card.id === "B8") return { twp: websterTwp, section: 10, quarter: "NE", zoom: 13.4, name: "WEBSTER TOWNSHIP" };
    if (card.site === "site2") return { twp: websterTwp, section: 3, quarter: "SW", zoom: 13.4, name: "WEBSTER TOWNSHIP" };
    return null;
  }

  function goToIndex(i) {
    currentIndex = i;
    lastIndexByBranch[currentBranch] = i;
    const card = byBranch[currentBranch][i];
    ottomarPhotoEl.classList.remove("is-visible");
    renderMarkers();
    renderEventList();
    moveMapFor(card);
    clearSecondary();
    if (card.secondaryPin) showSecondary(card.secondaryPin);
    openModal(card);
    positionModal(card);
    repositionWhenSettled(card);
  }

  // For the PLSS section-grid cards specifically: centering the map exactly
  // on the pin means the docked card (which docks immediately beside it)
  // ends up covering whatever's directly next to the highlighted section --
  // on a 6-wide township grid, that's most of what's worth seeing. Shifting
  // the map's actual center point (not just widening the gap to the panel)
  // means there's genuinely more of the township visible on the side the
  // panel docks on, not just the same amount of grid pushed further away.
  function shiftedCenter(lat, lng, zoom, dxPixels) {
    const pt = map.project([lat, lng], zoom);
    return map.unproject([pt.x + dxPixels, pt.y], zoom);
  }

  function moveMapFor(card) {
    if (card.insetOnly) {
      showInset(card);
      return;
    }
    hideInset();
    const plss = plssTargetForCard(card);
    if (!plss) hideSectionGrid(sectionGridLayer);

    if (plss) {
      countyLocked[currentBranch] = true;
      if (card.countyZoom) showLegend("Zoomed to Smith County, Kansas — includes Kirwin and Smith Centre for context.");
      const isMobile = window.matchMedia("(max-width: 720px)").matches;
      const target = isMobile ? [card.lat, card.lng] : shiftedCenter(card.lat, card.lng, plss.zoom, 210);
      map.flyTo(target, plss.zoom, { duration: 1.1 });
      drawSectionGrid(sectionGridLayer, plss.twp, plss.section, plss.quarter, plss.name);
    } else if (card.countyZoom) {
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
      // Item 25: any Germany-based event (not just Branch A) gets a
      // Thuringia-level zoom instead of a flat continental view, so cities
      // can be labeled more precisely.
      const inGermany = card.lat > 47 && card.lat < 55 && card.lng > 5 && card.lng < 16;
      // Item 26: once Branch C's story reaches U.S. soil but hasn't yet
      // triggered the county-zoom lock, zoom to Kansas state level rather
      // than staying at the wide regional/continental view -- from here on
      // the remaining events cluster closely together.
      const inKansas = card.lat > 36.9 && card.lat < 40.1 && card.lng > -102.1 && card.lng < -94.6;
      if (card.route) {
        map.flyTo([card.lat, card.lng], 3.4, { duration: 1.2 });
      } else if (inGermany) {
        map.flyTo([card.lat, card.lng], 7.6, { duration: 1.1 });
      } else if (inKansas) {
        map.flyTo([card.lat, card.lng], 6.4, { duration: 1.1 });
      } else {
        map.flyTo([card.lat, card.lng], 5.5, { duration: 1.2 });
      }
    }
  }

  function showSecondary(sp) {
    secondaryLayer = L.marker([sp.lat, sp.lng], { icon: secondaryIcon() })
      .bindTooltip(sp.name, { permanent: true, direction: "right", className: "pin-label", offset: [8,0] })
      .addTo(map);
    // White Rock's secondary pin also gets the section-grid treatment,
    // per its own township (T2S R11W, separate from Webster Township).
    if (Math.abs(sp.lat - 39.83692) < 0.001 && Math.abs(sp.lng - (-98.50954)) < 0.001) {
      drawSectionGrid(secondaryGridLayer, whiterockTwp, 36, "halfNEhalfSE", "WHITE ROCK TOWNSHIP");
    }
  }
  function clearSecondary() {
    if (secondaryLayer) { map.removeLayer(secondaryLayer); secondaryLayer = null; }
    hideSectionGrid(secondaryGridLayer);
  }

  function showInset(card) {
    insetPanelEl.classList.add("is-visible");
    insetPanelEl.setAttribute("aria-hidden", "false");
    if (!insetMap) {
      insetMap = L.map("inset-map", { zoomControl:false, attributionControl:false, dragging:false, scrollWheelZoom:false, doubleClickZoom:false, boxZoom:false, keyboard:false });
      L.tileLayer("https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png", { maxZoom: 9, subdomains: "abcd" }).addTo(insetMap);
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
    map.flyToBounds(bounds.pad(0.35), { duration: 0.8, ...mapPadding() });

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

  const modalPanelEl = document.querySelector(".modal-panel");
  const modalStemEl = document.getElementById("modal-stem");
  const MOBILE_QUERY = "(max-width: 720px)";

  function positionModal(card) {
    const isMobile = window.matchMedia(MOBILE_QUERY).matches;
    document.body.classList.toggle("modal-open-mobile", isMobile);

    if (isMobile || card.insetOnly) {
      modalPanelEl.classList.remove("is-docked");
      modalPanelEl.style.left = modalPanelEl.style.top = modalPanelEl.style.width = "";
      modalStemEl.classList.remove("is-visible");
      return;
    }

    const pt = map.latLngToContainerPoint([card.lat, card.lng]);
    const sidebarWidth = Math.min(360, window.innerWidth * 0.92);
    const usableRight = window.innerWidth - sidebarWidth;
    const gap = 26;
    const margin = 12;
    const panelWidth = Math.min(420, window.innerWidth * 0.4, usableRight - margin * 2);
    const estHeight = modalPanelEl.offsetHeight > 40 ? modalPanelEl.offsetHeight : Math.min(window.innerHeight * 0.8, 560);

    const roomRight = usableRight - margin - (pt.x + gap);
    const roomLeft = (pt.x - gap) - margin;
    let left, top, stemSide;

    if (roomRight >= panelWidth) {
      left = pt.x + gap;
      stemSide = "right";
      top = Math.max(16, Math.min(pt.y - estHeight * 0.4, window.innerHeight - estHeight - 16));
    } else if (roomLeft >= panelWidth) {
      left = pt.x - gap - panelWidth;
      stemSide = "left";
      top = Math.max(16, Math.min(pt.y - estHeight * 0.4, window.innerHeight - estHeight - 16));
    } else {
      // Neither side has room without landing back on top of the pin —
      // dock above or below it instead, centered horizontally within the
      // usable (non-sidebar) width.
      left = Math.max(margin, Math.min((usableRight - panelWidth) / 2, usableRight - panelWidth - margin));
      const roomBelow = window.innerHeight - margin - (pt.y + gap);
      if (roomBelow >= estHeight) {
        top = pt.y + gap;
        stemSide = "top";
      } else {
        top = Math.max(margin, pt.y - gap - estHeight);
        stemSide = "bottom";
      }
    }

    modalPanelEl.classList.add("is-docked");
    modalPanelEl.style.left = left + "px";
    modalPanelEl.style.top = top + "px";
    modalPanelEl.style.width = panelWidth + "px";

    modalStemEl.style.borderLeft = modalStemEl.style.borderRight = modalStemEl.style.borderTop = modalStemEl.style.borderBottom = "none";
    if (stemSide === "right") {
      modalStemEl.style.left = (left - 9) + "px";
      modalStemEl.style.top = Math.max(top + 24, Math.min(pt.y, top + estHeight - 24)) + "px";
      modalStemEl.style.borderTop = "9px solid transparent";
      modalStemEl.style.borderBottom = "9px solid transparent";
      modalStemEl.style.borderRight = "9px solid var(--white-ish)";
    } else if (stemSide === "left") {
      modalStemEl.style.left = (left + panelWidth) + "px";
      modalStemEl.style.top = Math.max(top + 24, Math.min(pt.y, top + estHeight - 24)) + "px";
      modalStemEl.style.borderTop = "9px solid transparent";
      modalStemEl.style.borderBottom = "9px solid transparent";
      modalStemEl.style.borderLeft = "9px solid var(--white-ish)";
    } else if (stemSide === "top") {
      modalStemEl.style.top = (top - 9) + "px";
      modalStemEl.style.left = Math.max(left + 24, Math.min(pt.x, left + panelWidth - 24)) + "px";
      modalStemEl.style.borderLeft = "9px solid transparent";
      modalStemEl.style.borderRight = "9px solid transparent";
      modalStemEl.style.borderBottom = "9px solid var(--white-ish)";
    } else {
      modalStemEl.style.top = (top + estHeight) + "px";
      modalStemEl.style.left = Math.max(left + 24, Math.min(pt.x, left + panelWidth - 24)) + "px";
      modalStemEl.style.borderLeft = "9px solid transparent";
      modalStemEl.style.borderRight = "9px solid transparent";
      modalStemEl.style.borderTop = "9px solid var(--white-ish)";
    }
    modalStemEl.classList.add("is-visible");

    // The height above is an estimate made before the card's actual content
    // is laid out — longer cards can run taller than guessed. Re-measure
    // after render and nudge back on-screen if it overflowed the bottom.
    requestAnimationFrame(() => {
      const rect = modalPanelEl.getBoundingClientRect();
      const overflow = rect.bottom - (window.innerHeight - 16);
      if (overflow > 0) {
        const newTop = Math.max(16, rect.top - overflow);
        modalPanelEl.style.top = newTop + "px";
        if (stemSide === "right" || stemSide === "left") {
          modalStemEl.style.top = Math.max(newTop + 24, Math.min(pt.y, newTop + rect.height - 24)) + "px";
        }
      }
    });
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
    descEl.innerHTML = boldFirstPlaceMention(applyCrossRefs(card.desc, card.crossRefs), card.place);
    document.getElementById("modal-full").innerHTML = card.full || "";

    const furtherEl = document.getElementById("modal-further");
    if (card.furtherReading && card.furtherReading.length) {
      const label = card.furtherReadingLabel || "Further reading:";
      furtherEl.innerHTML = label + " " + card.furtherReading.map(f => `<a href="${f.url}" target="_blank" rel="noopener">${f.label}</a>`).join(" · ");
      furtherEl.style.display = "";
    } else {
      furtherEl.innerHTML = "";
      furtherEl.style.display = "none";
    }

    // Note: card.flags (sourcing caveats, open questions) is intentionally
    // not rendered — it's editorial/research metadata, not visitor-facing content.

    document.getElementById("modal-source").textContent = "Source: " + card.source;
    document.getElementById("modal-closing").textContent = card.closingLine || "";

    const idx = byBranch[currentBranch].findIndex(c => c.id === card.id);
    document.getElementById("modal-progress").textContent = `${idx + 1} of ${byBranch[currentBranch].length}`;
    document.querySelector("[data-modal-back]").disabled = idx === 0;
    document.querySelector("[data-modal-next]").disabled = idx === byBranch[currentBranch].length - 1;

    // Item 8/10: every card is a fixed height, always. If content doesn't
    // fit, it just scrolls -- a non-interactive fade hints there's more
    // below. No expand/collapse state, so no transition timing or
    // repositioning-after-resize to get wrong.
    const scrollEl = document.querySelector(".modal-scroll");
    // A new card always starts scrolled to the top -- without this, a
    // scroll position carried over from a previous card could land a
    // freshly-opened card mid-paragraph.
    scrollEl.scrollTop = 0;
    requestAnimationFrame(updateScrollFade);

    modal.setHandlers({
      next: () => { if (idx < byBranch[currentBranch].length - 1) attemptAdvance(idx); },
      back: () => { if (idx > 0) goToIndex(idx - 1); },
      onClose: () => {
        clearSecondary(); hideInset(); renderMarkers();
        modalStemEl.classList.remove("is-visible");
        document.body.classList.remove("modal-open-mobile");
      },
      onUserClose: () => collapseAccordion()
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

  // Bold the first mention of the card's active location in the rendered
  // text, so a reader whose eyes are on the modal (not the map/sidebar)
  // doesn't lose track of where the current event is happening. Tries the
  // full place label first, then falls back to simpler pieces of it (for
  // route-style or compound labels like "Hamburg → New York" or
  // "Site 2 — SW¼ Sec. 3, Webster Twp.") since the prose usually names the
  // place more plainly than the label does. If nothing matches, the text
  // is left unchanged rather than guessing wrong.
  function boldFirstPlaceMention(html, placeLabel) {
    if (!placeLabel) return html;
    const candidates = [placeLabel];
    placeLabel.split("→").forEach(p => p.trim() && candidates.push(p.trim()));
    placeLabel.split("—").forEach(p => p.trim() && candidates.push(p.trim()));
    placeLabel.split(",").forEach(p => p.trim() && candidates.push(p.trim()));
    for (const cand of candidates) {
      if (!cand || cand.length < 3) continue;
      const idx = html.indexOf(cand);
      if (idx === -1) continue;
      // Don't bold inside an existing tag's attributes/content boundary.
      const before = html.slice(0, idx);
      if ((before.match(/</g) || []).length !== (before.match(/>/g) || []).length) continue;
      return before + "<strong>" + cand + "</strong>" + html.slice(idx + cand.length);
    }
    return html;
  }

  function updateScrollFade() {
    const scrollEl = document.querySelector(".modal-scroll");
    const overflowing = scrollEl.scrollHeight > scrollEl.clientHeight + 2;
    scrollEl.classList.toggle("has-overflow", overflowing);
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
    // The scroll-fade hint's overflow check (run once right after this card
    // opens) measures the container's height too early if it runs before
    // this image has actually loaded -- an unloaded image contributes ~0 to
    // scrollHeight, so a card that only overflows *because of* its image
    // could wrongly be judged as fitting. Re-check once the image is
    // actually in the layout, not just once the tag exists in the DOM.
    const imgEl = el.querySelector("img");
    if (imgEl) {
      if (imgEl.complete) updateScrollFade();
      else imgEl.addEventListener("load", updateScrollFade, { once: true });
    }
  }

  // ---------------- Opening view (before any tab is chosen) ----------------
  // California coast to Germany, one continuous frame — no branch selected yet.
  map.fitBounds([[27, -124], [56, 16]], mapPadding());
  showLegend("Germany's borders shown here follow the 1885 German Empire — Germany did not exist as a unified state until 1871. Click a name in the panel to begin that person's story.");
})();
