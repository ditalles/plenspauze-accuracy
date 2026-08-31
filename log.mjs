/**
 * log.mjs — neemt één momentopname per locatie:
 *   - onze nowcast (Open-Meteo / KNMI seamless), komende ~2 uur per 15 min
 *   - Buienradars officiële nowcast (gpsgadget raintext), komende 2 uur per 5 min
 *   - de officiële KNMI-radar-nowcast op je EXACTE punt (WMS, mm/uur) — bron + meetlat
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

// Open-Meteo per model. 'knmi_seamless' = wat Plenspauze gebruikt;
// 'knmi_harmonie_arome_netherlands' = het rúwe officiële KNMI HARMONIE-model.
async function fetchOpenMeteo(lat, lon, runEpoch, model) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&minutely_15=precipitation,precipitation_probability&models=${model}` +
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

// ── Officiële KNMI-radar-nowcast op punt (WMS GetFeatureInfo, mm/uur) ────────
// Dit is zowel een VOORSPELBRON (0–2 u) als — op mAhead≈0 — de hyperlokale
// GRONDWAARHEID: de officiële radar op je exacte punt i.p.v. een station op 15 km.
const KNMI_WMS = 'https://api.dataplatform.knmi.nl/wms/adaguc-server';
const KNMI_WMS_KEY =
  process.env.KNMI_WMS_KEY ??
  'eyJvcmciOiI1ZTU1NGUxOTI3NGE5NjAwMDEyYTNlYjEiLCJpZCI6ImYxNGU2OTY4MjM4NTQ3ZTc4MTcxZWVkZDhhZTdjODQxIiwiaCI6Im11cm11cjEyOCJ9';

function flattenAdaguc(data) {
  const out = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object') walk(v);
      else {
        const t = Date.parse(k);
        const n = v === 'nodata' || v == null ? NaN : Number(v);
        // Alleen fysisch mogelijke waarden (de forecast-laag geeft soms onzin:
        // negatief, of uitschieters van miljarden mm/u).
        if (Number.isFinite(t) && Number.isFinite(n) && n >= 0 && n <= 200) out.push({ t, mmh: n });
      }
    }
  };
  walk(data);
  return out.sort((a, b) => a.t - b.t);
}

async function fetchKnmiRadar(lat, lon, runEpoch) {
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
  const e = 0.03;
  const latestRun = Math.floor((runEpoch - 5 * 60000) / 300000) * 300000;

  async function q(dataset, layer, from, to, ref) {
    const p = new URLSearchParams({
      DATASET: dataset, SERVICE: 'WMS', VERSION: '1.3.0', REQUEST: 'GetFeatureInfo',
      LAYERS: layer, QUERY_LAYERS: layer, CRS: 'EPSG:4326',
      BBOX: `${lat - e},${lon - e},${lat + e},${lon + e}`,
      WIDTH: '50', HEIGHT: '50', I: '25', J: '25',
      INFO_FORMAT: 'application/json',
      // Eén tijdstip → exacte TIME; anders een bereik (zie fetchKnmiRadar).
      TIME: from === to ? iso(from) : `${iso(from)}/${iso(to)}`,
    });
    if (ref) p.set('DIM_reference_time', iso(ref));
    const r = await fetch(`${KNMI_WMS}?${p}`, { headers: { Authorization: KNMI_WMS_KEY } });
    if (!r.ok) return null;
    const txt = await r.text();
    if (txt.trim().startsWith('<')) return null; // ServiceException
    const j = JSON.parse(txt);
    const L = Array.isArray(j) ? j[0] : null;
    if (!L || !/mm/i.test(L.units ?? '')) return null;
    const pts = flattenAdaguc(L.data);
    return pts.length ? pts : null;
  }

  // Meting: één bevraging over een tijdsbereik werkt hier prima.
  const obs = await q(
    'radar_reflectivity_composites', 'precipitation',
    runEpoch - 15 * 60000, runEpoch + 5 * 60000,
  );

  // Voorspelling: ELK TIJDSTIP APART opvragen.
  //
  // Gemeten 28 aug 2026 (Utrecht, run 13:05, bui van 27 mm/u in aantocht):
  //   met een tijdsbereik  → 48,7 daarna 0,00  0,00  0,00  0,00 …
  //   per tijdstip apart   → 48,7  12,8  8,2  4,6  1,7  0,36  0,12
  // ADAGUC geeft bij een bereik alleen de eerste stap terug en vult de rest met
  // nullen. Daardoor leek de KNMI-nowcast maandenlang onbruikbaar (0% trefkans
  // vanaf +30 min) terwijl het product gewoon werkt. Exacte tijdstippen MOETEN
  // op 5 minuten uitgelijnd zijn, anders volgt InvalidDimensionValue.
  const stappen = [15, 30, 45, 60, 75, 90, 105, 120];
  const fc = [];
  for (const min of stappen) {
    const t = Math.round((runEpoch + min * 60000) / 300000) * 300000;
    const pts = await q('radar_forecast_2.0', 'precipitation_nowcast', t, t, latestRun);
    if (pts?.length) fc.push(pts[0]);
  }

  if (!obs && !fc.length) throw new Error('geen radar-data');
  return [...(obs ?? []), ...fc]
    .sort((a, b) => a.t - b.t)
    .map((p) => ({ mAhead: Math.round((p.t - runEpoch) / 60000), mmh: p.mmh }));
}

// ── Regenmeters van de waterschappen (KNMI Data Platform, CC BY 4.0) ─────────
// 16 waterschappen leveren hun eigen meetnet aan; het gecombineerde bestand
// wordt elke 5 minuten ververst en bevat ~147 meters met coördinaten.
//
// Waarom dit ertoe doet: het dichtstbijzijnde KNMI-station staat gemiddeld
// 8,5 km weg (Westzaan zelfs 14,2 km) en dat gat maakte onze meetlat onbruikbaar
// bij verspreide buien. Met deze meters erbij is dat gemiddeld 4,4 km, en bij
// Westzaan 2,8 km.
//
// LET OP: dit bestand loopt ~31 minuten achter. Daarom slaan we de MEETTIJD op
// en niet alleen de waarde — score.mjs matcht een voorspelling-voor-T met de
// metermeting óp T, ongeacht wanneer wij hem ophaalden.
const KNMI_OPENDATA = 'https://api.dataplatform.knmi.nl/open-data/v1';
const KNMI_OPENDATA_KEY =
  process.env.KNMI_OPENDATA_KEY ??
  'eyJvcmciOiI1ZTU1NGUxOTI3NGE5NjAwMDEyYTNlYjEiLCJpZCI6IjUzYTg1ZDBhMmQ5YzRkYzJiYWNlNzQ4NTQ2Zjk4ODExIiwiaCI6Im11cm11cjEyOCJ9';
const WATERSCHAP_DS = 'waterboard_raingauge_quality_controlled_all_combined';

async function knmiOpenData(pad, params) {
  const q = params ? `?${new URLSearchParams(params)}` : '';
  for (let poging = 0; poging < 5; poging++) {
    const r = await fetch(`${KNMI_OPENDATA}${pad}${q}`, {
      headers: { Authorization: KNMI_OPENDATA_KEY },
    });
    if (r.status === 429) {
      await new Promise((res) => setTimeout(res, 1500 * (poging + 1)));
      continue;
    }
    if (!r.ok) return null;
    return r.json();
  }
  return null;
}

/**
 * FEWS-PI XML uitlezen. Geen XML-parser in Node, maar het bestand is
 * machinaal gegenereerd en volstrekt regelmatig, dus regexen volstaan.
 * De bron bevat een encodingfout (accenten komen kapot binnen); daarom lezen we
 * tolerant in en negeren we onleesbare tekens in de stationsnaam.
 */
