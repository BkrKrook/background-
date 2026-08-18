# Sorenta 4.0 - trippmätare

En trippmätare för telefonen: den räknar **hur många meter du rör dig**, så exakt
som telefonens GPS tillåter. En enda HTML-fil, inget konto, inget nät efter första
laddningen, inga externa bibliotek.

![Sorenta 4.0 i drift](skarmdump.png)

*Skärmdumpen genereras av `npm run skarmdump`. Kartrutorna i bilden ritas lokalt av
skriptet — byggmiljön har ingen åtkomst till OpenStreetMaps servrar, och en testsvit
ska inte belasta dem. På telefonen visas den riktiga OSM-kartan.*

## Använd den

1. Öppna sidan på telefonen (se *Publicera* nedan) — **måste vara `https://`**,
   annars vägrar webbläsaren lämna ut GPS.
2. Tryck **Starta** och godkänn platsåtkomst (välj *Exakt plats* om iOS frågar).
3. Vänta tills pricken uppe till höger blir grön (15–30 s första gången — GPS:en
   låser på satelliter). Sedan är varje meter du går med i sträckan.

Lägg gärna till sidan på hemskärmen (*Dela → Lägg till på hemskärmen*). Då startar
den i helskärm utan flikar, heter **Sorenta 4.0** under ikonen, och fungerar offline.

**Skärmen måste vara tänd.** Mobila webbläsare stoppar GPS-uppdateringar när
skärmen släcks — appen håller därför skärmen tänd åt dig (kan stängas av i
inställningarna). Bara en native-app kan mäta med släckt skärm.

## Om appen inte får din position

Får du **GPS nekades** utan att telefonen någonsin frågat om plats, sitter spärren i
telefonens inställningar — webbläsaren hinner svara nej innan den visar en dialog.

**iPhone:** Inställningar → Integritetsskydd & säkerhet → **Platstjänster** → slå på.
Scrolla ner till **Safari-webbplatser** → välj **Medan appen används** och slå på
**Exakt plats**. Utan *Exakt plats* får appen bara en grov position på hundratals meter,
och då kastas nästan alla fix av noggrannhetsgrinden.

Har du nekat sidan en gång kommer frågan inte tillbaka av sig själv: tryck på ikonen till
vänster i adressfältet → **Webbplatsinställningar** → **Plats** → *Fråga* eller *Tillåt*.

**Android:** tryck på låset i adressfältet → Behörigheter → **Plats** → Tillåt.

Appen visar samma vägbeskrivning i en röd ruta när den blir nekad, med en **Försök igen**-knapp
som gör om försöket utan att du behöver ladda om sidan. Mätningen stoppas samtidigt, så
klockan inte tickar på en mätning som aldrig kom igång.

Adressen måste dessutom vara `https://` — på `http://` lämnar webbläsaren aldrig ut GPS.

## Så mäts sträckan

Att bara summera avstånden mellan GPS-punkter ger kraftigt uppblåsta värden: GPS:ens
brus är tidskorrelerat, så positionen vandrar flera meter fram och tillbaka även när
du står helt still. Testsviten mäter den naiva metoden som jämförelse — den samlar på
sig **932 m på tre minuter stillastående**, och gör en promenad på 280 m till 1 064 m.
Sorenta 4.0 gör i stället så här:

1. **Noggrannhetsgrind** — fix sämre än gränsen (25 m som standard) kastas helt.
2. **Kalman-filter** på positionen, med processbrus anpassat efter rörelsetyp.
   Filtrerade positioner används till kartan och GPX-spåret.
3. **Hastighet i första hand från dopplerskift.** `coords.speed` från telefonens
   GPS är en dopplermätning — samma princip som en bils GPS-hastighetsmätare — och
   är betydligt exaktare än att derivera positionen. Sträckan blir integralen av
   hastigheten: `Σ v·Δt`.
4. **Regression som reserv.** Saknar enheten hastighet (vissa datorer) skattas den
   med minsta-kvadratanpassning av positionen mot tiden över de senaste 13 sekunderna
   — mycket stabilare än att ta avståndet mellan två punkter.
5. **Stillhetsveto** — har nettoförflyttningen under de senaste 25 sekunderna (20 s i
   regressionsläget) varit mindre än 2,5 × positionsosäkerheten, och den utjämnade
   farten är låg, räknas ingenting alls. Det är detta som gör att mätaren står stilla
   när du står stilla.
