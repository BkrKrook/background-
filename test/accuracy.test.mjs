import { chromium } from 'playwright-core';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';

const ROOT=path.resolve(new URL('..', import.meta.url).pathname);
const CHROMIUM=process.env.CHROMIUM||'/opt/pw-browsers/chromium';
const T={'.html':'text/html','.js':'text/javascript','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
const server=http.createServer((q,r)=>{let f=decodeURI(q.url.split('?')[0]);if(f==='/')f='/index.html';
  const p=path.join(ROOT,f); if(!fs.existsSync(p)){r.writeHead(404);return r.end();}
  r.writeHead(200,{'content-type':T[path.extname(p)]||'application/octet-stream'});r.end(fs.readFileSync(p));});
await new Promise(r=>server.listen(8099,r));

/* --- samma brusmodell som simulatorn --- */
let seed=1; const u=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
const g=()=>{let s=0;for(let i=0;i<6;i++)s+=u();return (s-3)/Math.sqrt(0.5);};
const LAT0=57.7826,LNG0=14.1618,MLAT=111132.95,MLNG=111320*Math.cos(LAT0*Math.PI/180);

function makeFixes({kind,secs,speed,sigma=5,rho=0.6,spdNoise=0.3,withSpeed=true,t0=1e12}){
  let n=0,e=0,h=0,bn=0,be=0; const out=[]; let truth=0;
  for(let t=0;t<secs;t++){
    let dn=0,de=0;
    if(kind==='rak'){dn=speed;}
    else if(kind==='svangar'){h+=Math.sin(t/9)*0.10;dn=speed*Math.cos(h);de=speed*Math.sin(h);}
    else if(kind==='kvarter'){const a=(Math.floor(t/30)%4)*Math.PI/2;dn=speed*Math.cos(a);de=speed*Math.sin(a);}
    else if(kind==='blandat'){if((Math.floor(t/40)%2)===0){h+=Math.sin(t/11)*0.08;dn=speed*Math.cos(h);de=speed*Math.sin(h);}}
    n+=dn;e+=de; truth+=Math.hypot(dn,de);
    bn=rho*bn+Math.sqrt(1-rho*rho)*g()*sigma; be=rho*be+Math.sqrt(1-rho*rho)*g()*sigma;
    const v=Math.hypot(dn,de);
    out.push({lat:LAT0+(n+bn)/MLAT, lng:LNG0+(e+be)/MLNG, acc:sigma, t:t0+t*1000,
              speed: withSpeed? Math.max(0,v+g()*spdNoise) : null});
  }
  return {fixes:out, truth};
}

const browser=await chromium.launch({executablePath:CHROMIUM});
const ctx=await browser.newContext({permissions:['geolocation'],
  geolocation:{latitude:LAT0,longitude:LNG0,accuracy:5},
  viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true,acceptDownloads:true});
const errs=[];

async function newPage(){
  const page=await ctx.newPage();
  page.on('pageerror',e=>errs.push('PAGEERROR: '+e.message));
  page.on('console',m=>{if(m.type()==='error')errs.push('CONSOLE: '+m.text());});
  await page.addInitScript(()=>{
    let cb=null;
    Object.defineProperty(navigator,'geolocation',{configurable:true,value:{
      watchPosition:(s)=>{cb=s;return 1;}, clearWatch:()=>{cb=null;},
      getCurrentPosition:(s)=>{}
    }});
    window.__feed=(list)=>{ for(const f of list){ if(!cb)break;
      cb({coords:{latitude:f.lat,longitude:f.lng,accuracy:f.acc,speed:f.speed,
        altitude:null,altitudeAccuracy:null,heading:null},timestamp:f.t}); } };
  });
  await page.goto('http://localhost:8099/',{waitUntil:'load'});
  await page.evaluate(()=>localStorage.clear());
  await page.reload({waitUntil:'load'});
  await page.click('#startBtn');
  await page.evaluate(()=>{ const S=window.__tripp.S;
    S.total=0;S.track=[];S.buf=[];S.origin=null;S.last=null;S.anchor=null;
    S.movingMs=0;S.maxSpeed=0;S.fixes=0;S.rejected=0;S.elapsed=0; });
  return page;
}
const dist = p => p.evaluate(()=>window.__tripp.S.total);

async function run(cfg, mode='gang'){
  const page=await newPage();
  if(mode!=='gang') await page.evaluate(m=>window.__tripp.setMode(m), mode);
  const {fixes,truth}=makeFixes(cfg);
  await page.evaluate(f=>window.__feed(f), fixes);
  const measured=await dist(page);
  const st=await page.evaluate(()=>({src:window.__tripp.S.src,rej:window.__tripp.S.rejected,
     fixes:window.__tripp.S.fixes, still:window.__tripp.S.still}));
  await page.close();
  return {truth,measured,...st};
}
const pct=(m,t)=>t>0?((m-t)/t*100).toFixed(1)+'%':m.toFixed(1)+' m';
const rows=[];
async function T2(name,cfg,mode){ seed=4242; const r=await run(cfg,mode);
  rows.push([name, r.truth.toFixed(0)+' m', r.measured.toFixed(1)+' m', pct(r.measured,r.truth), r.src, r.rej]); }

console.log('== Mätnoggrannhet, simulerade banor (σ=5 m, korrelerat brus, 1 Hz) ==');
await T2('står stilla 180 s (doppler)', {kind:'still',secs:180,speed:0});
await T2('gång 1,4 m/s rakt 200 s',     {kind:'rak',secs:200,speed:1.4});
await T2('gång m. svängar 200 s',       {kind:'svangar',secs:200,speed:1.4});
await T2('gång runt kvarteret 200 s',   {kind:'kvarter',secs:200,speed:1.4});
await T2('blandat gå/stå 320 s',        {kind:'blandat',secs:320,speed:1.4});
await T2('långsam 0,7 m/s 200 s',       {kind:'rak',secs:200,speed:0.7});
await T2('löpning 3 m/s 200 s',         {kind:'rak',secs:200,speed:3.0},'lopning');
await T2('cykel 5,5 m/s kvarter',       {kind:'kvarter',secs:200,speed:5.5},'cykel');
await T2('bil 12 m/s svängar',          {kind:'svangar',secs:200,speed:12},'bil');
await T2('dålig signal σ=15 m, gång',   {kind:'rak',secs:200,speed:1.4,sigma:15});
await T2('[ingen doppler] står stilla', {kind:'still',secs:180,speed:0,withSpeed:false});
await T2('[ingen doppler] gång rakt',   {kind:'rak',secs:200,speed:1.4,withSpeed:false});
await T2('[ingen doppler] kvarteret',   {kind:'kvarter',secs:200,speed:1.4,withSpeed:false});
await T2('[ingen doppler] blandat',     {kind:'blandat',secs:320,speed:1.4,withSpeed:false});
const w=[32,9,10,9,12,4];
console.log(['scenario','sant','mätt','fel','källa','kast'].map((h,i)=>h.padEnd(w[i])).join(''));
for(const r of rows) console.log(r.map((c,i)=>String(c).padEnd(w[i])).join(''));
console.log('(doppler = GPS:ens egen hastighet; regression = skattad ur positionerna)');

/* --- robusthet: skräpfix --- */
seed=99;
{ const page=await newPage();
  const {fixes}=makeFixes({kind:'rak',secs:60,speed:1.4});
  await page.evaluate(f=>window.__feed(f),fixes);
  const before=await dist(page);
  const last=fixes[fixes.length-1];
  await page.evaluate(l=>window.__feed([{lat:l.lat+5000/111132.95,lng:l.lng,acc:5,speed:2,t:l.t+1000}]),last);
  const afterJump=await dist(page);
  await page.evaluate(l=>window.__feed([{lat:l.lat+300/111132.95,lng:l.lng,acc:80,speed:2,t:l.t+2000}]),last);
  const afterBad=await dist(page);
  const banner=await page.textContent('#banner');
  console.log('\n== Robusthet ==');
  console.log('5 km-teleport lade till:', (afterJump-before).toFixed(2),'m');
  console.log('fix med acc 80 m lade till:', (afterBad-afterJump).toFixed(2),'m');
  console.log('varning visas:', JSON.stringify(banner.slice(0,60)));
  await page.close(); }

/* --- UI-flöden med riktig Playwright-geolokalisering --- */
{ const page=await ctx.newPage();
  page.on('pageerror',e=>errs.push('PAGEERROR: '+e.message));
  await page.goto('http://localhost:8099/',{waitUntil:'load'});
  await page.evaluate(()=>localStorage.clear());
  await page.reload({waitUntil:'load'});
  await page.click('#startBtn');
  await page.evaluate(()=>{ const S=window.__tripp.S;
    S.total=0;S.track=[];S.buf=[];S.origin=null;S.last=null;S.anchor=null;
    S.movingMs=0;S.maxSpeed=0;S.fixes=0;S.rejected=0;S.elapsed=0; });
  for(let i=0;i<12;i++){ await ctx.setGeolocation({latitude:LAT0+i*2/MLAT,longitude:LNG0,accuracy:5});
    await page.waitForTimeout(600); }
  const ui={};
  ui.distText=await page.textContent('#dist');
  ui.status=await page.textContent('#gpsTxt');
  ui.trackPoints=await page.evaluate(()=>window.__tripp.S.track.length);
  ui.mapDrawn=await page.evaluate(()=>{const c=document.getElementById('map');
    const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let on=0;
    for(let i=3;i<d.length;i+=4)if(d[i]>0)on++;return on>500;});
  await page.click('#startBtn'); ui.pausedBtn=await page.textContent('#startBtn');
  const dl=page.waitForEvent('download',{timeout:8000}).catch(()=>null);
  await page.click('#exportBtn'); const d=await dl;
  if(d){const gpxTxt=fs.readFileSync(await d.path(),'utf8');
    ui.gpx={name:d.suggestedFilename(),pts:(gpxTxt.match(/<trkpt/g)||[]).length,
      valid:gpxTxt.startsWith('<?xml')&&gpxTxt.includes('</gpx>')};}
  const before=await page.evaluate(()=>window.__tripp.S.total);
  await page.reload({waitUntil:'load'}); await page.waitForTimeout(400);
  ui.persisted=Math.abs(await page.evaluate(()=>window.__tripp.S.total)-before)<0.001;
  await page.click('#settings summary'); await page.click('button[data-mode="cykel"]');
  await page.evaluate(()=>{const s=document.getElementById('minMove');s.value='2.2';
    s.dispatchEvent(new Event('input'));});
  await page.reload({waitUntil:'load'}); await page.waitForTimeout(300);
  ui.settingsPersisted=await page.evaluate(()=>({mode:window.__tripp.S.mode,minMove:window.__tripp.S.minMove}));
  await page.click('#resetBtn'); ui.resetNeedsConfirm=(await page.evaluate(()=>window.__tripp.S.total))>0;
  await page.click('#resetBtn'); ui.afterReset=await page.evaluate(()=>window.__tripp.S.total);
  ui.manifest=await page.evaluate(async()=>(await fetch('manifest.webmanifest')).status);
  await page.screenshot({path:path.join(ROOT,'test','skarmdump.png')});
  console.log('\n== UI ==\n'+JSON.stringify(ui,null,2));
  await page.close(); }

console.log('\nkonsolfel:', errs.length?errs:'inga');
await browser.close(); server.close();
