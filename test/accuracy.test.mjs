/* Kör Sören Mäter i en riktig webbläsare mot simulerade banor med känd längd och
   verifierar både mätnoggrannheten och gränssnittsflödena.
   Avslutar med kod 1 om något kontrollvärde faller utanför sin tolerans.

   npm test          (sätt CHROMIUM=/sökväg/till/chrome om webbläsaren inte hittas)   */
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const CHROMIUM = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const MIME = {'.html':'text/html','.js':'text/javascript','.png':'image/png',
              '.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};

const server = http.createServer((req, res) => {
  let f = decodeURI(req.url.split('?')[0]);
  if (f === '/') f = '/index.html';
  const p = path.join(ROOT, f);
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
    res.writeHead(404); return res.end();
  }
  res.writeHead(200, {'content-type': MIME[path.extname(p)] || 'application/octet-stream'});
  res.end(fs.readFileSync(p));
});
await new Promise(r => server.listen(8099, r));

/* ---------- resultatbokföring ---------- */
let failed = 0, passed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; } else { failed++; }
  console.log((ok ? '  ok   ' : '  FEL  ') + name.padEnd(34) + (detail || ''));
}

/* ---------- GPS-modell (samma brus som parametrarna trimmades mot) ---------- */
let seed = 1;
const u = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += u(); return (s - 3) / Math.sqrt(0.5); };

const LAT0 = 57.7826, LNG0 = 14.1618;
const MLAT = 111132.95, MLNG = 111320 * Math.cos(LAT0 * Math.PI / 180);
const R = 6371008.8;
function haversine(a, b) {
  const la1 = a.lat*Math.PI/180, la2 = b.lat*Math.PI/180;
  const dla = la2-la1, dlo = (b.lng-a.lng)*Math.PI/180;
  const s = Math.sin(dla/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dlo/2)**2;
  return 2*R*Math.asin(Math.min(1, Math.sqrt(s)));
}

/* kind: rak | svangar | kvarter | blandat | still
   gap: [från, till] i sekunder — fix levereras inte alls i det intervallet      */
function makeFixes({kind, secs, speed, sigma = 5, rho = 0.6, spdNoise = 0.3,
                    withSpeed = true, gap = null, skrap = null, t0 = 1e12}) {
  let n = 0, e = 0, h = 0, bn = 0, be = 0, truth = 0;
  const out = [];
  for (let t = 0; t < secs; t++) {
    let dn = 0, de = 0;
    if (kind === 'rak') dn = speed;
    else if (kind === 'svangar') { h += Math.sin(t/9)*0.10; dn = speed*Math.cos(h); de = speed*Math.sin(h); }
    else if (kind === 'kvarter') { const a = (Math.floor(t/30)%4)*Math.PI/2; dn = speed*Math.cos(a); de = speed*Math.sin(a); }
    else if (kind === 'blandat' && (Math.floor(t/40)%2) === 0) { h += Math.sin(t/11)*0.08; dn = speed*Math.cos(h); de = speed*Math.sin(h); }
    n += dn; e += de; truth += Math.hypot(dn, de);
    bn = rho*bn + Math.sqrt(1-rho*rho)*gauss()*sigma;
    be = rho*be + Math.sqrt(1-rho*rho)*gauss()*sigma;
    if (gap && t > gap[0] && t < gap[1]) continue;      // luckan: inget fix levereras
    out.push({lat: LAT0 + (n+bn)/MLAT, lng: LNG0 + (e+be)/MLNG, acc: sigma, t: t0 + t*1000,
              speed: withSpeed ? Math.max(0, Math.hypot(dn, de) + gauss()*spdNoise) : null});
    // skrap: [sekund, avstånd i meter] — ett enstaka skräpfix långt bort, av samma
    // slag som telefoner levererar när de växlar till nätverksposition.
    if (skrap && t === skrap[0])
      out.push({lat: LAT0 + (n + bn + skrap[1])/MLAT, lng: LNG0 + (e+be)/MLNG, acc: sigma,
                t: t0 + t*1000 + 200, speed: withSpeed ? 1.4 : null});
  }
  return {fixes: out, truth};
}
/* Den naiva metoden: summera avståndet mellan råa fix. Baslinje att jämföra mot. */
const naivt = fixes => fixes.reduce((sum, f, i) => i ? sum + haversine(fixes[i-1], f) : 0, 0);