6. **Rimlighetsspärr före filtret** — hopp som innebär högre fart än rörelsetypen
   tillåter (t.ex. 200 km/h i läget Gång) kastas som skräpfix. Kontrollen görs på den
   råa positionen *innan* Kalman-filtret, annars skulle ett enda skräpfix dra med sig
   filtret och få de närmast följande korrekta fixen att också se ut som hopp. En
   brusmarginal på 2 × noggrannheten dras av först, så att vanligt mätbrus inte
   misstas för ett hopp — på en ren bana kastas noll korrekta fix.
7. **Datalucka** — om det gått mer än 10 s mellan godkända fix (släckt skärm, tunnel,
   tappad signal) finns ingen hastighet att integrera. Då mäts den faktiska
   förflyttningen i stället, men bara om den är större än mätbruset, och sträcka och
   tid bokförs mot samma intervall så att snitthastigheten inte blåses upp.

Spåret som ritas och exporteras rymmer 8 000 punkter. På riktigt långa turer gallras den
äldsta halvan (varannan punkt behålls) i stället för att början kapas bort, så spåret
alltid täcker hela turen — grövre längst bak, men helt. Sträckan påverkas inte alls av
gallringen, den räknas ur hastigheten och inte ur spårpunkterna.

### Uppmätt noggrannhet

`npm run test:matning` kör appen i en riktig webbläsare mot simulerade banor med känd
längd (σ = 5 m positionsbrus, korrelation 0,6, 1 Hz, dopplerbrus 0,3 m/s):

| Scenario | Sant | Mätt | Fel | Naivt |
|---|---|---|---|---|
| står stilla 3 min | 0 m | 6,2 m | +6,2 m | 932 m |
| gång 1,4 m/s, rakt | 280 m | 280,2 m | +0,1 % | 1 064 m |
| gång med svängar | 280 m | 280,2 m | +0,1 % | 1 069 m |
| gång runt kvarteret | 280 m | 280,2 m | +0,1 % | 1 066 m |
| blandat gå/stå | 224 m | 221,8 m | −1,0 % | 1 722 m |
| långsam gång 0,7 m/s | 140 m | 139,8 m | −0,1 % | 1 049 m |
| löpning 3 m/s | 600 m | 598,6 m | −0,2 % | 1 151 m |
| cykel 5,5 m/s | 1 100 m | 1 096,1 m | −0,4 % | 1 437 m |
| bil 12 m/s | 2 400 m | 2 389,6 m | −0,4 % | 2 531 m |
| dålig signal σ = 15 m | 280 m | 280,2 m | +0,1 % | 3 139 m |
| 60 s datalucka mitt i | 280 m | 286,5 m | +2,3 % | 822 m |
| datalucka stillastående | 0 m | 3,1 m | +3,1 m | 726 m |
| skräpfix 3 km mitt i | 280 m | 280,2 m | +0,1 % | 7 057 m |
| *utan doppler:* står stilla | 0 m | 13,3 m | +13,3 m | 978 m |
| *utan doppler:* gång rakt | 280 m | 300,1 m | +7,2 % | 1 131 m |
| *utan doppler:* runt kvarteret | 280 m | 261,5 m | −6,6 % | 1 120 m |
| *utan doppler:* blandat gå/stå | 224 m | 236,1 m | +5,4 % | 1 789 m |
| *utan doppler:* med datalucka | 280 m | 298,1 m | +6,4 % | 897 m |

Kolumnen **naivt** är samma bana mätt genom att bara summera avstånden mellan de råa
fixen — alltså vad appen skulle visa utan någon filtrering alls.

Testet är inte bara utskrifter: varje rad har en tolerans, och `npm test` avslutar med
felkod om någon kontroll faller. Utöver banorna kontrolleras att skräpfix kastas utan
att korrekta fix dras med, att GPX-exporten är giltig, att sträckan överlever en
omladdning och att nollställningen kräver dubbeltryck — 35 kontroller totalt.

Parametrarna (vetofönster, trösklar, filterstyrka) är valda genom Monte
Carlo-svep över samma scenarier — inte gissade.

Verkligheten är stökigare än simuleringen: bland höga hus studsar signalen
(flervägsutbredning) och noggrannheten faller. Statusraden visar alltid vad GPS:en
själv rapporterar, så du ser när mätningen är att lita på.

## Kartan

Spåret ritas ovanpå kartbilder (rutor) från **OpenStreetMap**, så du ser var du gått och
hur långt det blev — inte bara en linje i tomma intet.

- **Följer automatiskt.** Kartan ramar in hela spåret och zoomar ut när det växer.
  Drar eller zoomar du själv släpper följningen; ⌖-knappen slår på den igen (knappen
  lyser när följningen är aktiv).
- **Dra, nyp och dubbeltryck** fungerar som i vilken karta som helst. ⤢ förstorar kartan
  till halva skärmen.
