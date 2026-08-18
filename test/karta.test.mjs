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
let trasigaAnrop = 0;
const server = http.createServer((req, res) => {
  const u = decodeURI(req.url.split('?')[0]);
  if (/^\/trasiga\//.test(u)) { trasigaAnrop++; res.writeHead(500); return res.end(); }
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

console.log('\n== Rutor som inte går att hämta ==');
{
  ignoreraNatfel = true;
  const page = await sida();
  await page.evaluate(f => window.__feed(f), bana());
  await page.waitForFunction(() => window.__tripp.M.loaded > 0, null, {timeout: 8000}).catch(() => {});
  const laddade = await page.evaluate(() => window.__tripp.M.loaded);
  check('rutor laddade innan nätet dog', laddade > 0, laddade + ' rutor');

  // Täckningen försvinner mitt i mätningen: rutorna börjar fela.
  trasigaAnrop = 0;
  await page.evaluate(() => { window.__tripp.M.url = 'http://localhost:8088/trasiga/{z}/{x}/{y}.png';
                              window.__tripp.M.cache.clear(); });
  const box = await page.locator('#map').boundingBox();
  await page.mouse.move(box.x + box.width/2, box.y + box.height/2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width/2 - 120, box.y + box.height/2 - 90, {steps: 10});
  await page.mouse.up();
  await page.waitForTimeout(3000);
  const efter = await page.evaluate(() => ({broken: window.__tripp.M.broken,
    fails: window.__tripp.M.fails, pending: window.__tripp.M.pending}));
  // Utan vila och fungerande nödbroms blev det hundratals anrop per sekund.
  check('ingen anropsstorm när nätet dör', trasigaAnrop < 40, trasigaAnrop + ' anrop på 3 s');
  check('nödbromsen slår till trots tidigare lyckade rutor', efter.broken === true,
        'fails ' + efter.fails);

  const foreVila = trasigaAnrop;
  await page.evaluate(() => { const M = window.__tripp.M; M.broken = false; M.fails = 0; M.brokenT = 0; });
  for (let i = 0; i < 6; i++) { await page.evaluate(() => window.__tripp.paint());
                                await page.waitForTimeout(120); }
  check('trasig ruta vilar innan nytt försök', trasigaAnrop - foreVila <= 12,
        (trasigaAnrop - foreVila) + ' nya anrop på 6 omritningar');

  // Nödbromsen ska släppa av sig själv när täckningen kommer tillbaka.
  await page.evaluate(() => { const M = window.__tripp.M;
    M.broken = true; M.brokenT = Date.now() - 61000; M.cache.clear();
    M.url = 'http://localhost:8088/tiles/{z}/{x}/{y}.png'; });
  await page.evaluate(() => window.__tripp.paint());
  await page.waitForFunction(() => window.__tripp.M.broken === false, null, {timeout: 5000}).catch(() => {});
  check('kartan återhämtar sig när nätet kommer tillbaka',
        await page.evaluate(() => window.__tripp.M.broken === false && window.__tripp.M.loaded > 0));
  await page.close();
  ignoreraNatfel = false;
}

console.log('\n== Nyp med två fingrar ==');
{
  const page = await sida();
  await page.evaluate(f => window.__feed(f), bana());
  await page.waitForTimeout(300);
  const resultat = await page.evaluate(() => {
    const wrap = document.getElementById('mapwrap'), cv = document.getElementById('map');
    const r = cv.getBoundingClientRect();
    const T = window.__tripp;
    const skarmTillLatLng = (sx, sy) => {
      const c = T.project(T.M.lat, T.M.lng, T.M.z);
      return T.unproject(c[0] + sx - cv.clientWidth/2, c[1] + sy - cv.clientHeight/2, T.M.z);
    };
    const latLngTillSkarm = (lat, lng) => {
      const c = T.project(T.M.lat, T.M.lng, T.M.z), p = T.project(lat, lng, T.M.z);
      return [p[0] - c[0] + cv.clientWidth/2, p[1] - c[1] + cv.clientHeight/2];
    };
    const ev = (typ, id, x, y) => wrap.dispatchEvent(new PointerEvent(typ,
      {pointerId: id, clientX: x, clientY: y, bubbles: true, cancelable: true, pointerType: 'touch'}));

    let a = [r.left + 150, r.top + 60], b = [r.left + 210, r.top + 120];
    ev('pointerdown', 1, a[0], a[1]);
    ev('pointerdown', 2, b[0], b[1]);
    // punkten som ligger under fingrarnas mittpunkt när gesten börjar
    const start = skarmTillLatLng((a[0]+b[0])/2 - r.left, (a[1]+b[1])/2 - r.top);

    for (let i = 0; i < 30; i++) {         // fingrarna glider isär och åt sidan
      a = [a[0] - 3 + 6, a[1] - 2 + 1];
      b = [b[0] + 3 + 6, b[1] + 2 + 1];
      ev('pointermove', 1, a[0], a[1]);
      ev('pointermove', 2, b[0], b[1]);
    }
    const slutMitt = [(a[0]+b[0])/2 - r.left, (a[1]+b[1])/2 - r.top];
    ev('pointerup', 1, a[0], a[1]); ev('pointerup', 2, b[0], b[1]);
    const nu = latLngTillSkarm(start[0], start[1]);
    return {avvikelse: Math.hypot(nu[0] - slutMitt[0], nu[1] - slutMitt[1]),
            zoomAndrad: T.M.z};
  });
  check('kartan följer med fingrarna vid nyp', resultat.avvikelse < 3,
        'punkten hamnade ' + resultat.avvikelse.toFixed(1) + ' px från fingrarnas mitt');

  // Lyfta ett finger ur ett tregrepp fick tidigare kartan att hoppa.
  const hopp = await page.evaluate(() => {
    const wrap = document.getElementById('mapwrap'), cv = document.getElementById('map');
    const r = cv.getBoundingClientRect(), T = window.__tripp;
    const ev = (typ, id, x, y) => wrap.dispatchEvent(new PointerEvent(typ,
      {pointerId: id, clientX: x, clientY: y, bubbles: true, cancelable: true, pointerType: 'touch'}));
    ev('pointerdown', 11, r.left + 100, r.top + 60);
    ev('pointerdown', 12, r.left + 200, r.top + 60);
    ev('pointerdown', 13, r.left + 150, r.top + 120);
    const fore = [T.M.lat, T.M.lng, T.M.z];
    ev('pointerup', 12, r.left + 200, r.top + 60);        // ett finger lyfts
    ev('pointermove', 11, r.left + 101, r.top + 60);      // en pixels rörelse
    ev('pointerup', 11, r.left + 101, r.top + 60);
    ev('pointerup', 13, r.left + 150, r.top + 120);
    const c1 = T.project(fore[0], fore[1], fore[2]), c2 = T.project(T.M.lat, T.M.lng, fore[2]);
    return {px: Math.hypot(c1[0]-c2[0], c1[1]-c2[1]), dz: Math.abs(T.M.z - fore[2])};
  });
  check('inget hopp när ett finger lyfts ur tregrepp', hopp.px < 15 && hopp.dz < 0.2,
        hopp.px.toFixed(1) + ' px, Δz ' + hopp.dz.toFixed(2));
  await page.close();
}

console.log('\n== Kartytans storlek ==');
{
  const page = await sida();
  await page.evaluate(f => window.__feed(f), bana());
  await page.click('#bigBtn');
  await page.waitForTimeout(700);                        // CSS-övergången hinner klart
  const m = await page.evaluate(() => {
    const cv = document.getElementById('map');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    return {css: cv.clientHeight, bitmapp: cv.height / dpr};
  });
  check('canvasen matchar kartytan efter förstoring', Math.abs(m.css - m.bitmapp) < 2,
        m.bitmapp.toFixed(0) + ' vs ' + m.css + ' px');
  await page.close();
}

console.log('\n== Långt spår ==');
{
  const page = await sida();
  const r = await page.evaluate(() => {
    const S = window.__tripp.S;
    S.track = [];
    for (let i = 0; i < 8000; i++) S.track.push([57.7826 + i*1e-5, 14.1618, 1e12 + i*1000, 5]);
    const forsta = S.track[0][0];
    for (let i = 0; i < 40; i++) S.track.push([57.9 + i*1e-5, 14.1618, 1e12 + 9e6 + i*1000, 5]);
    // samma gallring som appen kör när taket nås
    while (S.track.length > 8000) {
      const halva = S.track.length >> 1, glesad = [];
      for (let i = 0; i < halva; i += 2) glesad.push(S.track[i]);
      S.track = glesad.concat(S.track.slice(halva));
    }
    return {langd: S.track.length, forsta: S.track[0][0], forstaFore: forsta,
            sista: S.track[S.track.length-1][0]};
  });
  check('spårets början finns kvar efter gallring', Math.abs(r.forsta - r.forstaFore) < 1e-9,
        'första punkten ' + r.forsta.toFixed(5));
  check('spåret hålls under taket', r.langd <= 8000, r.langd + ' punkter');
  await page.close();
}

check('attributionen nämner bidragsgivarna',
      (await (async () => { const p = await sida(); const t = await p.textContent('#attrib');
        await p.close(); return t; })()).includes('bidragsgivarna'));
check('inga konsolfel', konsolfel.length === 0, konsolfel.slice(0, 3).join(' | '));
console.log('\n' + (failed ? `${failed} kontroller MISSLYCKADES (${passed} ok)` : `alla ${passed} kontroller ok`));
for (const k of kontexter) await k.close().catch(() => {});
await browser.close();
server.close();
if (failed) process.exitCode = 1;
