/**
 * log.mjs — neemt één momentopname per locatie:
 *   - onze nowcast (Open-Meteo / KNMI seamless), komende ~2 uur per 15 min
 *   - Buienradars officiële nowcast (gpsgadget raintext), komende 2 uur per 5 min
 *   - de échte meting NU bij het dichtstbijzijnde KNMI-station (grondwaarheid)
 *
 * Schrijft één NDJSON-regel per locatie naar data/JJJJ-MM-DD.ndjson.
 * Elke voorspelpunt krijgt `mAhead` (minuten vooruit t.o.v. de opname) zodat
 * score.mjs een voorspelling-voor-tijd-T kan matchen met de meting-op-T.
 */
import { readFile, mkdir, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const WET_MMH = 0.1; // drempel "het regent" in mm/uur

// ── Bron-helpers ─────────────────────────────────────────────────────────────
function buienradarToMmh(waarde) {
  const v = Number(waarde);
  if (!Number.isFinite(v) || v <= 0) return 0;
  const mmh = Math.pow(10, (v - 109) / 32);
  return mmh < 0.05 ? 0 : Math.round(mmh * 100) / 100;
}

// Amsterdam minuten-van-de-dag, voor het omzetten van Buienradars HH:MM.
function amsMinutesOfDay(d) {
  const s = d.toLocaleString('en-GB', {
    timeZone: 'Europe/Amsterdam',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

async function fetchBuienradar(lat, lon, runEpoch) {
  const r = await fetch(`https://gpsgadget.buienradar.nl/data/raintext?lat=${lat}&lon=${lon}`);
  const txt = await r.text();
  const nowMin = amsMinutesOfDay(new Date(runEpoch));
  return txt.trim().split('\n').map((line) => {
    const [w, t] = line.split('|');
    const [hh, mm] = t.trim().split(':').map(Number);
    let ahead = hh * 60 + mm - nowMin;
    if (ahead < -120) ahead += 1440; // over middernacht
    return { mAhead: ahead, mmh: buienradarToMmh(w) };
  });
}

async function fetchOurs(lat, lon, runEpoch) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&minutely_15=precipitation,precipitation_probability&models=knmi_seamless` +
    `&timezone=Europe%2FAmsterdam&forecast_minutely_15=10`;
  const r = await fetch(url);
  const j = await r.json();
  const off = (j.utc_offset_seconds ?? 0) * 1000;
  const { time, precipitation, precipitation_probability } = j.minutely_15;
  return time.map((iso, i) => {
    const epoch = Date.parse(`${iso}:00Z`) - off;
    return {
      mAhead: Math.round((epoch - runEpoch) / 60000),
      mmh: Math.round((precipitation[i] ?? 0) * 4 * 100) / 100, // mm/15min -> mm/u
      prob: precipitation_probability[i] ?? 0,
    };
  });
}

async function fetchStations() {
  const r = await fetch('https://data.buienradar.nl/2.0/feed/json');
  const j = await r.json();
  return j.actual.stationmeasurements.filter((s) => s.lat != null && s.lon != null);
}

function nearestStation(stations, lat, lon) {
  let best = null, bestD = Infinity;
  for (const s of stations) {
    const d = Math.hypot((s.lat - lat) * 111, (s.lon - lon) * 70);
    if (d < bestD) { bestD = d; best = s; }
  }
  if (!best) return null;
  return {
    naam: best.stationname,
    afstandKm: Math.round(bestD * 10) / 10,
    regenNu: best.precipitation ?? null, // mm/u, échte meting
  };
}

// ── Hoofdlus ─────────────────────────────────────────────────────────────────
const locations = JSON.parse(await readFile(join(ROOT, 'locations.json'), 'utf8'));
const runEpoch = Date.now();
const runIso = new Date(runEpoch).toISOString();

let stations = [];
try {
  stations = await fetchStations();
} catch (e) {
  console.error('Stationfeed mislukt:', e.message);
}

const records = [];
for (const loc of locations) {
  try {
    const [ours, buienradar] = await Promise.all([
      fetchOurs(loc.lat, loc.lon, runEpoch),
      fetchBuienradar(loc.lat, loc.lon, runEpoch),
    ]);
    const station = stations.length ? nearestStation(stations, loc.lat, loc.lon) : null;
    records.push({
      ts: runIso,
      epoch: runEpoch,
      loc: loc.naam,
      lat: loc.lat,
      lon: loc.lon,
      station,
      ours,
      buienradar,
    });
    const wetOurs = ours.some((p) => p.mAhead >= 0 && p.mAhead <= 120 && p.mmh >= WET_MMH);
    const wetBr = buienradar.some((p) => p.mAhead >= 0 && p.mAhead <= 120 && p.mmh >= WET_MMH);
    console.log(
      `${loc.naam.padEnd(11)} nu:${station?.regenNu ?? '?'}mm/u  ` +
      `onze 2u:${wetOurs ? 'REGEN' : 'droog'}  buienradar 2u:${wetBr ? 'REGEN' : 'droog'}`,
    );
  } catch (e) {
    console.error(`${loc.naam}: mislukt — ${e.message}`);
  }
}

// Wegschrijven: één bestand per dag (Amsterdam-datum).
const dag = new Date(runEpoch).toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });
const outDir = join(ROOT, 'data');
await mkdir(outDir, { recursive: true });
const outFile = join(outDir, `${dag}.ndjson`);
await appendFile(outFile, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(`\n${records.length} records → data/${dag}.ndjson`);
