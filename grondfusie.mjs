/**
 * grondfusie.mjs — helpen de open-source grondsensoren de VOORSPELLING, of
 * alleen de meetlat?
 *
 * De regenmeters van de waterschappen en de EDR-stations zijn tot nu toe alleen
 * gebruikt om te scoren. Dat is nuttig, maar het maakt de app geen haar beter.
 * De vraag die daar nooit bij gesteld is: voegt "er valt NU regen op een echte
 * meter zeven kilometer verderop" iets toe aan wat radar en model al zeggen?
 *
 * Opzet, met zorg voor circulariteit:
 *   INVOER   = regenmeter van het waterschap (een emmer, ~7 km weg)
 *   MEETLAT  = KNMI-station (een ánder instrument, op een ándere plek)
 * Die twee delen geen apparatuur, dus een verband is echt en geen spiegel.
 *
 * LET OP — hier ging het de eerste keer mis: de meter-kandidaten werden ook
 * afgerekend op opnames waar helemáál geen regenmeter was. Die voorspelden dan
 * per definitie "droog" en misten elke bui: CSI 9%, wat onzin is. Vergelijken
 * mag alleen op de opnames waar álle kandidaten hun invoer hebben. Dat kost
 * ~88% van de opnames, maar wat overblijft is een eerlijke vergelijking.
 *
 * Draaien:  node grondfusie.mjs
 */
import { readdir, readFile } from 'node:fs/promises';

const WET = 0.1;
const CONFIDENT = 0.5;
const HORIZONS = [15, 30, 60];
const TOL = 8 * 60000;

const records = [];
for (const f of (await readdir('data')).filter((f) => f.endsWith('.ndjson')).sort()) {
  for (const r of (await readFile(`data/${f}`, 'utf8')).split('\n')) {
    if (r.trim()) try { records.push(JSON.parse(r)); } catch {}
  }
}

// Waarheid: het station, geïndexeerd op tijd per locatie.
const perLoc = {};
for (const r of records) (perLoc[r.loc] ??= []).push(r);
for (const v of Object.values(perLoc)) v.sort((a, b) => a.epoch - b.epoch);

function stationOp(loc, epoch) {
  const reeks = perLoc[loc];
  let best = null, bestD = Infinity;
  for (const r of reeks) {
    const d = Math.abs(r.epoch - epoch);
    if (d < bestD && r.station?.regenNu != null) { bestD = d; best = r; }
  }
  return bestD <= TOL ? best.station.regenNu : null;
}

const bij = (reeks, m) => reeks?.find((p) => p.mAhead === m)
  ?? reeks?.sort((a, b) => Math.abs(a.mAhead - m) - Math.abs(b.mAhead - m))[0];

/** De kandidaten. `g` = regenmeter nu (mm/u), null als er geen meter was. */
const KANDIDATEN = {
  'meter + radar: radar tenzij meter droog EN radar licht':
                                  (rad, mod, g) => rad >= CONFIDENT || (rad >= WET && g >= WET),
  'radar (nu in app)':            (rad, mod, g) => rad >= WET,
  'model (KNMI)':                 (rad, mod, g) => mod >= WET,
  'FUSIE radar+model (beste tot nu toe)':
                                  (rad, mod, g) => rad >= CONFIDENT || (rad >= WET && mod >= WET),
  'regenmeter alleen (nu nat = straks nat)':
                                  (rad, mod, g) => g != null && g >= WET,
  'radar OF meter-nat':           (rad, mod, g) => rad >= WET || (g != null && g >= WET),
  'radar EN meter-nat':           (rad, mod, g) => rad >= WET && g != null && g >= WET,
  'FUSIE + meter als derde stem': (rad, mod, g) => {
    const stemmen = [rad >= WET, mod >= WET, g != null && g >= WET].filter(Boolean).length;
    return rad >= CONFIDENT || stemmen >= 2;
  },
  'FUSIE, meter mag licht vetoën': (rad, mod, g) =>
    rad >= CONFIDENT || (rad >= WET && mod >= WET && !(g != null && g < WET)),
};

console.log(`\n🔬 Helpen de grondsensoren de VOORSPELLING?`);
console.log(`   invoer: regenmeter waterschap · meetlat: KNMI-station (ander instrument)\n`);

for (const h of HORIZONS) {
  const tel = {};
  for (const k of Object.keys(KANDIDATEN)) tel[k] = { hit: 0, miss: 0, fa: 0, cn: 0 };
  let n = 0;

  for (const r of records) {
    const rad = bij(r.buienradar, h)?.mmh;
    const mod = bij(r.ours, h)?.mmh;
    if (rad == null || mod == null) continue;
    const g = r.waterschap?.mmh ?? null;
    // Alleen opnames waar élke kandidaat zijn invoer heeft. Zie de kop.
    if (g == null) continue;
    const echt = stationOp(r.loc, r.epoch + h * 60000);
    if (echt == null) continue;
    n++;
    const nat = echt >= WET;
    for (const [naam, f] of Object.entries(KANDIDATEN)) {
      const zegt = f(rad, mod, g);
      const t = tel[naam];
      if (zegt && nat) t.hit++; else if (!zegt && nat) t.miss++;
      else if (zegt && !nat) t.fa++; else t.cn++;
    }
  }

  const rijen = Object.entries(tel).map(([naam, t]) => {
    const csi = t.hit / (t.hit + t.miss + t.fa) || 0;
    return {
      naam, csi,
      pod: t.hit / (t.hit + t.miss) || 0,
      far: t.fa / (t.hit + t.fa) || 0,
    };
  }).sort((a, b) => b.csi - a.csi);

  console.log(`▸ ${h} min vooruit   (n=${n})`);
  for (const r of rijen) {
    console.log(
      `   CSI ${(r.csi * 100).toFixed(0).padStart(2)}%   trefkans ${(r.pod * 100).toFixed(0).padStart(3)}%   ` +
      `vals-alarm ${(r.far * 100).toFixed(0).padStart(3)}%   ${r.naam}`,
    );
  }
  console.log();
}
