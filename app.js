/*
 * Bolt vs Uber – prisjämförelse. All logik körs i webbläsaren:
 *   Geokodning  – Nominatim (OpenStreetMap)
 *   Rutt        – OSRM:s publika demoserver, med fågelvägs-fallback
 *   Priser      – pricing.js (riktvärden, justerbara och sparas lokalt)
 */
(function () {
  "use strict";

  const P = window.Pricing;

  const NOMINATIM_URL = "https://nominatim.openstreetmap.org";
  const OSRM_URL = "https://router.project-osrm.org";
  const FETCH_TIMEOUT_MS = 9000;
  const AUTOCOMPLETE_DEBOUNCE_MS = 550; // Nominatim vill ha max ~1 anrop/s
  const STORAGE_OVERRIDES = "boltvsuber.tariffOverrides.v1";
  const STORAGE_CITY = "boltvsuber.city.v1";

  const els = {};
  [
    "city", "from", "to", "locate", "compare", "status",
    "results", "route-summary", "verdict", "price-rows",
    "surge-bolt", "surge-bolt-out", "surge-uber", "surge-uber-out",
    "open-bolt", "open-uber", "map", "tariff-tables", "reset-tariffs",
    "from-suggestions", "to-suggestions",
  ].forEach(function (id) {
    els[id.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); })] =
      document.getElementById(id);
  });

  const state = {
    city: "stockholm",
    overrides: {},
    tariffs: null,
    from: null,   // {lat, lon, label}
    to: null,
    route: null,  // {km, minutes, geometry, approx}
    surge: { bolt: 1, uber: 1 },
    map: null,
    mapLayer: null,
  };

  /* ---------- Hjälpfunktioner ---------- */

  function fmtKr(n) {
    return Math.round(n).toLocaleString("sv-SE") + " kr";
  }

  function fmtKm(km) {
    return km.toLocaleString("sv-SE", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " km";
  }

  function fmtSurge(x) {
    return x.toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "×";
  }

  async function fetchJson(url) {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }

  function storageGet(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  }

  function storageSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (_) { /* t.ex. privat läge – justeringar gäller då bara sessionen */ }
  }

  /* ---------- Geokodning ---------- */

  // Kortar ner Nominatims långa "display_name" till något läsbart.
  function shortName(displayName) {
    const parts = String(displayName).split(", ")
      .filter(function (p) { return !/^\d{3} ?\d{2}$/.test(p) && p !== "Sverige"; });
    return parts.slice(0, 3).join(", ");
  }

  async function geocode(query, limit) {
    const center = state.tariffs[state.city].center;
    const viewbox = [center.lon - 0.45, center.lat + 0.3, center.lon + 0.45, center.lat - 0.3].join(",");
    const params = new URLSearchParams({
      q: query,
      format: "jsonv2",
      limit: String(limit),
      countrycodes: "se",
      "accept-language": "sv",
      viewbox: viewbox,
      bounded: "0",
    });
    const hits = await fetchJson(NOMINATIM_URL + "/search?" + params);
    return hits
      .map(function (h) {
        return { lat: Number(h.lat), lon: Number(h.lon), label: shortName(h.display_name) };
      })
      .filter(function (h) { return Number.isFinite(h.lat) && Number.isFinite(h.lon); });
  }

  async function reverseGeocode(lat, lon) {
    const params = new URLSearchParams({ lat: String(lat), lon: String(lon), format: "jsonv2" });
    const hit = await fetchJson(NOMINATIM_URL + "/reverse?" + params);
    return hit && hit.display_name ? shortName(hit.display_name) : null;
  }

  /* ---------- Adressfält med förslag ---------- */

  function setupAddressField(key, input, list) {
    let timer = null;

    input.addEventListener("input", function () {
      state[key] = null; // ändrad text ⇒ tidigare valda koordinater gäller inte
      clearTimeout(timer);
      const query = input.value.trim();
      if (query.length < 3) { hideList(); return; }
      timer = setTimeout(function () { search(query); }, AUTOCOMPLETE_DEBOUNCE_MS);
    });

    async function search(query) {
      let hits;
      try {
        hits = await geocode(query, 5);
      } catch (_) {
        hideList();
        return;
      }
      if (input.value.trim() !== query) return; // användaren hann skriva mer
      renderList(hits);
    }

    function renderList(hits) {
      list.textContent = "";
      if (!hits.length) { hideList(); return; }
      hits.forEach(function (hit) {
        const item = document.createElement("li");
        item.setAttribute("role", "option");
        item.textContent = hit.label;
        item.addEventListener("pointerdown", function (event) {
          event.preventDefault(); // hinder blur innan valet registrerats
          state[key] = hit;
          input.value = hit.label;
          hideList();
        });
        list.appendChild(item);
      });
      list.hidden = false;
    }

    function hideList() {
      list.hidden = true;
      list.textContent = "";
    }

    document.addEventListener("pointerdown", function (event) {
      if (!list.hidden && !list.contains(event.target) && event.target !== input) hideList();
    });
  }

  /* ---------- Rutt ---------- */

  async function osrmRoute(from, to) {
    const coords = from.lon + "," + from.lat + ";" + to.lon + "," + to.lat;
    const data = await fetchJson(
      OSRM_URL + "/route/v1/driving/" + coords + "?overview=full&geometries=geojson&alternatives=false"
    );
    if (data.code !== "Ok" || !data.routes || !data.routes.length) throw new Error("route");
    const route = data.routes[0];
    return {
      km: route.distance / 1000,
      minutes: (route.duration / 60) * P.OSRM_TRAFFIC_FACTOR,
      geometry: route.geometry,
      approx: false,
    };
  }

  async function resolveField(key, input, emptyMessage) {
    if (state[key]) return state[key];
    const query = input.value.trim();
    if (query.length < 2) throw new Error(emptyMessage);
    let hits;
    try {
      hits = await geocode(query, 1);
    } catch (_) {
      throw new Error("Adresstjänsten kunde inte nås – kontrollera uppkopplingen och försök igen.");
    }
    if (!hits.length) throw new Error("Hittade ingen adress för ”" + query + "”.");
    state[key] = hits[0];
    input.value = hits[0].label;
    return hits[0];
  }

  async function compare() {
    setStatus("");
    els.compare.disabled = true;
    try {
      setStatus("Söker adresser …");
      const from = await resolveField("from", els.from, "Ange var resan startar.");
      const to = await resolveField("to", els.to, "Ange vart du ska.");

      setStatus("Beräknar rutt …");
      let route;
      try {
        route = await osrmRoute(from, to);
      } catch (_) {
        const fallback = P.fallbackRoute(from, to);
        route = { km: fallback.km, minutes: fallback.minutes, geometry: null, approx: true };
      }

      state.route = route;
      setStatus("");
      renderAll(true);
    } catch (err) {
      setStatus(err && err.message ? err.message : "Något gick fel – försök igen.", true);
    } finally {
      els.compare.disabled = false;
    }
  }

  function setStatus(message, isError) {
    els.status.textContent = message;
    els.status.classList.toggle("error", Boolean(isError));
  }

  /* ---------- Rendering ---------- */

  function renderAll(scrollToResults) {
    renderRouteSummary();
    renderResults();
    renderDeepLinks();
    renderMap();
    els.results.hidden = false;
    if (scrollToResults) els.results.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderRouteSummary() {
    const route = state.route;
    els.routeSummary.textContent = "";

    const trip = document.createElement("div");
    trip.className = "trip";
    trip.textContent = state.from.label + " → " + state.to.label;

    const meta = document.createElement("div");
    meta.className = "trip-meta";
    meta.textContent = fmtKm(route.km) + " · ca " + Math.round(route.minutes) + " min · taxa: " +
      state.tariffs[state.city].label;

    els.routeSummary.append(trip, meta);

    if (route.approx) {
      const warning = document.createElement("div");
      warning.className = "approx-note";
      warning.textContent = "⚠️ Ruttjänsten kunde inte nås – sträckan är uppskattad från fågelvägen.";
      els.routeSummary.appendChild(warning);
    }
  }

  function renderResults() {
    const route = state.route;
    if (!route) return;
    const rows = P.compareTiers(state.tariffs[state.city], route.km, route.minutes, state.surge);

    els.priceRows.textContent = "";
    rows.forEach(function (row) {
      const tr = document.createElement("tr");

      const tierCell = document.createElement("td");
      tierCell.className = "tier";
      const tierName = document.createElement("div");
      tierName.textContent = row.label;
      const tierSub = document.createElement("div");
      tierSub.className = "tier-sub";
      const names = row.bolt.name === row.uber.name
        ? "" : row.bolt.name + " / " + row.uber.name;
      tierSub.textContent = row.tier === "xl"
        ? (names ? names + " · " : "") + "upp till 6"
        : names;
      tierCell.append(tierName, tierSub);

      const boltCell = document.createElement("td");
      boltCell.className = "price bolt" + (row.winner === "bolt" ? " win" : "");
      boltCell.textContent = fmtKr(row.bolt.price);

      const uberCell = document.createElement("td");
      uberCell.className = "price uber" + (row.winner === "uber" ? " win" : "");
      uberCell.textContent = fmtKr(row.uber.price);

      const diffCell = document.createElement("td");
      diffCell.className = "diff " + row.winner;
      diffCell.textContent = row.winner === "tie"
        ? "≈ lika"
        : (row.winner === "bolt" ? "Bolt" : "Uber") + " −" + fmtKr(Math.abs(row.diff));

      tr.append(tierCell, boltCell, uberCell, diffCell);
      els.priceRows.appendChild(tr);
    });

    if (rows.length) renderVerdict(rows[0]);
  }

  function renderVerdict(standardRow) {
    els.verdict.className = "verdict " + standardRow.winner;
    if (standardRow.winner === "tie") {
      els.verdict.textContent = "🤝 Jämnt lopp för Standard – ca " + fmtKr(standardRow.bolt.price) + " med båda.";
    } else {
      const winner = standardRow.winner === "bolt" ? standardRow.bolt : standardRow.uber;
      const loser = standardRow.winner === "bolt" ? standardRow.uber : standardRow.bolt;
      els.verdict.textContent =
        "⚡ " + winner.name + " ser billigast ut för Standard: ca " + fmtKr(winner.price) +
        " (" + fmtKr(Math.abs(standardRow.diff)) + " mindre än " + loser.name + ").";
    }
  }

  function renderDeepLinks() {
    const from = state.from;
    const to = state.to;

    const uberParams = [
      ["action", "setPickup"],
      ["pickup[latitude]", from.lat], ["pickup[longitude]", from.lon], ["pickup[nickname]", from.label],
      ["dropoff[latitude]", to.lat], ["dropoff[longitude]", to.lon], ["dropoff[nickname]", to.label],
    ];
    els.openUber.href = "https://m.uber.com/ul/?" + uberParams
      .map(function (pair) { return encodeURIComponent(pair[0]) + "=" + encodeURIComponent(pair[1]); })
      .join("&");

    const boltParams = new URLSearchParams({
      pickup_lat: String(from.lat),
      pickup_lng: String(from.lon),
      destination_lat: String(to.lat),
      destination_lng: String(to.lon),
    });
    els.openBolt.href = "bolt://action/rideRequest?" + boltParams;
  }

  function renderMap() {
    if (!window.L) return; // karta är trevligt men inte nödvändigt
    const from = state.from;
    const to = state.to;
    const route = state.route;

    els.map.hidden = false;
    if (!state.map) {
      state.map = L.map("map", { zoomControl: false });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "© OpenStreetMap-bidragsgivare",
      }).addTo(state.map);
    }
    if (state.mapLayer) state.mapLayer.remove();

    const group = L.featureGroup();
    const markerStyle = { radius: 7, weight: 2, color: "#ffffff", fillOpacity: 1 };
    L.circleMarker([from.lat, from.lon], Object.assign({ fillColor: "#4f46e5" }, markerStyle)).addTo(group);
    L.circleMarker([to.lat, to.lon], Object.assign({ fillColor: "#16a34a" }, markerStyle)).addTo(group);

    const lineStyle = { color: "#4f46e5", weight: 4, opacity: 0.85 };
    if (route.geometry) {
      L.geoJSON(route.geometry, { style: lineStyle }).addTo(group);
    } else {
      L.polyline([[from.lat, from.lon], [to.lat, to.lon]],
        Object.assign({ dashArray: "6 8" }, lineStyle)).addTo(group);
    }

    group.addTo(state.map);
    state.mapLayer = group;
    requestAnimationFrame(function () {
      state.map.invalidateSize();
      state.map.fitBounds(group.getBounds().pad(0.2));
    });
  }

  /* ---------- Taxeredigerare ---------- */

  const TARIFF_FIELDS = [
    ["base", "Start"],
    ["perKm", "Kr/km"],
    ["perMin", "Kr/min"],
    ["minFare", "Lägsta"],
  ];

  function buildTariffEditor() {
    els.tariffTables.textContent = "";
    const city = state.tariffs[state.city];

    ["bolt", "uber"].forEach(function (serviceId) {
      const service = city.services[serviceId];

      const heading = document.createElement("h3");
      heading.className = "tariff-heading " + serviceId;
      heading.textContent = service.label + " – " + city.label;
      els.tariffTables.appendChild(heading);

      const table = document.createElement("table");
      table.className = "tariff-table";

      const head = table.createTHead().insertRow();
      [""].concat(TARIFF_FIELDS.map(function (f) { return f[1]; })).forEach(function (text) {
        const th = document.createElement("th");
        th.textContent = text;
        head.appendChild(th);
      });

      const body = table.createTBody();
      service.categories.forEach(function (category) {
        const tr = body.insertRow();
        const nameCell = tr.insertCell();
        nameCell.textContent = category.label;
        TARIFF_FIELDS.forEach(function (field) {
          const cell = tr.insertCell();
          const input = document.createElement("input");
          input.type = "number";
          input.min = "0";
          input.step = "0.1";
          input.inputMode = "decimal";
          input.value = String(category[field[0]]);
          input.dataset.service = serviceId;
          input.dataset.category = category.id;
          input.dataset.field = field[0];
          input.setAttribute("aria-label",
            service.label + " " + category.label + " " + field[1]);
          cell.appendChild(input);
        });
      });

      els.tariffTables.appendChild(table);
    });
  }

  function onTariffInput(event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.dataset.field) return;

    const cityId = state.city;
    const o = state.overrides;
    o[cityId] = o[cityId] || {};
    o[cityId][input.dataset.service] = o[cityId][input.dataset.service] || {};
    o[cityId][input.dataset.service][input.dataset.category] =
      o[cityId][input.dataset.service][input.dataset.category] || {};
    if (input.value.trim() === "") {
      // Tomt fält = tillbaka till standardvärdet, inte 0 kr.
      delete o[cityId][input.dataset.service][input.dataset.category][input.dataset.field];
    } else {
      o[cityId][input.dataset.service][input.dataset.category][input.dataset.field] = input.value;
    }

    storageSet(STORAGE_OVERRIDES, o);
    state.tariffs = P.mergeTariffs(P.DEFAULT_TARIFFS, o);
    if (state.route) {
      renderRouteSummary();
      renderResults();
    }
  }

  function resetTariffs() {
    state.overrides = {};
    storageSet(STORAGE_OVERRIDES, {});
    state.tariffs = P.mergeTariffs(P.DEFAULT_TARIFFS, {});
    buildTariffEditor();
    if (state.route) {
      renderRouteSummary();
      renderResults();
    }
  }

  /* ---------- Min position ---------- */

  function locate() {
    if (!navigator.geolocation) {
      setStatus("Din webbläsare saknar platstjänster.", true);
      return;
    }
    els.locate.disabled = true;
    setStatus("Hämtar din position …");
    navigator.geolocation.getCurrentPosition(
      async function (position) {
        const lat = position.coords.latitude;
        const lon = position.coords.longitude;
        let label = null;
        try { label = await reverseGeocode(lat, lon); } catch (_) { /* fallback nedan */ }
        state.from = { lat: lat, lon: lon, label: label || "Min position" };
        els.from.value = state.from.label;
        setStatus("");
        els.locate.disabled = false;
      },
      function () {
        setStatus("Kunde inte hämta din position – skriv adressen i stället.", true);
        els.locate.disabled = false;
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }

  /* ---------- Init ---------- */

  function init() {
    state.overrides = storageGet(STORAGE_OVERRIDES, {}) || {};
    state.tariffs = P.mergeTariffs(P.DEFAULT_TARIFFS, state.overrides);

    const savedCity = storageGet(STORAGE_CITY, "stockholm");
    state.city = Object.prototype.hasOwnProperty.call(state.tariffs, savedCity)
      ? savedCity : "stockholm";

    Object.keys(state.tariffs).forEach(function (cityId) {
      const option = document.createElement("option");
      option.value = cityId;
      option.textContent = state.tariffs[cityId].label;
      els.city.appendChild(option);
    });
    els.city.value = state.city;

    els.city.addEventListener("change", function () {
      state.city = els.city.value;
      storageSet(STORAGE_CITY, state.city);
      buildTariffEditor();
      if (state.route) {
        renderRouteSummary();
        renderResults();
      }
    });

    setupAddressField("from", els.from, els.fromSuggestions);
    setupAddressField("to", els.to, els.toSuggestions);

    document.getElementById("trip-form").addEventListener("submit", function (event) {
      event.preventDefault();
      compare();
    });
    els.locate.addEventListener("click", locate);

    els.surgeBolt.addEventListener("input", function () {
      state.surge.bolt = Number(els.surgeBolt.value);
      els.surgeBoltOut.textContent = fmtSurge(state.surge.bolt);
      renderResults();
    });
    els.surgeUber.addEventListener("input", function () {
      state.surge.uber = Number(els.surgeUber.value);
      els.surgeUberOut.textContent = fmtSurge(state.surge.uber);
      renderResults();
    });

    els.tariffTables.addEventListener("input", onTariffInput);
    els.resetTariffs.addEventListener("click", resetTariffs);

    buildTariffEditor();

    // Leaflet laddas asynkront – dyker den upp efter första jämförelsen
    // ritas kartan i efterhand.
    const leafletScript = document.getElementById("leaflet-js");
    if (!window.L && leafletScript) {
      leafletScript.addEventListener("load", function () {
        if (state.route) renderMap();
      });
    }

    // Testkrok: låter automatiska tester mata in en rutt utan nätverk.
    window.__test = {
      state: state,
      setRoute: function (opts) {
        state.from = {
          lat: opts.fromLat !== undefined ? opts.fromLat : 59.3428,
          lon: opts.fromLon !== undefined ? opts.fromLon : 18.0493,
          label: opts.fromLabel || "Odenplan, Vasastan, Stockholm",
        };
        state.to = {
          lat: opts.toLat !== undefined ? opts.toLat : 59.3201,
          lon: opts.toLon !== undefined ? opts.toLon : 18.0719,
          label: opts.toLabel || "Slussen, Södermalm, Stockholm",
        };
        state.route = {
          km: opts.km,
          minutes: opts.minutes,
          geometry: null,
          approx: Boolean(opts.approx),
        };
        els.from.value = state.from.label;
        els.to.value = state.to.label;
        renderAll(false);
      },
    };
  }

  init();
})();
