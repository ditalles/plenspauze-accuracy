/**
 * afstand.mjs — hoeveel is nabijheid waard?
 *
 * De regenmeters staan gemiddeld 7 km weg en voorspellen jouw volgende kwartier
 * nauwelijks. De vraag die daaronder ligt: komt dat door de afstand, of doordat
 * "het regent hier nu" sowieso weinig zegt over straks?
 *
 * Dat is het verschil tussen "dichtere sensoren hebben zin" en "meer van
 * hetzelfde". Samen Meten zit op 0,9 km — als de kromme steil is, is dat
 * interessant; als hij vlak is, is die 0,9 km niets waard.
 *
 * Meetlat blijft het KNMI-station: ander instrument dan de regenmeter.
 */
import { readdir, readFile } from 'node:fs/promises';

const WET = 0.1;
const TOL = 8 * 60000;
const BAKKEN = [[0, 3], [3, 6], [6, 10], [10, 99]];

const records = [];
for (const f of (await readdir('data')).filter((f) => f.endsWith('.ndjson')).sort()) {
  for (const r of (await readFile(`data/${f}`, 'utf8')).split('\n')) {
    if (r.trim()) try { records.push(JSON.parse(r)); } catch {}
  }
}
const perLoc = {};
for (const r of records) (perLoc[r.loc] ??= []).push(r);
for (const v of Object.values(perLoc)) v.sort((a, b) => a.epoch - b.epoch);

function stationOp(loc, epoch) {
  let best = null, bestD = Infinity;
  for (const r of perLoc[loc]) {
    const d = Math.abs(r.epoch - epoch);
    if (d < bestD && r.station?.regenNu != null) { bestD = d; best = r; }
  }
  return bestD <= TOL ? best.station.regenNu : null;
}

for (const h of [15, 60]) {
  console.log(`\n▸ "regenmeter is NU nat" als voorspelling voor ${h} min vooruit`);
  console.log('   afstand        n      trefkans   vals-alarm   CSI');
  for (const [lo, hi] of BAKKEN) {
    let hit = 0, miss = 0, fa = 0, n = 0;
    for (const r of records) {
      const w = r.waterschap;
      if (!w || w.mmh == null || w.afstandKm == null) continue;
      if (!(w.afstandKm >= lo && w.afstandKm < hi)) continue;
      const echt = stationOp(r.loc, r.epoch + h * 60000);
      if (echt == null) continue;
      n++;
      const zegt = w.mmh >= WET, nat = echt >= WET;
      if (zegt && nat) hit++; else if (!zegt && nat) miss++; else if (zegt && !nat) fa++;
    }
    if (n < 200) { console.log(`   ${lo}-${hi} km`.padEnd(14) + `${n}  te weinig`); continue; }
    const pod = hit / (hit + miss) || 0, far = fa / (hit + fa) || 0;
    const csi = hit / (hit + miss + fa) || 0;
    console.log(
      `   ${(lo + '-' + hi + ' km').padEnd(12)} ${String(n).padStart(6)}   ` +
      `${(pod * 100).toFixed(0).padStart(5)}%      ${(far * 100).toFixed(0).padStart(5)}%    ${(csi * 100).toFixed(0).padStart(3)}%`,
    );
  }
}
console.log();
