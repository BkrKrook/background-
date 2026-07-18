/* Enhetstester för prismotorn. Kör med:  node test/pricing.test.cjs */
"use strict";

const Pricing = require("../pricing.js");

let passed = 0;
let failed = 0;

function check(name, condition) {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    console.error("✗ " + name);
  }
}

function checkClose(name, actual, expected, tolerance) {
  const ok = Math.abs(actual - expected) <= (tolerance === undefined ? 1e-9 : tolerance);
  if (!ok) console.error("  fick " + actual + ", väntade " + expected);
  check(name, ok);
}

/* ---------- estimateFare ---------- */

const uberX = { base: 29, perKm: 10.9, perMin: 3.25, minFare: 69 };

checkClose("grundformel: start + km + min", Pricing.estimateFare(uberX, 5, 12), 29 + 10.9 * 5 + 3.25 * 12);
checkClose("minimipris slår igenom på korta resor", Pricing.estimateFare(uberX, 0.5, 2), 69);
checkClose("rusningsfaktor multiplicerar totalen", Pricing.estimateFare(uberX, 5, 12, 1.5), (29 + 54.5 + 39) * 1.5);
checkClose("rusningsfaktor gäller även minimipriset", Pricing.estimateFare(uberX, 0.5, 2, 1.5), 69 * 1.5);
checkClose("ogiltig rusningsfaktor behandlas som 1", Pricing.estimateFare(uberX, 5, 12, NaN), 122.5);
checkClose("negativ sträcka räknas som 0", Pricing.estimateFare(uberX, -3, 0), 69);
checkClose("icke-numerisk indata kraschar inte", Pricing.estimateFare(uberX, "abc", null), 69);

/* ---------- compareTiers ---------- */

const stockholm = Pricing.DEFAULT_TARIFFS.stockholm;
const rows = Pricing.compareTiers(stockholm, 5, 12);

check("tre nivåer jämförs", rows.length === 3);
check("nivåerna kommer i ordning", rows.map(r => r.tier).join(",") === "standard,comfort,xl");
checkClose("Bolt standard: 25 + 9,9×5 + 2,9×12", rows[0].bolt.price, 25 + 49.5 + 34.8);
checkClose("UberX standard: 29 + 10,9×5 + 3,25×12", rows[0].uber.price, 122.5);
check("Bolt vinner standard med defaulttaxorna", rows[0].winner === "bolt");
checkClose("diff = uber − bolt", rows[0].diff, 122.5 - 109.3, 1e-9);
check("kategorinamn följer med", rows[0].bolt.name === "Bolt" && rows[0].uber.name === "UberX");

const evenCity = {
  services: {
    bolt: { label: "Bolt", categories: [{ id: "standard", tier: "standard", label: "Bolt", base: 30, perKm: 10, perMin: 3, minFare: 60 }] },
    uber: { label: "Uber", categories: [{ id: "standard", tier: "standard", label: "UberX", base: 31, perKm: 10, perMin: 3, minFare: 60 }] },
  },
};
check("skillnad under tröskeln blir oavgjort", Pricing.compareTiers(evenCity, 5, 10)[0].winner === "tie");
check("saknade nivåer hoppas över utan krasch", Pricing.compareTiers(evenCity, 5, 10).length === 1);

const surged = Pricing.compareTiers(stockholm, 5, 12, { uber: 2 });
check("rusning per tjänst kan slå om vinnaren åt andra hållet", surged[0].winner === "bolt" && surged[0].diff > rows[0].diff);
const boltSurged = Pricing.compareTiers(stockholm, 5, 12, { bolt: 2 });
check("rusning på Bolt gör Uber billigast", boltSurged[0].winner === "uber");

/* ---------- mergeTariffs ---------- */

const merged = Pricing.mergeTariffs(Pricing.DEFAULT_TARIFFS, {
  stockholm: { bolt: { standard: { base: "31.5", perKm: -4, garbage: 99 } } },
  okändStad: { bolt: { standard: { base: 1 } } },
  goteborg: "inte ett objekt",
});
const mergedBoltStd = merged.stockholm.services.bolt.categories.find(c => c.id === "standard");

checkClose("giltig justering (även som sträng) tas med", mergedBoltStd.base, 31.5);
checkClose("negativa värden ignoreras", mergedBoltStd.perKm, 9.9);
check("okända fält läggs inte till", !("garbage" in mergedBoltStd));
check("okända städer ignoreras", !("okändStad" in merged));
check("trasiga poster kraschar inte", merged.goteborg.services.bolt.categories.length === 3);
check("original-defaults muteras inte",
  Pricing.DEFAULT_TARIFFS.stockholm.services.bolt.categories[0].base === 25);
check("null-overrides ger ren kopia",
  Pricing.mergeTariffs(Pricing.DEFAULT_TARIFFS, null).stockholm.label === "Stockholm");

const emptyMerged = Pricing.mergeTariffs(Pricing.DEFAULT_TARIFFS, {
  stockholm: { bolt: { standard: { base: "", perKm: null, perMin: "  " } } },
}).stockholm.services.bolt.categories.find(c => c.id === "standard");
checkClose("tom sträng blir inte 0 kr", emptyMerged.base, 25);
checkClose("null blir inte 0 kr", emptyMerged.perKm, 9.9);
checkClose("blanksteg blir inte 0 kr", emptyMerged.perMin, 2.9);

/* ---------- haversineKm & fallbackRoute ---------- */

const sthlm = Pricing.DEFAULT_TARIFFS.stockholm.center;
const uppsala = Pricing.DEFAULT_TARIFFS.uppsala.center;
const straight = Pricing.haversineKm(sthlm.lat, sthlm.lon, uppsala.lat, uppsala.lon);
check("Stockholm–Uppsala fågelväg ≈ 64 km", straight > 60 && straight < 68);
checkClose("noll avstånd till sig själv", Pricing.haversineKm(59.3, 18.1, 59.3, 18.1), 0);

const fallback = Pricing.fallbackRoute(sthlm, uppsala);
checkClose("fallback skalar med vägfaktorn", fallback.km, straight * Pricing.ROAD_FACTOR, 1e-6);
check("fallback-restid är rimlig", fallback.minutes > 60 * fallback.km / 40 && fallback.minutes < 60 * fallback.km / 15);

const tinyTrip = Pricing.fallbackRoute({ lat: 59.3, lon: 18.1 }, { lat: 59.3, lon: 18.1 });
check("fallback golvar korta resor", tinyTrip.km >= 0.4 && tinyTrip.minutes >= 4);

/* ---------- Sammanfattning ---------- */

console.log(passed + " test klarade, " + failed + " föll");
if (failed > 0) process.exitCode = 1;
