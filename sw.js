/* Offline-cache så Sorenta 4.0 fungerar utan täckning (GPS behöver inget nät).
   Appfilerna hämtas nät-först så uppdateringar syns direkt; kartrutor cache-först
   eftersom en OSM-ruta i praktiken aldrig ändras — och då finns kartan kvar över
   områden du redan passerat även när täckningen tar slut.                      */
const CACHE = 'sorenta-v1';
const TILES = 'sorenta-tiles-v1';
const TILE_MAX = 500;                       // ~30–60 MB, trimmas ner till TILE_KEEP
const TILE_KEEP = 350;
const ASSETS = ['./', './index.html', './manifest.webmanifest', './icon.svg',
                './icon-192.png', './icon-512.png', './icon-180.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== TILES).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const arKartruta = url => /\.tile\.openstreetmap\.org$|^tile\.openstreetmap\.org$/.test(url.hostname);

// Håller ruttcachen inom sin gräns: äldsta (först tillagda) rutorna åker ut.
async function trimma(cache) {
  const nycklar = await cache.keys();
  if (nycklar.length <= TILE_MAX) return;
  await Promise.all(nycklar.slice(0, nycklar.length - TILE_KEEP).map(k => cache.delete(k)));
}

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  if (arKartruta(url)) {                    // kartruta: cache-först
    e.respondWith(caches.open(TILES).then(cache =>
      cache.match(e.request).then(träff => träff || fetch(e.request).then(res => {
        // Ogiltiga svar (fel, hastighetsbegränsning) ska inte cachas.
        if (res && (res.ok || res.type === 'opaque')) {
          cache.put(e.request, res.clone()).then(() => trimma(cache)).catch(() => {});
        }
        return res;
      }))
    ).catch(() => Response.error()));
    return;
  }

  if (url.origin !== self.location.origin) return;   // annat externt: rör inte

  e.respondWith(                            // appfiler: nät-först, cache som reserv
    fetch(e.request)
      .then(res => {
        const kopia = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, kopia)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
