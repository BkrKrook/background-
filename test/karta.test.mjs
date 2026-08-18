/* Kartan: OpenStreetMap-rutor, projektion, dra/zooma och reservläget utan nät.
   Rutorna hämtas från en lokal ruttjänst i testet — de riktiga OSM-servrarna
   ska inte belastas av en testsvit.                                            */
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

let failed = 0, passed = 0;
const check = (namn, ok, detalj) => {
  ok ? passed++ : failed++;
  console.log((ok ? '  ok   ' : '  FEL  ') + namn.padEnd(38) + (detalj || ''));
};

/* --- minimal PNG i en enda färg, som testets kartruta --- */
function png(size, rgb) {
  const rad = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x++) { rad[1+x*3] = rgb[0]; rad[2+x*3] = rgb[1]; rad[3+x*3] = rgb[2]; }
  const raw = Buffer.concat(Array.from({length: size}, () => rad));
  const bit = (t, d) => {
    const c = Buffer.concat([Buffer.alloc(4), Buffer.from(t), d]);
    c.writeUInt32BE(d.length, 0);
    return Buffer.concat([c, (() => { const b = Buffer.alloc(4);
      b.writeUInt32BE(zlib.crc32 ? zlib.crc32(Buffer.concat([Buffer.from(t), d])) : crc(Buffer.concat([Buffer.from(t), d])), 0);
      return b; })()]);
  };
  let tabell = null;
  function crc(buf) {
    if (!tabell) { tabell = []; for (let n = 0; n < 256; n++) { let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; tabell[n] = c >>> 0; } }
    let c = 0xffffffff;
    for (const b of buf) c = tabell[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
    bit('IHDR', ihdr), bit('IDAT', zlib.deflateSync(raw)), bit('IEND', Buffer.alloc(0))]);
}
const RUTA = png(256, [90, 110, 90]);

/* --- server: appen + låtsasrutor, med CORS precis som OSM --- */
const begarda = [];
const server = http.createServer((req, res) => {
  const u = decodeURI(req.url.split('?')[0]);
  const ruta = u.match(/^\/tiles\/(\d+)\/(\d+)\/(\d+)\.png$/);
  if (ruta) {
    begarda.push(ruta.slice(1, 4).map(Number).join('/'));
    res.writeHead(200, {'content-type': 'image/png', 'access-control-allow-origin': '*'});
    return res.end(RUTA);
  }
  const f = u === '/' ? '/index.html' : u;
  const pf = path.join(ROOT, f);
  if (!pf.startsWith(ROOT) || !fs.existsSync(pf) || fs.statSync(pf).isDirectory()) {
    res.writeHead(404); return res.end();
  }
  res.writeHead(200, {'content-type': MIME[path.extname(pf)] || 'application/octet-stream'});
  res.end(fs.readFileSync(pf));
});
await new Promise(r => server.listen(8088, r));

const LAT = 57.7826, LNG = 14.1618, MLAT = 111132.95;
const browser = await chromium.launch({executablePath: CHROMIUM});
const konsolfel = [];
let ignoreraNatfel = false;      // sätts under testet som medvetet saknar kartserver
const kontexter = [];

async function sida(tileUrl = 'http://localhost:8088/tiles/{z}/{x}/{y}.png') {
  const ctx = await browser.newContext({viewport: {width: 390, height: 844},
    deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['geolocation']});
  kontexter.push(ctx);
  // Testet ska aldrig belasta OSM:s riktiga servrar — allt dit besvaras lokalt.
  await ctx.route(/openstreetmap\.org/, route =>
    route.fulfill({status: 200, contentType: 'image/png',
                   headers: {'access-control-allow-origin': '*'}, body: RUTA}));
  const page = await ctx.newPage();
  page.on('pageerror', e => konsolfel.push('PAGEERROR: ' + e.message));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    if (ignoreraNatfel && /Failed to load resource/.test(m.text())) return;
    konsolfel.push('CONSOLE: ' + m.text());
  });
  await page.addInitScript(() => {
    let cb = null;
    Object.defineProperty(navigator, 'geolocation', {configurable: true, value: {
      watchPosition: s => { cb = s; return 1; }, clearWatch: () => {}, getCurrentPosition: () => {}}});
    window.__feed = list => { for (const f of list) { if (!cb) break;
      cb({coords: {latitude: f.lat, longitude: f.lng, accuracy: f.acc, speed: f.speed,
                   altitude: null, altitudeAccuracy: null, heading: null}, timestamp: f.t}); } };
  });
  await page.goto('http://localhost:8088/', {waitUntil: 'load'});
  await page.evaluate(u => { window.__tripp.M.url = u; }, tileUrl);
  await page.click('#startBtn');
  return page;
}

