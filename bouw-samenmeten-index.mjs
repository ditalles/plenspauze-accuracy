/**
 * bouw-samenmeten-index.mjs — eenmalig een index bouwen van de burgersensoren
 * van het RIVM (Samen Meten), zodat de logger per ronde alleen nog de meting
 * hoeft op te halen.
 *
 * Waarom een index en geen zoekopdracht per keer: de API ondersteunt geen
 * geo-filter (`geo.distance` geeft `value: null` terug), dus je kunt niet vragen
 * "welke sensor staat bij Westzaan". Je moet de lijst zelf hebben.
 *
 * Twee lijsten worden gekoppeld op stationsnaam, want die zit in de naam van de
 * datastream verwerkt: `LTD_94083-6-rh` hoort bij station `LTD_94083`. Geneste
 * expand (`Thing($expand=Locations)`) doet deze server niet.
 *
 * Draaien:  node bouw-samenmeten-index.mjs
 * Levert:   samenmeten-index.json
 */
import { writeFile } from 'node:fs/promises';

const API = 'https://api-samenmeten.rivm.nl/v1.0';

// De server negeert $top=1000 en levert 200 per pagina; 24.297 locaties zijn
// dus ~122 pagina's. Met 60 stopte de index halverwege — dat was niet te zien
// aan de uitkomst, alleen aan het rekensommetje.
async function haalAlles(pad, maxPaginas = 200) {
  const uit = [];
  let url = `${API}/${pad}`;
  for (let p = 0; p < maxPaginas && url; p++) {
    const r = await fetch(url);
    if (!r.ok) break;
    const j = await r.json();
    uit.push(...(j.value ?? []));
    url = j['@iot.nextLink'] ?? null;
    process.stdout.write(`\r  ${pad.split('?')[0]}: ${uit.length}`);
  }
  process.stdout.write('\n');
  return uit;
}

/** `LTD_94083-6-rh` → `LTD_94083` */
function stationVan(datastreamNaam) {
  return datastreamNaam.replace(/-\d+-(rh|pres|temp)$/, '');
}

const streams = {};
for (const soort of ['rh', 'pres']) {
  const ds = await haalAlles(
    `Datastreams?%24filter=endswith(name,'-${soort}')&%24top=1000&%24select=name,%40iot.id`,
  );
  for (const d of ds) {
    const st = stationVan(d.name);
    streams[st] ??= {};
    streams[st][soort] = d['@iot.id'];
  }
}

const locaties = await haalAlles('Locations?%24expand=Things&%24top=1000');

const index = [];
for (const l of locaties) {
  const c = l.location?.coordinates;
  // [0,0] en andere onzin overslaan: sommige sensoren zijn nooit ingesteld.
  if (!c || c.length < 2 || Math.abs(c[0]) < 1 || Math.abs(c[1]) < 1) continue;
  for (const t of l.Things ?? []) {
    const s = streams[t.name];
    if (!s) continue;
    index.push({ station: t.name, lon: c[0], lat: c[1], rh: s.rh ?? null, pres: s.pres ?? null });
  }
}

// Alleen Nederland; er staan ook sensoren over de grens in.
const nl = index.filter((s) => s.lat > 50.5 && s.lat < 54 && s.lon > 3 && s.lon < 7.5);

await writeFile('samenmeten-index.json', JSON.stringify(nl));
console.log(`\n${nl.length} sensoren in de index`);
console.log(`  met vochtigheid: ${nl.filter((s) => s.rh).length}`);
console.log(`  met luchtdruk:   ${nl.filter((s) => s.pres).length}`);
