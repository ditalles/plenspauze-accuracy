/**
 * fusion.mjs — zoekt de béste "motor" door kandidaten op de bestaande data te
 * scoren: model alleen, radar alleen, en verschillende radar+model-fusies.
 * Rangschikt op CSI (Critical Success Index = hits/(hits+miss+fa)) — de maat
 * die zowel missen als vals alarm bestraft. Onafhankelijke meetlat = het station
 * (los van zowel radar als model), dus een eerlijke ranking (al is 'ie grof).
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const WET = 0.1;        // mm/u drempel "regen"
const CONFIDENT = 0.5;  // mm/u — radar "zeker regen"
const HORIZONS = [15, 30, 60, 90];
const OBS_TOL = 8 * 60000;

// ── Inlezen ──
const dataDir = join(ROOT, 'data');
const files = (await readdir(dataDir)).filter((f) => f.endsWith('.ndjson'));
const records = [];
for (const f of files) {
  for (const line of (await readFile(join(dataDir, f), 'utf8')).split('\n')) {
    if (line.trim()) try { records.push(JSON.parse(line)); } catch {}
  }
}

// ── Station-waarheid (onafhankelijk) ──
const idx = new Map();
for (const r of records) {
  if (r.station?.regenNu == null) continue;
  (idx.get(r.loc) ?? idx.set(r.loc, []).get(r.loc)).push({ epoch: r.epoch, mmh: r.station.regenNu });
}
for (const a of idx.values()) a.sort((x, y) => x.epoch - y.epoch);
function obsAt(loc, epoch) {
  const a = idx.get(loc); if (!a) return null;
  let best = null, bd = Infinity;
  for (const o of a) { const d = Math.abs(o.epoch - epoch); if (d < bd) { bd = d; best = o; } }
  return best && bd <= OBS_TOL ? best.mmh : null;
}
function predAt(points, h) {
  if (!points?.length) return null;
  let best = null, bd = Infinity;
  for (const p of points) { const d = Math.abs(p.mAhead - h); if (d < bd) { bd = d; best = p; } }
  return best && bd <= 10 ? best.mmh : null;
}

// ── Kandidaat-motoren: (radarMmh, modelMmh) → voorspelt regen? ──
const CANDIDATES = {
  'model (KNMI)':          (r, m) => m >= WET,
  'radar (nu in app)':     (r, m) => r >= WET,
  'OR (een van beide)':    (r, m) => r >= WET || m >= WET,
  'AND (beide)':           (r, m) => r >= WET && m >= WET,
  'gemiddelde':            (r, m) => (r + m) / 2 >= WET,
  'FUSIE: radar-zeker OF (radar-licht & model)':
                           (r, m) => r >= CONFIDENT || (r >= WET && m >= WET),
  'FUSIE: radar, maar model-veto bij licht':
                           (r, m) => r >= CONFIDENT || (r >= WET && m >= 0.05),
};

const stats = {};
for (const name of Object.keys(CANDIDATES))
  stats[name] = Object.fromEntries(HORIZONS.map((h) => [h, { hit: 0, miss: 0, fa: 0, cn: 0 }]));

for (const r of records) {
  for (const h of HORIZONS) {
    const obs = obsAt(r.loc, r.epoch + h * 60000);
    if (obs == null) continue;
    const radar = predAt(r.buienradar, h);
    const model = predAt(r.ours, h);
    if (radar == null || model == null) continue;
    const obsWet = obs >= WET;
    for (const [name, fn] of Object.entries(CANDIDATES)) {
      const wet = fn(radar, model);
      const s = stats[name][h];
      if (wet && obsWet) s.hit++;
      else if (!wet && obsWet) s.miss++;
      else if (wet && !obsWet) s.fa++;
      else s.cn++;
    }
  }
}

const pct = (x, y) => (y ? Math.round((100 * x) / y) : 0);
console.log(`\n🔬 Motor-vergelijking op ${records.length} opnames · meetlat: station (onafhankelijk)\n`);
for (const h of HORIZONS) {
  console.log(`▸ ${h} min vooruit  (gerangschikt op CSI):`);
  const rows = Object.entries(stats).map(([name, byH]) => {
    const s = byH[h];
    const pod = pct(s.hit, s.hit + s.miss);
    const far = pct(s.fa, s.hit + s.fa);
    const csi = pct(s.hit, s.hit + s.miss + s.fa);
    return { name, pod, far, csi };
  }).sort((a, b) => b.csi - a.csi);
  for (const r of rows)
    console.log(`   CSI ${String(r.csi).padStart(2)}%  trefkans ${String(r.pod).padStart(3)}%  vals-alarm ${String(r.far).padStart(3)}%   ${r.name}`);
  console.log('');
}
console.log('CSI = treffers/(treffers+gemist+vals alarm). Hoger = beter (balanceert beide).');