function parseRegenmeters(xml) {
  const uit = [];
  for (const blok of xml.split('<series>').slice(1)) {
    const pak = (tag) => blok.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1];
    const lat = Number(pak('lat'));
    const lon = Number(pak('lon'));
    const stap = Number(blok.match(/<timeStep[^>]*multiplier="(\d+)"/)?.[1]);
    const ev = blok.match(/<event date="([^"]+)" time="([^"]+)" value="([^"]+)"(?: flag="([^"]+)")?/);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !ev) continue;
    const mm = Number(ev[3]);
    const vlag = ev[4] ?? '000000';
    // Vlag 50 = meter of radar leverde niets. Zulke punten weglaten: een
    // ontbrekende meting mag nooit als "droog" meetellen.
    if (!Number.isFinite(mm) || vlag.includes('50')) continue;
    uit.push({
      naam: (pak('stationName') ?? '').replace(/[^\x20-\x7e\u00c0-\u017f]/g, '').trim(),
      lat,
      lon,
      mm,
      // timeZone in het bestand is 0.0 → UTC.
      tijd: `${ev[1]}T${ev[2]}Z`,
      // 5-minuutssom → mm/uur, zodat het vergelijkbaar is met alle andere bronnen.
      mmh: Math.round((mm * (3600 / (stap || 300))) * 100) / 100,
    });
  }
  return uit;
}

