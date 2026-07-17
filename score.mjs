/**
 * score.mjs — leest alle data/*.ndjson en scoort de nowcasts achteraf tegen
 * TWEE meetlatten:
 *   1. STATION-meetlat  — het dichtstbijzijnde KNMI/RWS-station (tot ~15 km weg).
 *   2. RADAR-meetlat     — de neerslagradar op je EXACTE punt (hyperlokaal).
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
function radarNowFromRecord(r) {
  const pts = r.buienradar;
  if (!pts || !pts.length) return null;
  let best = null, bestD = Infinity;
  for (const p of pts) {
    const d = Math.abs(p.mAhead);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best && bestD <= 5 ? best.mmh : null;
}

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
const radarIdx = buildIndex(radarNowFromRecord);

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
const SOURCES = ['ours', 'knmi', 'buienradar'];

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
const radarStats = scoreAgainst(obsAtFactory(radarIdx));

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

block('STATION-MEETLAT (dichtstbijzijnde station, tot ~15 km)', stationStats, [
  ['Plenspauze', 'ours', ''],
  ['KNMI', 'knmi', ''],
  ['Buienradar', 'buienradar', ''],
]);

block('RADAR-MEETLAT (op je exacte punt · hyperlokaal)', radarStats, [
  ['Plenspauze', 'ours', ''],
  ['KNMI', 'knmi', ''],
  ['Buienradar', 'buienradar', '  ⚠ deelt bron (circulair)'],
]);

console.log('\n  Leeswijzer: trefkans (POD) = % echte buien dat vooraf voorspeld werd,');
console.log('  vals-alarm (FAR) = % regen-voorspellingen dat tóch droog bleef. Hoog trefkans +');
console.log('  laag vals-alarm = goed. Vergelijk de twee meetlatten: hoeveel van het "vals');
console.log('  alarm" onder het station was gewoon het 15 km-gat? Onder de radar-meetlat');
console.log('  meet je hyperlokaal — dát is de eerlijke toets voor Plenspauze/KNMI.\n');
