/**
 * route.mjs — "Word ik nat op mijn route?"
 *
 * Het verschil met elke andere weer-app: die beantwoordt "regent het HIER".
 * Dit beantwoordt ruimte × tijd tegelijk — jij beweegt over de route, de bui
 * beweegt ook. Per routepunt vragen we de KNMI-radar-nowcast op het moment dat
 * JIJ daar bent.
 *
 * Gebruik:
 *   node route.mjs "Westzaan" "Amsterdam" [snelheid-kmh] [vertrek-ISO]
 *   node route.mjs 52.458,4.797 52.37,4.90 18
 */
const WMS = 'https://api.dataplatform.knmi.nl/wms/adaguc-server';
const WMS_KEY =
  process.env.KNMI_WMS_KEY ??
  'eyJvcmciOiI1ZTU1NGUxOTI3NGE5NjAwMDEyYTNlYjEiLCJpZCI6ImYxNGU2OTY4MjM4NTQ3ZTc4MTcxZWVkZDhhZTdjODQxIiwiaCI6Im11cm11cjEyOCJ9';
const WET = 0.1; // mm/u = "het regent"
// Toekomst = nowcast; verleden (validatie) = observatie-radar.
const PAST = !!process.env.PAST;
const DS = PAST ? 'radar_reflectivity_composites' : 'radar_forecast_2.0';
const LAYER = PAST ? 'precipitation' : 'precipitation_nowcast';

const [, , FROM = 'Westzaan', TO = 'Amsterdam', SPEED = '18', DEPART] = process.argv;
const speedKmh = Number(SPEED);
const departMs = DEPART ? Date.parse(DEPART) : Date.now();

// ── Geocoderen (accepteert ook "lat,lon") ────────────────────────────────────
async function geocode(q) {
  const m = q.match(/^\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*$/);
  if (m) return { naam: q, lat: +m[1], lon: +m[2] };
  const u = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=nl&q=${encodeURIComponent(q)}`;
  const r = await fetch(u, { headers: { 'User-Agent': 'Plenspauze/route-prototype' } });
  const j = await r.json();
  if (!j.length) throw new Error(`"${q}" niet gevonden`);
  return { naam: j[0].display_name.split(',')[0], lat: +j[0].lat, lon: +j[0].lon };
}

// ── Route: echte fietsroute via OSRM; anders rechte lijn ─────────────────────
async function route(a, b) {
  try {
    const u = `https://router.project-osrm.org/route/v1/bike/${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson`;
    const j = await (await fetch(u)).json();
    const c = j.routes?.[0]?.geometry?.coordinates;
    if (c?.length) {
      return { coords: c.map(([lon, lat]) => ({ lat, lon })), km: j.routes[0].distance / 1000, bron: 'OSRM' };
    }
  } catch {}
  // Terugval: rechte lijn (MVP — bewijst het idee ook).
  const n = 12;
  const coords = Array.from({ length: n + 1 }, (_, i) => ({
    lat: a.lat + ((b.lat - a.lat) * i) / n,
    lon: a.lon + ((b.lon - a.lon) * i) / n,
  }));
  const km = haversine(a, b);
  return { coords, km, bron: 'rechte lijn' };
}

function haversine(a, b) {
  const R = 6371, t = (d) => (d * Math.PI) / 180;
  const dLa = t(b.lat - a.lat), dLo = t(b.lon - a.lon);
  const x = Math.sin(dLa / 2) ** 2 + Math.cos(t(a.lat)) * Math.cos(t(b.lat)) * Math.sin(dLo / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

/** Verdeel de route in N stops met hun aankomsttijd. */
function stops(coords, km, n = 8) {
  const totalMin = (km / speedKmh) * 60;
  return Array.from({ length: n + 1 }, (_, i) => {
    const f = i / n;
    const c = coords[Math.min(Math.round(f * (coords.length - 1)), coords.length - 1)];
    return { ...c, min: (totalMin * f), at: departMs + totalMin * f * 60000 };
  });
}

// ── KNMI-radar op één punt, op één moment ────────────────────────────────────
function flat(data) {
  const out = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object') walk(v);
      else {
        const t = Date.parse(k), n = v === 'nodata' || v == null ? 0 : Number(v);
        if (Number.isFinite(t) && Number.isFinite(n)) out.push({ t, mmh: n });
      }
    }
  };
  walk(data);
  return out;
}

async function rainAt(lat, lon, whenMs) {
  const e = 0.03;
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
  const q = new URLSearchParams({
    DATASET: DS, SERVICE: 'WMS', VERSION: '1.3.0',
    REQUEST: 'GetFeatureInfo', LAYERS: LAYER, QUERY_LAYERS: LAYER, CRS: 'EPSG:4326', // lat,lon!
    BBOX: `${lat - e},${lon - e},${lat + e},${lon + e}`,
    WIDTH: '50', HEIGHT: '50', I: '25', J: '25',
    INFO_FORMAT: 'application/json',
    TIME: `${iso(whenMs - 5 * 60000)}/${iso(whenMs + 5 * 60000)}`,
  });
  const r = await fetch(`${WMS}?${q}`, { headers: { Authorization: WMS_KEY } });
  if (!r.ok) return null;
  const j = await r.json();
  const pts = flat(j[0]?.data);
  if (!pts.length) return null; // geen data — NIET als droog rapporteren
  // Waarde het dichtst bij het aankomstmoment.
  return pts.reduce((best, p) =>
    Math.abs(p.t - whenMs) < Math.abs(best.t - whenMs) ? p : best, pts[0]).mmh;
}

// ── Hoofdprogramma ───────────────────────────────────────────────────────────
const klok = (ms) => new Date(ms).toLocaleTimeString('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit' });

const a = await geocode(FROM), b = await geocode(TO);
const { coords, km, bron } = await route(a, b);
const pts = stops(coords, km);
const duurMin = Math.round((km / speedKmh) * 60);

console.log(`\n🚲 ${a.naam} → ${b.naam}   ${km.toFixed(1)} km · ${duurMin} min · ${speedKmh} km/u  (${bron})`);
console.log(`   vertrek ${klok(departMs)} · aankomst ${klok(departMs + duurMin * 60000)}\n`);

const rows = [];
for (const p of pts) {
  const mmh = await rainAt(p.lat, p.lon, p.at);
  rows.push({ ...p, mmh, geen: mmh === null });
}

let natMin = 0;
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const nat = r.mmh != null && r.mmh >= WET;
  if (nat) natMin += duurMin / (rows.length - 1);
  const bar = r.mmh != null && r.mmh > 0 ? '█'.repeat(Math.min(12, Math.max(1, Math.round(r.mmh * 3)))) : '·';
  console.log(
    `   ${klok(r.at)}  +${String(Math.round(r.min)).padStart(2)}min  ` +
    `${r.lat.toFixed(3)},${r.lon.toFixed(3)}  ${nat ? '🌧' : '  '} ${r.mmh == null ? '   ?' : r.mmh.toFixed(1).padStart(4)} mm/u ${bar}`,
  );
}

console.log('');
if (natMin === 0) {
  console.log(`   ✅ DROOG op de hele route — geen jas nodig.`);
} else {
  const eerste = rows.find((r) => r.mmh != null && r.mmh >= WET);
  console.log(`   ☔ ~${Math.round(natMin)} min in de regen · eerste bui om ${klok(eerste.at)} (${eerste.mmh.toFixed(1)} mm/u)`);
}
console.log('');