- **Noggrannhetscirkeln** runt din position visar hur säker GPS:en är just nu.
- **Skalstreck** nere till vänster, så du kan bedöma avstånd direkt i bilden.

Kartan är ritad direkt på en canvas i stället för med ett kartbibliotek: appen förblir
en enda fil utan beroenden, och den fungerar likadant när rutorna inte går att hämta.

**Datatrafik och offline.** Varje ruta är ungefär 15–30 kB. Service workern sparar de
rutor du redan sett i en egen cache (max 500 stycken), så kartan finns kvar över områden
du passerat även när täckningen tar slut — GPS:en i sig behöver inget nät. Vill du inte
lägga mobildata på kartbilder alls väljer du **Utan kartbild** under Inställningar; då
ritas spåret på tom bakgrund och mätningen påverkas inte alls.

**När rutorna inte går att hämta** — tunnel, tappad täckning, blockerat nät — vilar varje
misslyckad ruta innan den försöks igen (30 s, sedan dubbelt så länge för varje nytt fel),
och efter fem fel i rad slutar appen begära rutor helt och skriver *kartrutor kunde inte
hämtas* i kartans hörn. En minut senare provar den igen, så kartan kommer tillbaka av sig
själv när täckningen gör det. Utan den vilan skulle varje omritning begära samma trasiga
ruta på nytt — hundratals anrop i sekunden mot OSM:s servrar, rakt in i deras spärrar och
rakt ur telefonens batteri. Testsviten mäter just det: högst 40 anrop under tre sekunder
utan nät.

Kartdata © OpenStreetMap-bidragsgivarna, tillgängligt under
[Open Database License](https://www.openstreetmap.org/copyright). Attributionen visas med
den formuleringen i kartans hörn så länge kartbilder ritas, vilket OSM:s villkor kräver.

## Inställningar

| Inställning | Vad den gör |
|---|---|
| **Rörelsetyp** | Sätter filterstyrka och rimlighetsspärr. *Rå* stänger av Kalman-filtret helt. |
| **Kräv noggrannhet bättre än** | Fix med sämre rapporterad noggrannhet kastas. Lägre = strängare, men riskerar att kasta allt i skog och stadskärna. |
| **Räknas som rörelse över** | Dödband: fart under detta räknas som stillastående. Höj om mätaren kryper när du står still. (I regressionsläget gäller alltid minst 1,8 km/h, eftersom skattningen därifrån är brusigare.) |
| **Karta** | *OpenStreetMap* ritar kartbild under spåret. *Utan kartbild* hoppar över rutorna helt — sparar mobildata, mätningen är densamma. |
| **Håll skärmen tänd** | Wake Lock, så att GPS:en fortsätter leverera fix. |

Sträcka, spår och inställningar sparas löpande i `localStorage` — laddar sidan om
sig, eller trycker du fel, ligger allt kvar. **Nollställ** kräver dubbeltryck.
**Exportera GPX** ger en fil som kan öppnas i Strava, Garmin Connect, Google Earth
med flera.

## Publicera

Filerna är helt statiska — vilken https-värd som helst duger. Med GitHub Pages:

1. Repots **Settings → Pages**
2. *Source*: **Deploy from a branch**, branch `claude/tripp-meter-app-cypofz`, mapp `/ (root)`
3. Spara — appen hamnar på `https://<användarnamn>.github.io/background-/`

Lokalt: `npm run serve` och öppna `http://localhost:3000/` (GPS fungerar på
`localhost` utan https).

## Filer

| Fil | Innehåll |
|---|---|
| `index.html` | Hela appen — gränssnitt, filter, mätmotor, karta, GPX-export |
| `sw.js` | Service worker: cachar appen och sedda kartrutor för offline-bruk |
| `manifest.webmanifest`, `icon*.png`, `icon.svg` | Hemskärmsikon och app-läge |
| `test/accuracy.test.mjs` | Mätnoggrannhet och gränssnittsflöden mot simulerade banor |
| `test/karta.test.mjs` | Projektion, rutladdning, dra/nyp/zooma och reservläget utan nät |
| `test/skarmdump.mjs` | Genererar README-bilden |

## Kör testerna

```bash
npm install
npm test              # båda sviterna: 45 mätkontroller + 37 kartkontroller
npm run test:matning  # bara mätnoggrannheten
npm run test:karta    # bara kartan
npm run skarmdump     # uppdaterar README-bilden
```

Sätt `CHROMIUM=/sökväg/till/chrome` om webbläsaren inte hittas. Testerna avslutar med
felkod om något faller, och de anropar aldrig OpenStreetMaps riktiga servrar.