/* rak promenad norrut, 120 s */
const bana = () => Array.from({length: 120}, (_, t) => ({
  lat: LAT + t * 1.4 / MLAT, lng: LNG, acc: 5, t: 1e12 + t * 1000, speed: 1.4}));

console.log('== Projektion (Web Mercator) ==');
{
  const page = await sida();
  // Facit räknat oberoende ur standardformlerna för slippy-map-rutor.
  const vantadX = Math.floor((LNG + 180) / 360 * Math.pow(2, 16));
  const sy = Math.sin(LAT * Math.PI/180);
  const vantadY = Math.floor((0.5 - Math.log((1+sy)/(1-sy)) / (4*Math.PI)) * Math.pow(2, 16));
  const r = await page.evaluate(([lat, lng]) => {
    const p = window.__tripp.project(lat, lng, 16);
    const t = window.__tripp.unproject(p[0], p[1], 16);
    return {tx: Math.floor(p[0]/256), ty: Math.floor(p[1]/256), lat: t[0], lng: t[1],
            mpp: window.__tripp.mPerPx(lat, 16)};
  }, [LAT, LNG]);
  check('rutnummer stämmer', r.tx === vantadX && r.ty === vantadY,
        `${r.tx}/${r.ty} (facit ${vantadX}/${vantadY})`);
  check('unproject vänder tillbaka', Math.abs(r.lat - LAT) < 1e-9 && Math.abs(r.lng - LNG) < 1e-9,
        r.lat.toFixed(9) + ', ' + r.lng.toFixed(9));
  check('meter per pixel rimlig', Math.abs(r.mpp - 1.27) < 0.05, r.mpp.toFixed(3) + ' m/px');
  await page.close();
}

console.log('\n== Kartrutor ==');
{
  begarda.length = 0;
  const page = await sida();
  await page.evaluate(f => window.__feed(f), bana());
  await page.waitForFunction(() => window.__tripp.M.loaded > 0, null, {timeout: 8000}).catch(() => {});
  await page.waitForTimeout(600);
  const m = await page.evaluate(() => ({z: window.__tripp.M.z, loaded: window.__tripp.M.loaded,
    broken: window.__tripp.M.broken, lat: window.__tripp.M.lat}));
  check('rutor hämtades', m.loaded > 0, m.loaded + ' rutor, zoom ' + m.z);
  const nivaer = [...new Set(begarda.map(k => +k.split('/')[0]))];
  check('begärda zoomnivåer är giltiga', nivaer.every(z => z >= 2 && z <= 19), 'nivå ' + nivaer.join(','));
  const mitten = await page.evaluate(z => {
    const p = window.__tripp.project(window.__tripp.M.lat, window.__tripp.M.lng, z);
    return Math.floor(p[0]/256) + '/' + Math.floor(p[1]/256);
  }, Math.round(m.z));
  check('rutan under kartcentrum begärdes',
        begarda.some(k => k.split('/').slice(1).join('/') === mitten), 'centrum ' + mitten);
  const bild = await page.evaluate(() => {
    const c = document.getElementById('map');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let ruta = 0, spar = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (Math.abs(d[i]-72) < 14 && Math.abs(d[i+1]-88) < 14 && Math.abs(d[i+2]-72) < 14) ruta++;
      if (d[i] < 90 && d[i+1] > 150 && d[i+2] > 110) spar++;
    }
    return {ruta, spar};
  });
  check('rutorna ritas ut', bild.ruta > 2000, bild.ruta + ' px kartbild');
  check('spåret ritas ovanpå', bild.spar > 300, bild.spar + ' px spår');
  check('canvasen är inte tainted', true, 'getImageData gick igenom (CORS ok)');
  check('attributionen visas', !(await page.evaluate(() =>
        document.getElementById('attrib').classList.contains('hidden'))));
  const attribHref = await page.getAttribute('#attrib', 'href');
  check('attributionen länkar till OSM', attribHref === 'https://www.openstreetmap.org/copyright', attribHref);
  await page.close();
}