async function fetchRegenmeters() {
  const lijst = await knmiOpenData(`/datasets/${WATERSCHAP_DS}/versions/1.0/files`, {
    maxKeys: '1',
    orderBy: 'created',
    sorting: 'desc',
  });
  const naam = lijst?.files?.[0]?.filename;
  if (!naam) return [];
  const link = await knmiOpenData(
    `/datasets/${WATERSCHAP_DS}/versions/1.0/files/${naam}/url`,
  );
  if (!link?.temporaryDownloadUrl) return [];
  const r = await fetch(link.temporaryDownloadUrl);
  if (!r.ok) return [];
  return parseRegenmeters(await r.text());
}

function nearestMeter(meters, lat, lon) {
  let best = null;
  let bestD = Infinity;
  for (const m of meters) {
    const d = Math.hypot((m.lat - lat) * 111, (m.lon - lon) * 68);
    if (d < bestD) {
      bestD = d;
      best = m;
    }
  }
  if (!best) return null;
  return {
    naam: best.naam,
    afstandKm: Math.round(bestD * 10) / 10,
    mm: best.mm,
    mmh: best.mmh,
    tijd: best.tijd,
  };
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

let meters = [];
try {
  meters = await fetchRegenmeters();
  console.log(`${meters.length} waterschaps-regenmeters opgehaald`);
} catch (e) {
  console.error('Regenmeters mislukt:', e.message);
}

const records = [];
for (const loc of locations) {
  try {
    const [ours, knmi, buienradar, knmiradar] = await Promise.all([
      fetchOpenMeteo(loc.lat, loc.lon, runEpoch, 'knmi_seamless'),
      fetchOpenMeteo(loc.lat, loc.lon, runEpoch, 'knmi_harmonie_arome_netherlands'),
      fetchBuienradar(loc.lat, loc.lon, runEpoch),
      fetchKnmiRadar(loc.lat, loc.lon, runEpoch).catch((e) => {
        console.error(`  KNMI-radar ${loc.naam}: ${e.message}`);
        return null;
      }),
    ]);
    const station = stations.length ? nearestStation(stations, loc.lat, loc.lon) : null;
    const waterschap = meters.length ? nearestMeter(meters, loc.lat, loc.lon) : null;
    records.push({
      ts: runIso,
      epoch: runEpoch,
      loc: loc.naam,
      lat: loc.lat,
      lon: loc.lon,
      station,
      waterschap,
      ours,
      knmi,
      buienradar,
      knmiradar,
    });
    const wet = (arr) => arr.some((p) => p.mAhead >= 0 && p.mAhead <= 120 && p.mmh >= WET_MMH);
    console.log(
      `${loc.naam.padEnd(11)} nu:${station?.regenNu ?? '?'}mm/u ` +
      `(meter ${waterschap ? `${waterschap.mmh}mm/u @${waterschap.afstandKm}km` : '—'})  ` +
      `Plenspauze:${wet(ours) ? 'REGEN' : 'droog'}  KNMI:${wet(knmi) ? 'REGEN' : 'droog'}  ` +
      `Buienradar:${wet(buienradar) ? 'REGEN' : 'droog'}  KNMIradar:${knmiradar ? (wet(knmiradar) ? 'REGEN' : 'droog') : '?'}`,
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
