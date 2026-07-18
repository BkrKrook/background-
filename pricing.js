/*
 * Prismotor för Bolt vs Uber-jämförelsen.
 *
 * Ren beräkningslogik utan DOM-beroenden så att samma fil kan användas
 * både i webbläsaren (window.Pricing) och i Node-tester (module.exports).
 *
 * Taxorna är riktvärden per stad (listpriser utan rusningstillägg) och kan
 * justeras av användaren i appen. Formeln båda bolagen använder:
 *
 *   pris = max(minimipris, startavgift + kr/km × sträcka + kr/min × restid) × rusningsfaktor
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Pricing = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Fågelväg → verklig körsträcka i stadstrafik.
  const ROAD_FACTOR = 1.35;
  // Antagen snitthastighet när ruttjänsten inte kan nås.
  const CITY_SPEED_KMH = 26;
  // OSRM:s restider är optimistiska för stadskörning; skala upp något.
  const OSRM_TRAFFIC_FACTOR = 1.2;
  // Skillnader mindre än så här redovisas som "jämnt".
  const TIE_THRESHOLD_SEK = 3;

  const TIER_LABELS = {
    standard: "Standard",
    comfort: "Comfort",
    xl: "XL",
  };

  // Fält i en taxa som får skrivas över av användarens sparade justeringar.
  const NUMERIC_FIELDS = ["base", "perKm", "perMin", "minFare"];
  const MAX_FIELD_VALUE = 10000;

  const DEFAULT_TARIFFS = {
    stockholm: {
      label: "Stockholm",
      center: { lat: 59.3293, lon: 18.0686 },
      services: {
        bolt: {
          label: "Bolt",
          categories: [
            { id: "standard", tier: "standard", label: "Bolt", base: 25, perKm: 9.9, perMin: 2.9, minFare: 59 },
            { id: "comfort", tier: "comfort", label: "Comfort", base: 35, perKm: 12.5, perMin: 3.5, minFare: 79 },
            { id: "xl", tier: "xl", label: "XL", base: 45, perKm: 14.5, perMin: 4.2, minFare: 95 },
          ],
        },
        uber: {
          label: "Uber",
          categories: [
            { id: "standard", tier: "standard", label: "UberX", base: 29, perKm: 10.9, perMin: 3.25, minFare: 69 },
            { id: "comfort", tier: "comfort", label: "Comfort", base: 39, perKm: 13.5, perMin: 3.9, minFare: 89 },
            { id: "xl", tier: "xl", label: "UberXL", base: 49, perKm: 15.5, perMin: 4.5, minFare: 99 },
          ],
        },
      },
    },
    goteborg: {
      label: "Göteborg",
      center: { lat: 57.7089, lon: 11.9746 },
      services: {
        bolt: {
          label: "Bolt",
          categories: [
            { id: "standard", tier: "standard", label: "Bolt", base: 22, perKm: 9.0, perMin: 2.6, minFare: 55 },
            { id: "comfort", tier: "comfort", label: "Comfort", base: 30, perKm: 11.5, perMin: 3.2, minFare: 72 },
            { id: "xl", tier: "xl", label: "XL", base: 40, perKm: 13.5, perMin: 3.9, minFare: 89 },
          ],
        },
        uber: {
          label: "Uber",
          categories: [
            { id: "standard", tier: "standard", label: "UberX", base: 25, perKm: 9.9, perMin: 2.9, minFare: 62 },
            { id: "comfort", tier: "comfort", label: "Comfort", base: 35, perKm: 12.5, perMin: 3.5, minFare: 80 },
            { id: "xl", tier: "xl", label: "UberXL", base: 45, perKm: 14.5, perMin: 4.1, minFare: 92 },
          ],
        },
      },
    },
    malmo: {
      label: "Malmö",
      center: { lat: 55.605, lon: 13.0038 },
      services: {
        bolt: {
          label: "Bolt",
          categories: [
            { id: "standard", tier: "standard", label: "Bolt", base: 20, perKm: 8.7, perMin: 2.5, minFare: 52 },
            { id: "comfort", tier: "comfort", label: "Comfort", base: 28, perKm: 11.0, perMin: 3.1, minFare: 69 },
            { id: "xl", tier: "xl", label: "XL", base: 38, perKm: 13.0, perMin: 3.8, minFare: 85 },
          ],
        },
        uber: {
          label: "Uber",
          categories: [
            { id: "standard", tier: "standard", label: "UberX", base: 24, perKm: 9.5, perMin: 2.8, minFare: 59 },
            { id: "comfort", tier: "comfort", label: "Comfort", base: 33, perKm: 12.0, perMin: 3.4, minFare: 76 },
            { id: "xl", tier: "xl", label: "UberXL", base: 43, perKm: 14.0, perMin: 4.0, minFare: 89 },
          ],
        },
      },
    },
    uppsala: {
      label: "Uppsala",
      center: { lat: 59.8586, lon: 17.6389 },
      services: {
        bolt: {
          label: "Bolt",
          categories: [
            { id: "standard", tier: "standard", label: "Bolt", base: 22, perKm: 9.3, perMin: 2.7, minFare: 56 },
            { id: "comfort", tier: "comfort", label: "Comfort", base: 30, perKm: 11.6, perMin: 3.3, minFare: 73 },
            { id: "xl", tier: "xl", label: "XL", base: 40, perKm: 13.6, perMin: 3.9, minFare: 90 },
          ],
        },
        uber: {
          label: "Uber",
          categories: [
            { id: "standard", tier: "standard", label: "UberX", base: 26, perKm: 10.2, perMin: 3.0, minFare: 64 },
            { id: "comfort", tier: "comfort", label: "Comfort", base: 36, perKm: 12.8, perMin: 3.6, minFare: 82 },
            { id: "xl", tier: "xl", label: "UberXL", base: 46, perKm: 14.8, perMin: 4.2, minFare: 94 },
          ],
        },
      },
    },
  };

  function toNonNegativeNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  /**
   * Uppskattat pris i SEK (oavrundat) för en kategori.
   * @param {{base:number, perKm:number, perMin:number, minFare:number}} category
   */
  function estimateFare(category, km, minutes, surgeFactor) {
    const surge = Number.isFinite(surgeFactor) && surgeFactor > 0 ? surgeFactor : 1;
    const distanceKm = toNonNegativeNumber(km);
    const rideMinutes = toNonNegativeNumber(minutes);
    const metered =
      toNonNegativeNumber(category.base) +
      toNonNegativeNumber(category.perKm) * distanceKm +
      toNonNegativeNumber(category.perMin) * rideMinutes;
    return Math.max(toNonNegativeNumber(category.minFare), metered) * surge;
  }

  /**
   * Jämför Bolt och Uber nivå för nivå (standard/comfort/xl) för en stad.
   * @param {object} cityTariff  En stadspost ur DEFAULT_TARIFFS-strukturen.
   * @param {{bolt?:number, uber?:number}} [surge]  Rusningsfaktor per tjänst.
   * @returns {Array<{tier:string, label:string, bolt:object, uber:object, diff:number, winner:string}>}
   */
  function compareTiers(cityTariff, km, minutes, surge) {
    const surges = surge || {};
    return Object.keys(TIER_LABELS)
      .map(function (tier) {
        const bolt = cityTariff.services.bolt.categories.find(function (c) { return c.tier === tier; });
        const uber = cityTariff.services.uber.categories.find(function (c) { return c.tier === tier; });
        if (!bolt || !uber) return null;
        const boltPrice = estimateFare(bolt, km, minutes, surges.bolt);
        const uberPrice = estimateFare(uber, km, minutes, surges.uber);
        const diff = uberPrice - boltPrice;
        const winner = Math.abs(diff) < TIE_THRESHOLD_SEK ? "tie" : diff > 0 ? "bolt" : "uber";
        return {
          tier: tier,
          label: TIER_LABELS[tier],
          bolt: { name: bolt.label, price: boltPrice },
          uber: { name: uber.label, price: uberPrice },
          diff: diff,
          winner: winner,
        };
      })
      .filter(Boolean);
  }

  /**
   * Applicerar användarens sparade justeringar på standardtaxorna.
   * Endast kända städer/tjänster/kategorier och numeriska fält inom rimliga
   * gränser tas med — allt annat i overrides ignoreras tyst.
   * @returns {object} Ny taxestruktur; varken defaults eller overrides muteras.
   */
  function mergeTariffs(defaults, overrides) {
    const merged = JSON.parse(JSON.stringify(defaults));
    if (!overrides || typeof overrides !== "object") return merged;

    Object.keys(merged).forEach(function (cityId) {
      const cityOverride = overrides[cityId];
      if (!cityOverride || typeof cityOverride !== "object") return;
      Object.keys(merged[cityId].services).forEach(function (serviceId) {
        const serviceOverride = cityOverride[serviceId];
        if (!serviceOverride || typeof serviceOverride !== "object") return;
        merged[cityId].services[serviceId].categories.forEach(function (category) {
          const categoryOverride = serviceOverride[category.id];
          if (!categoryOverride || typeof categoryOverride !== "object") return;
          NUMERIC_FIELDS.forEach(function (field) {
            const raw = categoryOverride[field];
            // Number("") och Number(null) är 0 – tomma värden ska inte bli 0 kr.
            if (raw === null || raw === undefined ||
                (typeof raw === "string" && raw.trim() === "")) return;
            const value = Number(raw);
            if (Number.isFinite(value) && value >= 0 && value <= MAX_FIELD_VALUE) {
              category[field] = value;
            }
          });
        });
      });
    });
    return merged;
  }

  /** Fågelvägsavstånd i km mellan två koordinater. */
  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const toRad = function (deg) { return (deg * Math.PI) / 180; };
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  /**
   * Grov ruttuppskattning när ruttjänsten inte kan nås:
   * fågelväg × vägfaktor, restid från antagen snitthastighet.
   * @param {{lat:number, lon:number}} from
   * @param {{lat:number, lon:number}} to
   */
  function fallbackRoute(from, to) {
    const straightKm = haversineKm(from.lat, from.lon, to.lat, to.lon);
    const km = Math.max(0.4, straightKm * ROAD_FACTOR);
    const minutes = Math.max(4, (km / CITY_SPEED_KMH) * 60 + 2);
    return { km: km, minutes: minutes };
  }

  return {
    DEFAULT_TARIFFS: DEFAULT_TARIFFS,
    TIER_LABELS: TIER_LABELS,
    ROAD_FACTOR: ROAD_FACTOR,
    CITY_SPEED_KMH: CITY_SPEED_KMH,
    OSRM_TRAFFIC_FACTOR: OSRM_TRAFFIC_FACTOR,
    TIE_THRESHOLD_SEK: TIE_THRESHOLD_SEK,
    estimateFare: estimateFare,
    compareTiers: compareTiers,
    mergeTariffs: mergeTariffs,
    haversineKm: haversineKm,
    fallbackRoute: fallbackRoute,
  };
});