/* ---------- webbläsare ---------- */
const browser = await chromium.launch({executablePath: CHROMIUM});
const ctx = await browser.newContext({
  permissions: ['geolocation'], geolocation: {latitude: LAT0, longitude: LNG0, accuracy: 5},
  viewport: {width: 390, height: 844}, deviceScaleFactor: 2,
  isMobile: true, hasTouch: true, acceptDownloads: true});
const konsolfel = [];

async function newPage() {
  const page = await ctx.newPage();
  page.on('pageerror', e => konsolfel.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') konsolfel.push('CONSOLE: ' + m.text()); });
  await page.addInitScript(() => {
    let cb = null;
    Object.defineProperty(navigator, 'geolocation', {configurable: true, value: {
      watchPosition: s => { cb = s; return 1; }, clearWatch: () => { cb = null; },
      getCurrentPosition: () => {}}});
    window.__feed = list => { for (const f of list) { if (!cb) break;
      cb({coords: {latitude: f.lat, longitude: f.lng, accuracy: f.acc, speed: f.speed,
                   altitude: null, altitudeAccuracy: null, heading: null}, timestamp: f.t}); } };
  });
  await page.goto('http://localhost:8099/', {waitUntil: 'load'});
  await page.evaluate(() => localStorage.clear());
  await page.reload({waitUntil: 'load'});
  await page.click('#startBtn');
  await page.evaluate(() => { const S = window.__tripp.S;      // ren utgångspunkt
    S.total = 0; S.track = []; S.buf = []; S.origin = null; S.last = null; S.anchor = null;
    S.movingMs = 0; S.maxSpeed = 0; S.fixes = 0; S.rejected = 0; S.elapsed = 0; S.ema = null; });
  return page;
}

async function mat(cfg, mode = 'gang') {
  seed = 4242;
  const page = await newPage();
  if (mode !== 'gang') await page.evaluate(m => window.__tripp.setMode(m), mode);
  const {fixes, truth} = makeFixes(cfg);
  await page.evaluate(f => window.__feed(f), fixes);
  const r = await page.evaluate(() => ({total: window.__tripp.S.total, src: window.__tripp.S.src,
    rejected: window.__tripp.S.rejected, movingMs: window.__tripp.S.movingMs}));
  await page.close();
  return {...r, truth, naiv: naivt(fixes)};
}

const rader = [];
/* tol: procent för banor med längd, meter för stillastående */
async function scen(namn, cfg, tol, mode) {
  const r = await mat(cfg, mode);
  const fel = r.truth > 0 ? (r.total - r.truth) / r.truth * 100 : r.total;
  const ok = Math.abs(fel) <= tol;
  rader.push([namn, r.truth.toFixed(0) + ' m', r.total.toFixed(1) + ' m',
              r.truth > 0 ? fel.toFixed(1) + '%' : fel.toFixed(1) + ' m',
              r.naiv.toFixed(0) + ' m', r.src, ok ? 'ok' : 'FEL']);
  if (!ok) failed++; else passed++;
  return r;
}

console.log('== Mätnoggrannhet (σ=5 m, korrelerat brus, 1 Hz, dopplerbrus 0,3 m/s) ==');
await scen('står stilla 180 s',        {kind:'still',   secs:180, speed:0},            10);
await scen('gång 1,4 m/s rakt',        {kind:'rak',     secs:200, speed:1.4},           2);
await scen('gång med svängar',         {kind:'svangar', secs:200, speed:1.4},           2);
await scen('gång runt kvarteret',      {kind:'kvarter', secs:200, speed:1.4},           2);
await scen('blandat gå/stå',           {kind:'blandat', secs:320, speed:1.4},           4);
await scen('långsam gång 0,7 m/s',     {kind:'rak',     secs:200, speed:0.7},           4);
await scen('löpning 3 m/s',            {kind:'rak',     secs:200, speed:3.0},           2, 'lopning');
await scen('cykel 5,5 m/s kvarter',    {kind:'kvarter', secs:200, speed:5.5},           2, 'cykel');
await scen('bil 12 m/s svängar',       {kind:'svangar', secs:200, speed:12},            2, 'bil');
await scen('dålig signal σ=15 m',      {kind:'rak',     secs:200, speed:1.4, sigma:15}, 3);
await scen('60 s datalucka mitt i',    {kind:'rak',     secs:200, speed:1.4, gap:[60,120]}, 4);
await scen('datalucka stillastående',  {kind:'still',   secs:200, speed:0,   gap:[60,120]}, 10);
await scen('[utan doppler] stilla',    {kind:'still',   secs:180, speed:0,   withSpeed:false}, 25);
await scen('[utan doppler] gång rakt', {kind:'rak',     secs:200, speed:1.4, withSpeed:false}, 10);
await scen('[utan doppler] kvarteret', {kind:'kvarter', secs:200, speed:1.4, withSpeed:false}, 10);
await scen('[utan doppler] blandat',   {kind:'blandat', secs:320, speed:1.4, withSpeed:false}, 10);
await scen('[utan doppler] lucka',     {kind:'rak',     secs:200, speed:1.4, withSpeed:false, gap:[60,120]}, 10);
const skrapRes = await scen('skräpfix 3 km mitt i',    {kind:'rak', secs:200, speed:1.4, skrap:[100, 3000]}, 2);
const rentRes  = await scen('samma bana utan skräpfix', {kind:'rak', secs:200, speed:1.4}, 2);

const bredd = [24, 9, 10, 9, 11, 12, 5];
console.log(['scenario','sant','mätt','fel','naivt','källa',''].map((h,i)=>h.padEnd(bredd[i])).join(''));
for (const r of rader) console.log(r.map((c,i) => String(c).padEnd(bredd[i])).join(''));
console.log('naivt = summan av avstånden mellan råa fix, dvs. utan filtrering alls');
check('skräpfixet kastas', skrapRes.rejected >= 1, skrapRes.rejected + ' kastade');
check('inga korrekta fix kastas', rentRes.rejected === 0, rentRes.rejected + ' kastade på ren bana');
check('skräpfixet förgiftar inte filtret', skrapRes.rejected - rentRes.rejected <= 1,
      skrapRes.rejected + ' vs ' + rentRes.rejected + ' kastade');

/* ---------- robusthet mot skräpfix ---------- */
console.log('\n== Robusthet ==');
{
  seed = 99;
  const page = await newPage();
  const {fixes} = makeFixes({kind:'rak', secs:60, speed:1.4});
  await page.evaluate(f => window.__feed(f), fixes);
  const fore = await page.evaluate(() => window.__tripp.S.total);
  const sista = fixes[fixes.length - 1];
  await page.evaluate(l => window.__feed([{lat: l.lat + 5000/111132.95, lng: l.lng, acc: 5, speed: 2, t: l.t + 1000}]), sista);
  const efterHopp = await page.evaluate(() => window.__tripp.S.total);
  check('5 km-teleport kastas', Math.abs(efterHopp - fore) < 0.01, (efterHopp-fore).toFixed(2) + ' m tillagt');
  await page.evaluate(l => window.__feed([{lat: l.lat + 300/111132.95, lng: l.lng, acc: 80, speed: 2, t: l.t + 2000}]), sista);
  const efterDalig = await page.evaluate(() => window.__tripp.S.total);
  check('fix med acc 80 m kastas', Math.abs(efterDalig - efterHopp) < 0.01, (efterDalig-efterHopp).toFixed(2) + ' m tillagt');

  // Övergående GPS-timeout får inte låsa felbannern permanent.
  await page.evaluate(() => window.__tripp.S && document.getElementById('banner'));
  await page.evaluate(() => { const b = document.getElementById('banner');
    b.textContent = 'GPS-timeout, försöker igen…'; b.classList.add('on'); b.dataset.kind = 'hint'; });
  await page.evaluate(l => window.__feed([{lat: l.lat, lng: l.lng, acc: 5, speed: 1.4, t: l.t + 3000}]), sista);
  const bannerKvar = await page.evaluate(() => document.getElementById('banner').classList.contains('on'));
  check('timeout-varning släpper igen', !bannerKvar, bannerKvar ? 'bannern sitter kvar' : '');
  await page.close();
}

/* ---------- gränssnittsflöden ---------- */
console.log('\n== Gränssnitt ==');
{
  const page = await ctx.newPage();
  page.on('pageerror', e => konsolfel.push('PAGEERROR: ' + e.message));
  await page.goto('http://localhost:8099/', {waitUntil: 'load'});
  await page.evaluate(() => localStorage.clear());
  await page.reload({waitUntil: 'load'});
  check('titel', (await page.title()) === 'Sören Mäter - trippmätare', await page.title());
  const mf = await page.evaluate(async () => { const r = await fetch('manifest.webmanifest');
    const j = await r.json(); return {status: r.status, name: j.name, short: j.short_name}; });
  check('manifest', mf.status === 200 && mf.name === 'Sören Mäter - trippmätare' &&
        mf.short === 'Sören Mäter', mf.name + ' / ' + mf.short);
  const ikoner = await page.evaluate(async () => { const o = {};
    for (const f of ['icon.svg','icon-180.png','icon-192.png','icon-512.png','sw.js'])
      o[f] = (await fetch(f)).status; return o; });
  check('ikoner + sw.js finns', Object.values(ikoner).every(s => s === 200), JSON.stringify(ikoner));

  await page.click('#startBtn');
  await page.evaluate(() => { const S = window.__tripp.S;
    S.total = 0; S.track = []; S.buf = []; S.origin = null; S.last = null; S.anchor = null;
    S.movingMs = 0; S.fixes = 0; S.elapsed = 0; });
  for (let i = 0; i < 12; i++) {
    await ctx.setGeolocation({latitude: LAT0 + i*2/MLAT, longitude: LNG0, accuracy: 5});
    await page.waitForTimeout(600);
  }
  check('spårpunkter samlas', (await page.evaluate(() => window.__tripp.S.track.length)) > 2);
  check('kartan ritas', await page.evaluate(() => { const c = document.getElementById('map');
    const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
    let p = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) p++; return p > 500; }));
  await page.click('#startBtn');
  check('paus växlar knappen', (await page.textContent('#startBtn')) === 'Fortsätt');

  const dl = page.waitForEvent('download', {timeout: 8000}).catch(() => null);
  await page.click('#exportBtn');
  const d = await dl;
  if (d) {
    const gpx = fs.readFileSync(await d.path(), 'utf8');
    check('GPX-export', gpx.startsWith('<?xml') && gpx.includes('</gpx>') &&
          gpx.includes('creator="Sören Mäter"') && /<trkpt/.test(gpx),
          d.suggestedFilename() + ', ' + (gpx.match(/<trkpt/g)||[]).length + ' punkter');
    check('GPX-filnamn', d.suggestedFilename().startsWith('soren-mater-'), d.suggestedFilename());
  } else check('GPX-export', false, 'ingen nedladdning');

  const fore = await page.evaluate(() => window.__tripp.S.total);
  await page.reload({waitUntil: 'load'});
  await page.waitForTimeout(400);
  check('sträckan överlever omladdning',
        Math.abs((await page.evaluate(() => window.__tripp.S.total)) - fore) < 0.001);

  await page.click('#settings summary');
  await page.click('button[data-mode="cykel"]');
  await page.evaluate(() => { const s = document.getElementById('minMove');
    s.value = '2.2'; s.dispatchEvent(new Event('input')); });
  await page.reload({waitUntil: 'load'});
  await page.waitForTimeout(300);
  const inst = await page.evaluate(() => ({mode: window.__tripp.S.mode, minMove: window.__tripp.S.minMove}));
  check('inställningar sparas', inst.mode === 'cykel' && Math.abs(inst.minMove - 2.2) < 1e-9, JSON.stringify(inst));

  await page.click('#resetBtn');
  check('nollställ kräver dubbeltryck', (await page.evaluate(() => window.__tripp.S.total)) > 0);
  await page.click('#resetBtn');
  await page.waitForTimeout(200);
  check('nollställ nollar', (await page.evaluate(() => window.__tripp.S.total)) === 0);
  await page.screenshot({path: path.join(ROOT, 'test', 'skarmdump.png')});
  await page.close();
}

check('inga konsolfel', konsolfel.length === 0, konsolfel.join(' | '));

console.log('\n' + (failed ? `${failed} kontroller MISSLYCKADES (${passed} ok)` : `alla ${passed} kontroller ok`));
await browser.close();
server.close();
if (failed) process.exitCode = 1;