console.log('\n== Dra, zooma, centrera ==');
{
  const page = await sida();
  await page.evaluate(f => window.__feed(f), bana());
  await page.waitForTimeout(400);
  const fore = await page.evaluate(() => ({z: window.__tripp.M.z, lat: window.__tripp.M.lat,
    follow: window.__tripp.M.follow}));
  check('följer spåret från start', fore.follow === true);

  const box = await page.locator('#map').boundingBox();
  const mx = box.x + box.width/2, my = box.y + box.height/2;
  await page.mouse.move(mx, my); await page.mouse.down();
  await page.mouse.move(mx, my - 60, {steps: 6}); await page.mouse.up();
  const efterDrag = await page.evaluate(() => ({lat: window.__tripp.M.lat,
    follow: window.__tripp.M.follow}));
  check('drag flyttar kartan', Math.abs(efterDrag.lat - fore.lat) > 1e-6,
        'Δlat ' + (efterDrag.lat - fore.lat).toExponential(2));
  check('drag stänger av följning', efterDrag.follow === false);

  await page.click('#zoomIn');
  const inZoom = await page.evaluate(() => window.__tripp.M.z);
  check('zooma in', Math.abs(inZoom - (fore.z + 1)) < 1e-6, 'z ' + fore.z + ' → ' + inZoom);
  await page.click('#zoomOut'); await page.click('#zoomOut');
  const utZoom = await page.evaluate(() => window.__tripp.M.z);
  check('zooma ut', Math.abs(utZoom - (fore.z - 1)) < 1e-6, 'z ' + inZoom + ' → ' + utZoom);

  const kvarUnderFinger = await page.evaluate(() => {
    const M = window.__tripp.M;
    const fore = window.__tripp.project(M.lat, M.lng, M.z);
    const cv = document.getElementById('map');
    const punktFore = window.__tripp.unproject(fore[0] + 80 - cv.clientWidth/2,
                                               fore[1] + 40 - cv.clientHeight/2, M.z);
    document.getElementById('map').dispatchEvent(new WheelEvent('wheel',
      {clientX: cv.getBoundingClientRect().left + 80, clientY: cv.getBoundingClientRect().top + 40,
       deltaY: -350, bubbles: true, cancelable: true}));
    const efter = window.__tripp.project(M.lat, M.lng, M.z);
    const punktEfter = window.__tripp.unproject(efter[0] + 80 - cv.clientWidth/2,
                                                efter[1] + 40 - cv.clientHeight/2, M.z);
    const p1 = window.__tripp.project(punktFore[0], punktFore[1], M.z);
    const p2 = window.__tripp.project(punktEfter[0], punktEfter[1], M.z);
    return {px: Math.hypot(p1[0]-p2[0], p1[1]-p2[1])};
  });
  check('zoom behåller punkten under pekaren', kvarUnderFinger.px < 1,
        'avvikelse ' + kvarUnderFinger.px.toFixed(3) + ' px');

  await page.click('#centerBtn');
  await page.waitForTimeout(200);
  const efterCentrera = await page.evaluate(() => ({follow: window.__tripp.M.follow,
    lat: window.__tripp.M.lat}));
  check('centrera slår på följning igen', efterCentrera.follow === true &&
        Math.abs(efterCentrera.lat - fore.lat) < 1e-9);

  await page.click('#bigBtn');
  await page.waitForTimeout(300);
  const stor = await page.evaluate(() => document.getElementById('mapwrap').getBoundingClientRect().height);
  check('förstoringsknappen växer kartan', stor > 300, Math.round(stor) + ' px');
  await page.close();
}

