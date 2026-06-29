/**
 * score.mjs — leest alle data/*.ndjson en scoort de nowcasts achteraf.
 *
 * Idee: een opname op tijd t0 voorspelt regen voor t0+h (h = 15/30/60/90 min).
 * De échte uitkomst op t0+h staat in de opname die rond dát tijdstip is gemaakt
 * (station.regenNu = gemeten mm/u). We koppelen voorspelling-voor-T aan meting-op-T
 * en berekenen per bron: trefkans (POD), vals alarm (FAR) en accuratesse (ACC).
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

// ── Observatie-index per locatie ─────────────────────────────────────────────
const obsByLoc = new Map();
for (const r of records) {
  if (r.station?.regenNu == null) continue;
  if (!obsByLoc.has(r.loc)) obsByLoc.set(r.loc, []);
  obsByLoc.get(r.loc).push({ epoch: r.epoch, mmh: r.station.regenNu });
}
for (const arr of obsByLoc.values()) arr.sort((a, b) => a.epoch - b.epoch);

function obsAt(loc, epoch) {
  const arr = obsByLoc.get(loc);
  if (!arr) return null;
  let best = null, bestD = Infinity;
  for (const o of arr) {
    const d = Math.abs(o.epoch - epoch);
    if (d < bestD) { bestD = d; best = o; }
  }
  return best && bestD <= OBS_TOL ? best : null;
}

// Voorspelpunt het dichtst bij horizon h (binnen ±10 min).
function predAt(points, h) {
  let best = null, bestD = Infinity;
  for (const p of points) {
    const d = Math.abs(p.mAhead - h);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best && bestD <= 10 ? best : null;
}

// ── Scoren ───────────────────────────────────────────────────────────────────
function blankStats() { return { n: 0, hit: 0, miss: 0, fa: 0, cn: 0, obsWet: 0 }; }
const stats = {
  ours: Object.fromEntries(HORIZONS.map((h) => [h, blankStats()])),
  buienradar: Object.fromEntries(HORIZONS.map((h) => [h, blankStats()])),
};

let pairs = 0;
for (const r of records) {
  for (const h of HORIZONS) {
    const obs = obsAt(r.loc, r.epoch + h * 60000);
    if (!obs) continue;
    const obsWet = obs.mmh >= WET;
    for (const src of ['ours', 'buienradar']) {
      const p = predAt(r[src], h);
      if (!p) continue;
      const predWet = p.mmh >= WET;
      const s = stats[src][h];
      s.n++;
      if (obsWet) s.obsWet++;
      if (predWet && obsWet) s.hit++;
      else if (!predWet && obsWet) s.miss++;
      else if (predWet && !obsWet) s.fa++;
      else s.cn++;
      if (src === 'ours') pairs++;
    }
  }
}

// ── Rapport ──────────────────────────────────────────────────────────────────
const span = (() => {
  const e = records.map((r) => r.epoch).sort((a, b) => a - b);
  const hrs = ((e[e.length - 1] - e[0]) / 3600000).toFixed(1);
  return `${records.length} opnames over ${hrs} uur, ${obsByLoc.size} locaties`;
})();

function pct(x, y) { return y ? `${Math.round((100 * x) / y)}%` : '—'; }
function row(name, s) {
  const pod = pct(s.hit, s.hit + s.miss);
  const far = pct(s.fa, s.hit + s.fa);
  const acc = pct(s.hit + s.cn, s.n);
  return `    ${name.padEnd(12)} ACC ${acc.padStart(4)}   trefkans ${pod.padStart(4)}   vals-alarm ${far.padStart(4)}   (n=${s.n}, regen-momenten=${s.obsWet})`;
}

console.log(`\n📊 Plenspauze accuratesse-rapport`);
console.log(`   ${span}`);
console.log(`   regen-drempel ${WET} mm/u · meting-tolerantie ±8 min\n`);

if (pairs < 20) {
  console.log('   ⚠ Nog weinig gekoppelde metingen — laat de logger langer draaien voor');
  console.log('     betrouwbare cijfers (idealiter een paar dagen, incl. natte periodes).\n');
}

for (const h of HORIZONS) {
  console.log(`  ▸ ${h} min vooruit:`);
  console.log(row('Plenspauze', stats.ours[h]));
  console.log(row('Buienradar', stats.buienradar[h]));
  console.log('');
}

console.log('  Leeswijzer: ACC = % juist (regen én droog). trefkans (POD) = % van de');
console.log('  echte buien dat vooraf voorspeld werd. vals-alarm (FAR) = % van de regen-');
console.log('  voorspellingen dat tóch droog bleef. Hoog ACC+trefkans, laag vals-alarm = goed.');
console.log('  Vergelijk de twee rijen: zit Plenspauze gelijk of beter dan Buienradar?\n');
