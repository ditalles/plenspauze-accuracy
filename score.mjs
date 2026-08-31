/**
 * score.mjs — leest alle data/*.ndjson en scoort de nowcasts achteraf tegen
 * DRIE meetlatten:
 *   1. STATION-meetlat     — het dichtstbijzijnde KNMI/RWS-station (tot ~15 km weg).
 *   2. RADAR-meetlat        — de neerslagradar op je EXACTE punt (hyperlokaal).
 *   3. EDR-STATION-meetlat  — KNMI's officiële 10-minuten stationsnet (77 stations,
 *      CC BY 4.0). Vervangt de Buienradar-stationfeed (40 stations, niet-commercieel).
 *   4. REGENMETER-meetlat   — het meetnet van de waterschappen. Gemiddeld 4,4 km
 *      i.p.v. 8,5 km bij het KNMI-net, en bij Westzaan 2,8 km i.p.v. 14,2 km.
 *      Een échte regenmeter (geen radar), dus onafhankelijk van elke voorspelbron.
 *
 * De radar-op-punt leiden we af uit de Buienradar-nowcast die per opname is
 * gelogd: de waarde op t≈0 (mAhead ~ 0) is het radarbeeld op dat punt op dat
 * moment. Zo hebben we voor elk voorspelpunt een meting ter plekke, zonder het
 * 15 km-gat van een los station. Radar is niet perfect (over-/onderschat, geen
 * gauge-adjust), maar op-punt is het veel eerlijker dan een ver station.
 *
 * LET OP circulariteit: de radar-meetlat komt uit dezelfde bron als de
 * 'Buienradar'-voorspelkolom, dus die rij is onder de radar-meetlat een
 * zelf-vergelijking (gunstig) — enkel de Plenspauze/KNMI-rijen zijn een eerlijke,
 * onafhankelijke toets tegen de radar.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const WET = 0.1;            // mm/u drempel "regen"
const HORIZONS = [15, 30, 60, 90];
const OBS_TOL = 8 * 60000;  // meting mag ±8 min van het doeltijdstip liggen

// ── Inlezen ──────────────────────────────────────────────────────────────────
const dataDir = join(ROOT, 'data');
let files = [];
try {
  files = (await readdir(dataDir)).filter((f) => f.endsWith('.ndjson'));
} catch {
  console.error('Geen data/-map. Draai eerst `npm run log` (of laat de Action lopen).');
  process.exit(1);
}
const records = [];
for (const f of files) {
  const txt = await readFile(join(dataDir, f), 'utf8');
  for (const line of txt.split('\n')) {
    if (line.trim()) try { records.push(JSON.parse(line)); } catch {}
  }
}
if (!records.length) { console.error('Nog geen records.'); process.exit(1); }

// ── Radar-op-punt uit een opname: de Buienradar-nowcast-waarde op t≈0 ─────────
function nowFrom(pts) {
  if (!pts || !pts.length) return null;
  let best = null, bestD = Infinity;
  for (const p of pts) {
    const d = Math.abs(p.mAhead);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best && bestD <= 5 ? best.mmh : null;
}
const radarNowFromRecord = (r) => nowFrom(r.buienradar);
const knmiRadarNowFromRecord = (r) => nowFrom(r.knmiradar);

// ── Observatie-indexen per locatie (station + radar) ─────────────────────────
function buildIndex(valueFn) {
  const map = new Map();
  for (const r of records) {
    const v = valueFn(r);
    if (v == null) continue;
    if (!map.has(r.loc)) map.set(r.loc, []);
    map.get(r.loc).push({ epoch: r.epoch, mmh: v });
  }
  for (const arr of map.values()) arr.sort((a, b) => a.epoch - b.epoch);
  return map;
}
const stationIdx = buildIndex((r) => r.station?.regenNu ?? null);

// De regenmeters hebben hun EIGEN meettijd (het bestand loopt ~31 min achter),
// dus indexeren op r.epoch zou de meting op het verkeerde moment plakken.
// Beide bronnen dragen hun eigen meettijd; indexeren op r.epoch zou de meting
// op het verkeerde moment plakken.
function idxOpEigenTijd(veld, waardeFn) {
  const map = new Map();
  const gezien = new Set();
  for (const r of records) {
    const w = r[veld];
    if (!w || !w.tijd) continue;
    const v = waardeFn(w);
    if (v == null) continue;
    const epoch = Date.parse(w.tijd);
    if (!Number.isFinite(epoch)) continue;
    const sleutel = `${r.loc}|${epoch}`;
    if (gezien.has(sleutel)) continue;
    gezien.add(sleutel);
    if (!map.has(r.loc)) map.set(r.loc, []);
    map.get(r.loc).push({ epoch, mmh: v });
  }
  for (const arr of map.values()) arr.sort((a, b) => a.epoch - b.epoch);
  return map;
}
const edrIdx = idxOpEigenTijd('edrstation', (w) => w.regenNu);

const waterschapIdx = (() => {
  const map = new Map();
  const gezien = new Set();
  for (const r of records) {
    const w = r.waterschap;
    if (!w || w.mmh == null || !w.tijd) continue;
    const epoch = Date.parse(w.tijd);
    if (!Number.isFinite(epoch)) continue;
    // Elke meting komt in meerdere opnames terug; één keer tellen.
    const sleutel = `${r.loc}|${epoch}`;
    if (gezien.has(sleutel)) continue;
    gezien.add(sleutel);
    if (!map.has(r.loc)) map.set(r.loc, []);
    map.get(r.loc).push({ epoch, mmh: w.mmh });
  }
  for (const arr of map.values()) arr.sort((a, b) => a.epoch - b.epoch);
  return map;
})();
const radarIdx = buildIndex(radarNowFromRecord);
const knmiRadarIdx = buildIndex(knmiRadarNowFromRecord);

function obsAtFactory(idx) {
  return (loc, epoch) => {
    const arr = idx.get(loc);
    if (!arr) return null;
    let best = null, bestD = Infinity;
    for (const o of arr) {
      const d = Math.abs(o.epoch - epoch);
      if (d < bestD) { bestD = d; best = o; }
    }
    return best && bestD <= OBS_TOL ? best : null;
  };
}

// Voorspelpunt het dichtst bij horizon h (binnen ±10 min).
function predAt(points, h) {
  if (!points || !points.length) return null;
  let best = null, bestD = Infinity;
  for (const p of points) {
    const d = Math.abs(p.mAhead - h);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best && bestD <= 10 ? best : null;
}

// ── Scoren tegen een gegeven meetlat ─────────────────────────────────────────
function blankStats() { return { n: 0, hit: 0, miss: 0, fa: 0, cn: 0, obsWet: 0 }; }
const SOURCES = ['ours', 'knmi', 'buienradar', 'knmiradar'];

function scoreAgainst(obsAt) {
  const stats = Object.fromEntries(
    SOURCES.map((s) => [s, Object.fromEntries(HORIZONS.map((h) => [h, blankStats()]))]),
  );
  for (const r of records) {
    for (const h of HORIZONS) {
      const obs = obsAt(r.loc, r.epoch + h * 60000);
      if (!obs) continue;
      const obsWet = obs.mmh >= WET;
      for (const src of SOURCES) {
        const p = predAt(r[src], h);
        if (!p) continue;
        const s = stats[src][h];
        s.n++;
        if (obsWet) s.obsWet++;
        const predWet = p.mmh >= WET;
        if (predWet && obsWet) s.hit++;
        else if (!predWet && obsWet) s.miss++;
        else if (predWet && !obsWet) s.fa++;
        else s.cn++;
      }
    }
  }
  return stats;
}

const stationStats = scoreAgainst(obsAtFactory(stationIdx));
const waterschapStats = scoreAgainst(obsAtFactory(waterschapIdx));
const edrStats = scoreAgainst(obsAtFactory(edrIdx));
const radarStats = scoreAgainst(obsAtFactory(radarIdx));
const knmiRadarStats = scoreAgainst(obsAtFactory(knmiRadarIdx));

// ── Rapport ──────────────────────────────────────────────────────────────────
function pct(x, y) { return y ? `${Math.round((100 * x) / y)}%` : '—'; }
function row(name, s, note = '') {
  const pod = pct(s.hit, s.hit + s.miss);
  const far = pct(s.fa, s.hit + s.fa);
  const acc = pct(s.hit + s.cn, s.n);
  return `    ${name.padEnd(12)} ACC ${acc.padStart(4)}   trefkans ${pod.padStart(4)}   vals-alarm ${far.padStart(4)}   (n=${s.n}, regen=${s.obsWet})${note}`;
}

const e = records.map((r) => r.epoch).sort((a, b) => a - b);
const hrs = ((e[e.length - 1] - e[0]) / 3600000).toFixed(0);
console.log(`\n📊 Plenspauze accuratesse-rapport`);
console.log(`   ${records.length} opnames · ${hrs} uur · ${stationIdx.size} locaties · drempel ${WET} mm/u`);

function block(title, stats, rows) {
  console.log(`\n══ ${title} ══`);
  for (const h of HORIZONS) {
    console.log(`  ▸ ${h} min vooruit:`);
    for (const [label, key, note] of rows) console.log(row(label, stats[key][h], note));
  }
}

const ROWS = [
  ['Plenspauze', 'ours', ''],
  ['KNMI-model', 'knmi', ''],
  ['Buienradar', 'buienradar', ''],
  ['KNMI-radar', 'knmiradar', ''],
];

block('STATION-MEETLAT (dichtstbijzijnde station, tot ~15 km)', stationStats,
  ROWS.map((r) => (r[1] === 'buienradar' ? [r[0], r[1], '  ← app: vooruitblik'] : r)));

const edrN = [...edrIdx.values()].reduce((a, b) => a + b.length, 0);
if (edrN) {
  block(`EDR-STATION-MEETLAT · KNMI 10-min (${edrN} metingen · 77 stations, CC BY 4.0)`,
    edrStats, ROWS);
} else {
  console.log('\n══ EDR-STATION-MEETLAT · KNMI 10-min ══');
  console.log('    Nog geen metingen verzameld — deze bron is net toegevoegd.');
}

const meters = [...waterschapIdx.values()].reduce((a, b) => a + b.length, 0);
if (meters) {
  block(`REGENMETER-MEETLAT · waterschappen (${meters} metingen · echte regenmeter)`,
    waterschapStats, ROWS);
} else {
  console.log('\n══ REGENMETER-MEETLAT · waterschappen ══');
  console.log('    Nog geen metingen verzameld — deze bron is net toegevoegd.');
}

block('RADAR-MEETLAT · Buienradar (op je punt)', radarStats,
  ROWS.map((r) => (r[1] === 'buienradar' ? [r[0], r[1], '  ⚠ circulair'] : r)));

block('OFFICIËLE KNMI-RADAR-MEETLAT (op je exacte punt · de eerlijkste)', knmiRadarStats,
  ROWS.map((r) => (r[1] === 'knmiradar' ? [r[0], r[1], '  ⚠ circulair'] : r)));

console.log('\n  Leeswijzer: trefkans (POD) = % echte buien dat vooraf voorspeld werd,');
console.log('  vals-alarm (FAR) = % regen-voorspellingen dat tóch droog bleef. Hoog trefkans +');
console.log('  laag vals-alarm = goed. Vergelijk de twee meetlatten: hoeveel van het "vals');
console.log('  alarm" onder het station was gewoon het 15 km-gat? Onder de radar-meetlat');
console.log('  meet je hyperlokaal — dát is de eerlijke toets voor Plenspauze/KNMI.');
console.log('  De REGENMETER-meetlat is de enige die niet van radar afhangt: een echte');
console.log('  emmer die leegloopt, gemiddeld 4,4 km bij je vandaan. Wijkt die sterk af');
console.log('  van de radar-meetlatten, dan zit het verschil in de radar, niet in de app.\n');