console.log('\n== Utan kartdata ==');
{
  ignoreraNatfel = true;
  const page = await sida('http://127.0.0.1:9/tiles/{z}/{x}/{y}.png');   // stängd port
  await page.evaluate(f => window.__feed(f), bana());
  await page.waitForFunction(() => window.__tripp.M.broken === true, null, {timeout: 10000}).catch(() => {});
  await page.waitForTimeout(400);
  const m = await page.evaluate(() => ({broken: window.__tripp.M.broken, loaded: window.__tripp.M.loaded}));
  check('ger upp efter upprepade fel', m.broken === true, 'laddade ' + m.loaded);
  const spar = await page.evaluate(() => {
    const c = document.getElementById('map');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 90 && d[i+1] > 150 && d[i+2] > 110) n++;
    return n;
  });
  check('spåret ritas ändå', spar > 300, spar + ' px spår');
  check('attributionen döljs när kartbild saknas', await page.evaluate(() =>
        document.getElementById('attrib').classList.contains('hidden')));

  await page.evaluate(() => window.__tripp.setTiles(false));
  await page.waitForTimeout(200);
  const av = await page.evaluate(() => ({tiles: window.__tripp.M.tiles,
    dold: document.getElementById('attrib').classList.contains('hidden')}));
  check('kartbild går att stänga av', av.tiles === false && av.dold);
  await page.close();
  ignoreraNatfel = false;
}

console.log('\n== Sparade inställningar ==');
{
  const page = await sida();
  await page.evaluate(() => { window.__tripp.setTiles(false); document.getElementById('bigBtn').click(); });
  await page.reload({waitUntil: 'load'});
  await page.waitForTimeout(300);
  const kvar = await page.evaluate(() => ({tiles: window.__tripp.M.tiles, big: window.__tripp.M.big,
    klass: document.getElementById('mapwrap').classList.contains('big')}));
  check('kartval överlever omladdning', kvar.tiles === false && kvar.big === true && kvar.klass,
        JSON.stringify(kvar));

  await page.close();
}

console.log('\n== Namnbyte utan dataförlust ==');
{
  // Den gamla nyckeln måste finnas innan appens skript kör, precis som för en
  // användare som redan mätt med förra versionen.
  const migCtx = await browser.newContext();
  kontexter.push(migCtx);
  await migCtx.route(/openstreetmap\.org/, route =>
    route.fulfill({status: 200, contentType: 'image/png', body: RUTA}));
  const page = await migCtx.newPage();
  page.on('pageerror', e => konsolfel.push('PAGEERROR: ' + e.message));
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('soren-mater.v1', JSON.stringify({
      total: 1234.5, track: [], mode: 'cykel', accGate: 15, minMove: 1.7}));
  });
  await page.goto('http://localhost:8088/', {waitUntil: 'load'});
  await page.waitForTimeout(200);
  const flyttad = await page.evaluate(() => ({
    total: window.__tripp.S.total, mode: window.__tripp.S.mode, accGate: window.__tripp.S.accGate,
    gammalBorta: localStorage.getItem('soren-mater.v1') === null,
    ny: !!localStorage.getItem('sorenta.v1')}));
  check('gammal mätning flyttas till nya namnet',
        Math.abs(flyttad.total - 1234.5) < 0.01 && flyttad.mode === 'cykel' &&
        flyttad.accGate === 15 && flyttad.gammalBorta && flyttad.ny,
        JSON.stringify(flyttad));
  await page.close();
}

check('inga konsolfel', konsolfel.length === 0, konsolfel.slice(0, 3).join(' | '));
console.log('\n' + (failed ? `${failed} kontroller MISSLYCKADES (${passed} ok)` : `alla ${passed} kontroller ok`));
for (const k of kontexter) await k.close().catch(() => {});
await browser.close();
server.close();
if (failed) process.exitCode = 1;
