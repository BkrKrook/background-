/* Genererar README-bilden: appen med en inspelad promenad runt ett kvarter.
   Kartrutorna ritas lokalt av det här skriptet — byggmiljön har ingen åtkomst
   till OpenStreetMaps servrar, och en testsvit ska inte belasta dem.
   Kör med: npm run skarmdump                                                  */
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const CHROMIUM = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const MIME = {'.html':'text/html','.js':'text/javascript','.png':'image/png',
              '.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};

let tab = null;
function crc(buf) {
  if (!tab) { tab = []; for (let n = 0; n < 256; n++) { let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; tab[n] = c >>> 0; } }
  let c = 0xffffffff;
  for (const b of buf) c = tab[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function png(farg, size) {
  const rader = [];
  for (let y = 0; y < size; y++) {
    const r = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) { const p = farg(x, y); r[1+x*3]=p[0]; r[2+x*3]=p[1]; r[3+x*3]=p[2]; }
    rader.push(r);
  }
  const bit = (t, d) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(d.length, 0);
    const kropp = Buffer.concat([Buffer.from(t), d]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(kropp), 0);
    return Buffer.concat([len, kropp, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
    bit('IHDR', ihdr), bit('IDAT', zlib.deflateSync(Buffer.concat(rader))), bit('IEND', Buffer.alloc(0))]);
}
/* enkel kvartersstruktur, deterministisk per ruta */
function ruta(x, y) {
  const h = (x * 73856093 ^ y * 19349663) >>> 0;
  const o1 = (h % 5) * 20, o2 = ((h >> 3) % 5) * 22;
  return png((px, py) => {
    const gata = (v, o) => (v + o) % 96 < 7;
    if (gata(px, o1) || gata(py, o2)) return [252, 250, 246];
    if ((px + o1) % 96 === 7 || (py + o2) % 96 === 7) return [214, 208, 198];
    if ((h >> 7) % 4 === 0 && px > 40 && px < 120 && py > 40 && py < 120) return [205, 228, 183];
    if ((h >> 11) % 5 === 0 && Math.abs(px - py) < 9) return [166, 201, 224];
    return [241, 237, 229];
  }, 256);
}

const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  const m = u.match(/^\/tiles\/(\d+)\/(\d+)\/(\d+)\.png$/);
  if (m) {
    res.writeHead(200, {'content-type': 'image/png', 'access-control-allow-origin': '*'});
    return res.end(ruta(+m[2], +m[3]));
  }
  const f = u === '/' ? '/index.html' : u, p = path.join(ROOT, f);
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
    res.writeHead(404); return res.end();
  }
  res.writeHead(200, {'content-type': MIME[path.extname(p)] || 'application/octet-stream'});
  res.end(fs.readFileSync(p));
});
await new Promise(r => server.listen(8087, r));

let seed = 77;
const u = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const g = () => { let s = 0; for (let i = 0; i < 6; i++) s += u(); return (s - 3) / Math.sqrt(0.5); };
const LAT0 = 57.7826, LNG0 = 14.1618, MLAT = 111132.95, MLNG = 111320 * Math.cos(LAT0 * Math.PI/180);

const browser = await chromium.launch({executablePath: CHROMIUM});
const ctx = await browser.newContext({viewport: {width: 390, height: 844}, deviceScaleFactor: 2,
  isMobile: true, hasTouch: true, permissions: ['geolocation']});
const page = await ctx.newPage();
await page.addInitScript(() => {
  let cb = null;
  Object.defineProperty(navigator, 'geolocation', {configurable: true, value: {
    watchPosition: s => { cb = s; return 1; }, clearWatch: () => {}, getCurrentPosition: () => {}}});
  window.__feed = list => { for (const f of list) { if (!cb) break;
    cb({coords: {latitude: f.lat, longitude: f.lng, accuracy: f.acc, speed: f.speed,
                 altitude: null, altitudeAccuracy: null, heading: null}, timestamp: f.t}); } };
});
await page.goto('http://localhost:8087/', {waitUntil: 'load'});
await page.evaluate(() => localStorage.clear());
await page.reload({waitUntil: 'load'});
await page.evaluate(() => { window.__tripp.M.url = 'http://localhost:8087/tiles/{z}/{x}/{y}.png'; });
await page.click('#startBtn');
await page.evaluate(() => { const S = window.__tripp.S; S.elapsed = 0; S.runStart = Date.now() - 364000; });

const fixes = [];
let n = 0, e = 0, bn = 0, be = 0;
const t0 = Date.now() - 360000;
for (let t = 0; t < 360; t++) {                       // 6 min runt ett kvarter
  const a = (Math.floor(t/45) % 4) * Math.PI/2, sp = 1.35;
  const dn = sp * Math.cos(a), de = sp * Math.sin(a);
  n += dn; e += de;
  bn = .6*bn + .8*g()*4; be = .6*be + .8*g()*4;
  fixes.push({lat: LAT0 + (n+bn)/MLAT, lng: LNG0 + (e+be)/MLNG, acc: 4 + Math.abs(g()),
              t: t0 + t*1000, speed: Math.max(0, sp + g()*.3)});
}
await page.evaluate(f => window.__feed(f), fixes);
await page.waitForTimeout(1500);
await page.screenshot({path: path.join(ROOT, 'skarmdump.png')});
console.log('skarmdump.png skriven — sträcka', await page.textContent('#dist'),
            'm (sant 486 m), rutor:', await page.evaluate(() => window.__tripp.M.loaded));
await browser.close();
server.close();
